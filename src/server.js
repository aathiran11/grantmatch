process.removeAllListeners('warning');
const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const multer = require('multer');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const { db, initSchema } = require('./db');
const { evaluateScheme, evaluateAllSchemes } = require('./eligibilityEngine');
const { requireLogin, requireRole, attachUser, csrfToken, verifyCsrf } = require('./middleware');

const app = express();
const PORT = process.env.PORT || 3000;
const IS_PROD = process.env.NODE_ENV === 'production';

const DEFAULT_SECRET = 'grantmatch-dev-secret-change-in-production';
const SESSION_SECRET = process.env.SESSION_SECRET || DEFAULT_SECRET;
if (SESSION_SECRET === DEFAULT_SECRET) {
  console.warn('\n  WARNING: SESSION_SECRET is not set — using the default dev value.');
  console.warn('  Set a long random SESSION_SECRET in .env before any real deployment.\n');
}

// Wrap async route handlers so rejected promises reach Express's error handler
// instead of crashing the process or hanging the request.
const ah = (fn) => (req, res, next) => fn(req, res, next).catch(next);

// ---------- Setup ----------
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));
app.set('trust proxy', 1); // needed for secure cookies to work correctly behind a reverse proxy (e.g. nginx, a cloud load balancer)

// Security headers. CSP is intentionally permissive on style-src/font-src
// (inline styles and Google Fonts are used throughout the views) but locks
// down script-src to same-origin only, which is the main XSS mitigation.
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"]
    }
  }
}));

app.use(express.urlencoded({ extended: true, limit: '200kb' }));
app.use(express.json({ limit: '200kb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// Uploaded documents are served with a forced download rather than inline
// rendering. Without this, an uploaded HTML or SVG file could execute script
// in the browser of anyone who opens it (stored XSS) — forcing a download
// neutralizes that regardless of what the file actually contains.
app.use('/uploads', express.static(path.join(__dirname, '..', 'uploads'), {
  setHeaders: (res) => res.setHeader('Content-Disposition', 'attachment')
}));

app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 1000 * 60 * 60 * 8,
    httpOnly: true,
    sameSite: 'lax',
    secure: IS_PROD // only send the session cookie over HTTPS once actually deployed
  }
}));
app.use(attachUser);
app.use(csrfToken);

// Rate limit auth endpoints specifically — these are the most valuable targets
// for brute-force / credential-stuffing and the cheapest to protect.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Too many attempts from this device. Please wait a few minutes and try again.'
});

// A lighter general limiter across the rest of the app, mainly to blunt
// scripted abuse rather than to constrain normal use.
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 600,
  standardHeaders: true,
  legacyHeaders: false
});
app.use(generalLimiter);

app.use((req, res, next) => {
  // Multipart (file upload) requests haven't been parsed into req.body yet at
  // this point — multer runs later, per-route. Those routes call verifyCsrf
  // explicitly themselves, after their upload.single(...) middleware.
  if (req.is('multipart/form-data')) return next();
  return verifyCsrf(req, res, next);
});

// File upload setup
const uploadDir = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, unique + ext);
  }
});
// Only accept file types that make sense for identity/income/land documents.
// This blocks executables, scripts, and HTML uploads outright — even though
// the Content-Disposition header above also prevents them from running in a
// browser, restricting the accepted types is a second layer of defense.
const ALLOWED_UPLOAD_EXT = new Set(['.pdf', '.jpg', '.jpeg', '.png', '.webp']);
function uploadFileFilter(req, file, cb) {
  const ext = path.extname(file.originalname).toLowerCase();
  if (!ALLOWED_UPLOAD_EXT.has(ext)) {
    return cb(new Error('Only PDF, JPG, PNG, or WEBP files are allowed.'));
  }
  cb(null, true);
}
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 }, fileFilter: uploadFileFilter });

function genAppCode() {
  const year = new Date().getFullYear();
  const rand = Math.floor(100000 + Math.random() * 900000);
  return `GM-${year}-${rand}`;
}

async function addHistory(applicationId, status, changedBy, remarks) {
  await db.prepare('INSERT INTO application_history (application_id, status, changed_by, remarks) VALUES (?,?,?,?)')
    .run(applicationId, status, changedBy, remarks || null);
}

async function addNotification(userId, title, message) {
  await db.prepare('INSERT INTO notifications (user_id, title, message) VALUES (?,?,?)').run(userId, title, message);
}

// Auto-expire schemes whose end_date has passed. Runs at startup and hourly,
// so admins never have to manually flip a scheme to Expired.
async function autoExpireSchemes() {
  const today = new Date().toISOString().slice(0, 10);
  await db.prepare(`UPDATE schemes SET status='Expired' WHERE status='Active' AND end_date IS NOT NULL AND end_date != '' AND end_date < ?`)
    .run(today);
}

// ================= PUBLIC ROUTES =================

app.get('/', ah(async (req, res) => {
  const schemeCount = (await db.prepare("SELECT COUNT(*) c FROM schemes WHERE status='Active'").get()).c;
  const userCount = (await db.prepare("SELECT COUNT(*) c FROM users WHERE role='USER'").get()).c;
  const appCount = (await db.prepare("SELECT COUNT(*) c FROM applications").get()).c;
  res.render('home', { schemeCount, userCount, appCount });
}));

app.get('/register', (req, res) => res.render('register', { error: null }));

app.post('/register', authLimiter, ah(async (req, res) => {
  const { name, email, phone, password, role, organization_name } = req.body;
  try {
    const allowedRoles = ['USER', 'VOLUNTEER', 'NGO'];
    const finalRole = allowedRoles.includes(role) ? role : 'USER';
    const hash = bcrypt.hashSync(password, 10);
    const info = await db.prepare('INSERT INTO users (name, email, phone, password_hash, role, organization_name) VALUES (?,?,?,?,?,?)')
      .run(name, email, phone || null, hash, finalRole, organization_name || null);
    if (finalRole === 'USER') {
      await db.prepare('INSERT INTO user_profiles (user_id) VALUES (?)').run(info.lastInsertRowid);
    }
    req.session.user = { id: info.lastInsertRowid, name, email, role: finalRole };
    await addNotification(info.lastInsertRowid, 'Welcome to GrantMatch', 'Your account has been created. Complete your profile to get personalized scheme matches.');
    res.redirect(finalRole === 'USER' ? '/profile' : '/dashboard');
  } catch (e) {
    const isDup = /unique/i.test(e.message) || e.code === '23505';
    res.render('register', { error: isDup ? 'Email already registered.' : 'Registration failed: ' + e.message });
  }
}));

app.get('/login', (req, res) => res.render('login', { error: null }));

app.post('/login', authLimiter, ah(async (req, res) => {
  const { email, password } = req.body;
  const u = await db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!u || !bcrypt.compareSync(password, u.password_hash)) {
    return res.render('login', { error: 'Invalid email or password.' });
  }
  req.session.user = { id: u.id, name: u.name, email: u.email, role: u.role };
  res.redirect('/dashboard');
}));

app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

// ================= DASHBOARD (role router) =================
app.get('/dashboard', requireLogin, (req, res) => {
  const role = req.session.user.role;
  if (role === 'ADMIN') return res.redirect('/admin');
  if (role === 'NGO' || role === 'VOLUNTEER') return res.redirect('/ngo');
  return res.redirect('/schemes/discover');
});

// ================= CITIZEN: PROFILE =================
app.get('/profile', requireLogin, requireRole('USER'), ah(async (req, res) => {
  const profile = await db.prepare('SELECT * FROM user_profiles WHERE user_id = ?').get(req.session.user.id);
  res.render('profile', { profile: profile || {}, saved: req.query.saved });
}));

app.post('/profile', requireLogin, requireRole('USER'), ah(async (req, res) => {
  const { date_of_birth, gender, state, district, occupation, annual_income, education, category, disability_status, family_members, land_owner } = req.body;
  const exists = await db.prepare('SELECT user_id FROM user_profiles WHERE user_id = ?').get(req.session.user.id);
  if (exists) {
    await db.prepare(`UPDATE user_profiles SET date_of_birth=?, gender=?, state=?, district=?, occupation=?, annual_income=?, education=?, category=?, disability_status=?, family_members=?, land_owner=?, updated_at=NOW() WHERE user_id=?`)
      .run(date_of_birth, gender, state, district, occupation, annual_income || null, education, category, disability_status, family_members || null, land_owner, req.session.user.id);
  } else {
    await db.prepare(`INSERT INTO user_profiles (user_id, date_of_birth, gender, state, district, occupation, annual_income, education, category, disability_status, family_members, land_owner) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(req.session.user.id, date_of_birth, gender, state, district, occupation, annual_income || null, education, category, disability_status, family_members || null, land_owner);
  }
  res.redirect(req.query.redirect === 'discover' ? '/schemes/discover' : '/profile?saved=1');
}));

// ================= CITIZEN: SCHEME DISCOVERY =================
app.get('/schemes/discover', requireLogin, requireRole('USER'), ah(async (req, res) => {
  const profile = await db.prepare('SELECT * FROM user_profiles WHERE user_id = ?').get(req.session.user.id);
  const filters = { search: req.query.search, state: req.query.state, category: req.query.category };
  const hasProfile = profile && profile.date_of_birth;
  const results = await evaluateAllSchemes(profile || {}, filters);
  res.render('discover', { results, filters, hasProfile });
}));

app.get('/schemes/:id', requireLogin, ah(async (req, res) => {
  const scheme = await db.prepare('SELECT * FROM schemes WHERE id = ?').get(req.params.id);
  if (!scheme) return res.status(404).render('error', { message: 'Scheme not found', user: req.session.user });
  const docs = await db.prepare('SELECT * FROM scheme_documents WHERE scheme_id = ?').all(req.params.id);

  let evalResult = null;
  if (req.session.user.role === 'USER') {
    const profile = await db.prepare('SELECT * FROM user_profiles WHERE user_id = ?').get(req.session.user.id);
    evalResult = await evaluateScheme(scheme.id, profile || {});
  }
  const existingApp = req.session.user.role === 'USER'
    ? await db.prepare('SELECT * FROM applications WHERE user_id=? AND scheme_id=?').get(req.session.user.id, scheme.id)
    : null;

  res.render('scheme_detail', { scheme, docs, evalResult, existingApp });
}));

// ================= CITIZEN: APPLICATION =================
app.post('/schemes/:id/apply', requireLogin, requireRole('USER'), ah(async (req, res) => {
  const scheme = await db.prepare('SELECT * FROM schemes WHERE id = ?').get(req.params.id);
  if (!scheme) return res.status(404).render('error', { message: 'Scheme not found', user: req.session.user });

  const existing = await db.prepare('SELECT * FROM applications WHERE user_id=? AND scheme_id=?').get(req.session.user.id, scheme.id);
  if (existing) return res.redirect('/applications/' + existing.id);

  const profile = await db.prepare('SELECT * FROM user_profiles WHERE user_id = ?').get(req.session.user.id);
  const evalResult = await evaluateScheme(scheme.id, profile || {});

  const code = genAppCode();
  const info = await db.prepare(`INSERT INTO applications (application_code, user_id, scheme_id, status, eligibility_snapshot, submitted_at) VALUES (?,?,?,?,?,NOW())`)
    .run(code, req.session.user.id, scheme.id, 'Submitted', JSON.stringify(evalResult));

  // pre-populate required documents as pending
  const reqDocs = await db.prepare('SELECT * FROM scheme_documents WHERE scheme_id = ?').all(scheme.id);
  for (const d of reqDocs) {
    await db.prepare('INSERT INTO application_documents (application_id, document_name) VALUES (?,?)').run(info.lastInsertRowid, d.document_name);
  }

  await addHistory(info.lastInsertRowid, 'Submitted', req.session.user.id, 'Application submitted by citizen.');
  await addNotification(req.session.user.id, 'Application Submitted ✓', `Your application ${code} for "${scheme.name}" has been submitted.`);

  res.redirect('/applications/' + info.lastInsertRowid);
}));

app.get('/applications', requireLogin, requireRole('USER'), ah(async (req, res) => {
  const apps = await db.prepare(`
    SELECT a.*, s.name as scheme_name FROM applications a
    JOIN schemes s ON s.id = a.scheme_id
    WHERE a.user_id = ? ORDER BY a.created_at DESC
  `).all(req.session.user.id);
  res.render('my_applications', { apps });
}));

app.get('/applications/:id', requireLogin, ah(async (req, res) => {
  const application = await db.prepare(`
    SELECT a.*, s.name as scheme_name, s.department, u.name as applicant_name, u.email as applicant_email,
           v.name as assister_name, v.role as assister_role
    FROM applications a
    JOIN schemes s ON s.id = a.scheme_id
    JOIN users u ON u.id = a.user_id
    LEFT JOIN users v ON v.id = a.assisted_by
    WHERE a.id = ?
  `).get(req.params.id);
  if (!application) return res.status(404).render('error', { message: 'Application not found', user: req.session.user });

  // access control
  const role = req.session.user.role;
  if (role === 'USER' && application.user_id !== req.session.user.id) {
    return res.status(403).render('error', { message: 'Access denied.', user: req.session.user });
  }

  const docs = await db.prepare('SELECT * FROM application_documents WHERE application_id = ?').all(req.params.id);
  const history = await db.prepare('SELECT h.*, u.name as changed_by_name FROM application_history h LEFT JOIN users u ON u.id = h.changed_by WHERE application_id = ? ORDER BY changed_at ASC').all(req.params.id);
  const volunteers = (role === 'ADMIN') ? await db.prepare("SELECT id, name, role FROM users WHERE role IN ('NGO','VOLUNTEER')").all() : [];

  let evalSnapshot = null;
  try { evalSnapshot = application.eligibility_snapshot ? JSON.parse(application.eligibility_snapshot) : null; } catch (e) {}

  res.render('application_detail', { application, docs, history, volunteers, evalSnapshot });
}));

app.post('/applications/:id/upload', requireLogin, upload.single('document_file'), verifyCsrf, ah(async (req, res) => {
  const application = await db.prepare('SELECT * FROM applications WHERE id = ?').get(req.params.id);
  if (!application) return res.status(404).send('Not found');

  const uid = req.session.user.id;
  const isOwner = application.user_id === uid;
  const isAssistingVolunteer = application.assisted_by === uid;
  if (!isOwner && !isAssistingVolunteer) return res.status(403).send('Access denied');

  const { document_name, doc_id } = req.body;
  if (doc_id) {
    await db.prepare("UPDATE application_documents SET file_path=?, verification_status=?, uploaded_at=NOW() WHERE id=?")
      .run(req.file ? '/uploads/' + req.file.filename : null, 'Pending', doc_id);
  } else {
    await db.prepare('INSERT INTO application_documents (application_id, document_name, file_path, verification_status) VALUES (?,?,?,?)')
      .run(req.params.id, document_name || 'Additional Document', req.file ? '/uploads/' + req.file.filename : null, 'Pending');
  }

  if (application.status === 'Submitted') {
    await db.prepare("UPDATE applications SET status='Document Verification' WHERE id=?").run(req.params.id);
    await addHistory(req.params.id, 'Document Verification', req.session.user.id, 'Document(s) uploaded, awaiting verification.');
  }

  res.redirect('/applications/' + req.params.id);
}));

// ================= NGO / VOLUNTEER MODULE =================
app.get('/ngo', requireLogin, requireRole('NGO', 'VOLUNTEER'), ah(async (req, res) => {
  const assigned = await db.prepare(`
    SELECT a.*, s.name as scheme_name, u.name as applicant_name FROM applications a
    JOIN schemes s ON s.id = a.scheme_id
    JOIN users u ON u.id = a.user_id
    WHERE a.assigned_to = ?
    ORDER BY a.created_at DESC
  `).all(req.session.user.id);

  const unassigned = await db.prepare(`
    SELECT a.*, s.name as scheme_name, u.name as applicant_name FROM applications a
    JOIN schemes s ON s.id = a.scheme_id
    JOIN users u ON u.id = a.user_id
    WHERE a.assigned_to IS NULL AND a.status IN ('Submitted','Document Verification')
    ORDER BY a.created_at DESC
  `).all();

  const stats = {
    assigned: assigned.length,
    pending: assigned.filter(a => ['Submitted', 'Document Verification'].includes(a.status)).length,
    completed: assigned.filter(a => ['Approved', 'Rejected', 'Verified', 'Forwarded'].includes(a.status)).length
  };

  res.render('ngo_dashboard', { assigned, unassigned, stats });
}));

app.post('/ngo/applications/:id/claim', requireLogin, requireRole('NGO', 'VOLUNTEER'), ah(async (req, res) => {
  await db.prepare('UPDATE applications SET assigned_to = ? WHERE id = ?').run(req.session.user.id, req.params.id);
  await addHistory(req.params.id, 'Assigned', req.session.user.id, `Claimed by ${req.session.user.name} for verification.`);
  res.redirect('/applications/' + req.params.id);
}));

// --- Assisted applications: NGO/Volunteer applies on behalf of a citizen who can't self-serve ---
app.get('/ngo/assist', requireLogin, requireRole('NGO', 'VOLUNTEER'), ah(async (req, res) => {
  const q = req.query.q;
  let citizens = [];
  if (q && q.trim()) {
    citizens = await db.prepare(`SELECT id, name, email, phone FROM users WHERE role='USER' AND (name ILIKE ? OR email ILIKE ? OR phone ILIKE ?) LIMIT 20`)
      .all(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  res.render('ngo_assist_search', { q, citizens });
}));

app.get('/ngo/assist/:userId', requireLogin, requireRole('NGO', 'VOLUNTEER'), ah(async (req, res) => {
  const citizen = await db.prepare("SELECT * FROM users WHERE id=? AND role='USER'").get(req.params.userId);
  if (!citizen) return res.status(404).render('error', { message: 'Citizen not found', user: req.session.user });
  const profile = await db.prepare('SELECT * FROM user_profiles WHERE user_id = ?').get(citizen.id);
  const hasProfile = profile && profile.date_of_birth;
  const results = hasProfile ? await evaluateAllSchemes(profile) : [];
  const existingApps = await db.prepare(`
    SELECT a.*, s.name as scheme_name FROM applications a JOIN schemes s ON s.id=a.scheme_id WHERE a.user_id=?
  `).all(citizen.id);
  const appliedSchemeIds = new Set(existingApps.map(a => a.scheme_id));
  res.render('ngo_assist_profile', { citizen, profile, hasProfile, results, existingApps, appliedSchemeIds });
}));

app.post('/ngo/assist/:userId/apply/:schemeId', requireLogin, requireRole('NGO', 'VOLUNTEER'), ah(async (req, res) => {
  const citizen = await db.prepare("SELECT * FROM users WHERE id=? AND role='USER'").get(req.params.userId);
  const scheme = await db.prepare('SELECT * FROM schemes WHERE id=?').get(req.params.schemeId);
  if (!citizen || !scheme) return res.status(404).render('error', { message: 'Not found', user: req.session.user });

  const existing = await db.prepare('SELECT * FROM applications WHERE user_id=? AND scheme_id=?').get(citizen.id, scheme.id);
  if (existing) return res.redirect('/applications/' + existing.id);

  const profile = await db.prepare('SELECT * FROM user_profiles WHERE user_id = ?').get(citizen.id);
  const evalResult = await evaluateScheme(scheme.id, profile || {});

  const code = genAppCode();
  const info = await db.prepare(`INSERT INTO applications (application_code, user_id, scheme_id, status, assisted_by, assigned_to, eligibility_snapshot, submitted_at) VALUES (?,?,?,?,?,?,?,NOW())`)
    .run(code, citizen.id, scheme.id, 'Submitted', req.session.user.id, req.session.user.id, JSON.stringify(evalResult));

  const reqDocs = await db.prepare('SELECT * FROM scheme_documents WHERE scheme_id = ?').all(scheme.id);
  for (const d of reqDocs) {
    await db.prepare('INSERT INTO application_documents (application_id, document_name) VALUES (?,?)').run(info.lastInsertRowid, d.document_name);
  }

  await addHistory(info.lastInsertRowid, 'Submitted', req.session.user.id, `Application submitted by ${req.session.user.name} (${req.session.user.role}) on behalf of ${citizen.name}.`);
  await addNotification(citizen.id, 'Application Submitted On Your Behalf ✓', `${req.session.user.name} submitted application ${code} for "${scheme.name}" on your behalf.`);

  res.redirect('/applications/' + info.lastInsertRowid);
}));

app.post('/ngo/documents/:docId/verify', requireLogin, requireRole('NGO', 'VOLUNTEER', 'ADMIN'), ah(async (req, res) => {
  const { status, remarks, application_id } = req.body;
  const allowed = ['Verified', 'Rejected', 'Needs Resubmission'];
  if (!allowed.includes(status)) return res.status(400).send('Invalid status');

  await db.prepare('UPDATE application_documents SET verification_status=?, verified_by=?, remarks=? WHERE id=?')
    .run(status, req.session.user.id, remarks || null, req.params.docId);

  // If all required docs verified, move application forward
  const app_ = await db.prepare('SELECT * FROM applications WHERE id = ?').get(application_id);
  const allDocs = await db.prepare('SELECT * FROM application_documents WHERE application_id = ?').all(application_id);
  const allVerified = allDocs.length > 0 && allDocs.every(d => d.verification_status === 'Verified');
  const anyRejected = allDocs.some(d => d.verification_status === 'Rejected');

  if (allVerified && app_.status !== 'Verified' && app_.status !== 'Approved') {
    await db.prepare("UPDATE applications SET status='Verified' WHERE id=?").run(application_id);
    await addHistory(application_id, 'Verified', req.session.user.id, 'All documents verified.');
    await addNotification(app_.user_id, 'Document Verification Completed ✓', `All documents for application ${app_.application_code} have been verified.`);
  } else if (anyRejected) {
    await addNotification(app_.user_id, 'Document Needs Attention', `One or more documents in application ${app_.application_code} require resubmission or were rejected.`);
  }

  res.redirect('/applications/' + application_id);
}));

// ================= ADMIN MODULE =================
app.get('/admin', requireLogin, requireRole('ADMIN'), ah(async (req, res) => {
  const stats = {
    totalUsers: (await db.prepare("SELECT COUNT(*) c FROM users WHERE role='USER'").get()).c,
    activeSchemes: (await db.prepare("SELECT COUNT(*) c FROM schemes WHERE status='Active'").get()).c,
    totalApplications: (await db.prepare("SELECT COUNT(*) c FROM applications").get()).c,
    pendingVerification: (await db.prepare("SELECT COUNT(*) c FROM applications WHERE status IN ('Submitted','Document Verification')").get()).c,
    approved: (await db.prepare("SELECT COUNT(*) c FROM applications WHERE status='Approved'").get()).c,
    rejected: (await db.prepare("SELECT COUNT(*) c FROM applications WHERE status='Rejected'").get()).c,
    ngoCount: (await db.prepare("SELECT COUNT(*) c FROM users WHERE role IN ('NGO','VOLUNTEER')").get()).c
  };
  const recentApps = await db.prepare(`
    SELECT a.*, s.name as scheme_name, u.name as applicant_name FROM applications a
    JOIN schemes s ON s.id=a.scheme_id JOIN users u ON u.id=a.user_id
    ORDER BY a.created_at DESC LIMIT 10
  `).all();
  res.render('admin_dashboard', { stats, recentApps });
}));

// --- Admin: Scheme management ---
app.get('/admin/schemes', requireLogin, requireRole('ADMIN'), ah(async (req, res) => {
  const schemes = await db.prepare('SELECT * FROM schemes ORDER BY created_at DESC').all();
  res.render('admin_schemes', { schemes });
}));

app.get('/admin/schemes/new', requireLogin, requireRole('ADMIN'), (req, res) => {
  res.render('admin_scheme_form', { scheme: null, docs: [], groups: [] });
});

app.post('/admin/schemes/new', requireLogin, requireRole('ADMIN'), ah(async (req, res) => {
  const { name, description, department, level, state, category, benefits, start_date, end_date, official_url, application_instructions, contact_info } = req.body;
  const info = await db.prepare(`INSERT INTO schemes (name, description, department, level, state, category, benefits, start_date, end_date, official_url, application_instructions, contact_info) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(name, description, department, level, state, category, benefits, start_date || null, end_date || null, official_url, application_instructions, contact_info);
  res.redirect('/admin/schemes/' + info.lastInsertRowid + '/edit');
}));

app.get('/admin/schemes/:id/edit', requireLogin, requireRole('ADMIN'), ah(async (req, res) => {
  const scheme = await db.prepare('SELECT * FROM schemes WHERE id=?').get(req.params.id);
  if (!scheme) return res.status(404).render('error', { message: 'Scheme not found', user: req.session.user });
  const docs = await db.prepare('SELECT * FROM scheme_documents WHERE scheme_id=?').all(req.params.id);
  const rawGroups = await db.prepare('SELECT * FROM rule_groups WHERE scheme_id=?').all(req.params.id);
  const groups = [];
  for (const g of rawGroups) {
    const conditions = await db.prepare('SELECT * FROM eligibility_rules WHERE group_id=?').all(g.id);
    groups.push({ ...g, conditions });
  }
  res.render('admin_scheme_form', { scheme, docs, groups });
}));

app.post('/admin/schemes/:id/edit', requireLogin, requireRole('ADMIN'), ah(async (req, res) => {
  const { name, description, department, level, state, category, benefits, start_date, end_date, official_url, application_instructions, contact_info, status } = req.body;
  await db.prepare(`UPDATE schemes SET name=?, description=?, department=?, level=?, state=?, category=?, benefits=?, start_date=?, end_date=?, official_url=?, application_instructions=?, contact_info=?, status=? WHERE id=?`)
    .run(name, description, department, level, state, category, benefits, start_date || null, end_date || null, official_url, application_instructions, contact_info, status, req.params.id);
  res.redirect('/admin/schemes/' + req.params.id + '/edit?saved=1');
}));

app.post('/admin/schemes/:id/delete', requireLogin, requireRole('ADMIN'), ah(async (req, res) => {
  const id = req.params.id;
  const groupIds = (await db.prepare('SELECT id FROM rule_groups WHERE scheme_id=?').all(id)).map(g => g.id);
  for (const gid of groupIds) {
    await db.prepare('DELETE FROM eligibility_rules WHERE group_id=?').run(gid);
  }
  await db.prepare('DELETE FROM rule_groups WHERE scheme_id=?').run(id);
  await db.prepare('DELETE FROM scheme_documents WHERE scheme_id=?').run(id);
  await db.prepare('DELETE FROM schemes WHERE id=?').run(id);
  res.redirect('/admin/schemes');
}));

// --- Admin: Documents required for scheme ---
app.post('/admin/schemes/:id/documents', requireLogin, requireRole('ADMIN'), ah(async (req, res) => {
  const { document_name } = req.body;
  if (document_name && document_name.trim()) {
    await db.prepare('INSERT INTO scheme_documents (scheme_id, document_name, required) VALUES (?,?,1)').run(req.params.id, document_name.trim());
  }
  res.redirect('/admin/schemes/' + req.params.id + '/edit');
}));

app.post('/admin/documents/:docId/delete', requireLogin, requireRole('ADMIN'), ah(async (req, res) => {
  const doc = await db.prepare('SELECT * FROM scheme_documents WHERE id=?').get(req.params.docId);
  await db.prepare('DELETE FROM scheme_documents WHERE id=?').run(req.params.docId);
  res.redirect('/admin/schemes/' + (doc ? doc.scheme_id : '') + '/edit');
}));

// --- Admin: Rule builder ---
app.post('/admin/schemes/:id/rulegroups', requireLogin, requireRole('ADMIN'), ah(async (req, res) => {
  const { logic_type } = req.body;
  await db.prepare('INSERT INTO rule_groups (scheme_id, logic_type) VALUES (?,?)').run(req.params.id, logic_type === 'OR' ? 'OR' : 'AND');
  res.redirect('/admin/schemes/' + req.params.id + '/edit');
}));

app.post('/admin/rulegroups/:groupId/delete', requireLogin, requireRole('ADMIN'), ah(async (req, res) => {
  const group = await db.prepare('SELECT * FROM rule_groups WHERE id=?').get(req.params.groupId);
  await db.prepare('DELETE FROM eligibility_rules WHERE group_id=?').run(req.params.groupId);
  await db.prepare('DELETE FROM rule_groups WHERE id=?').run(req.params.groupId);
  res.redirect('/admin/schemes/' + (group ? group.scheme_id : '') + '/edit');
}));

app.post('/admin/rulegroups/:groupId/rules', requireLogin, requireRole('ADMIN'), ah(async (req, res) => {
  const { field, operator, value, label } = req.body;
  const group = await db.prepare('SELECT * FROM rule_groups WHERE id=?').get(req.params.groupId);
  await db.prepare('INSERT INTO eligibility_rules (group_id, field, operator, value, label) VALUES (?,?,?,?,?)')
    .run(req.params.groupId, field, operator, value, label || null);
  res.redirect('/admin/schemes/' + group.scheme_id + '/edit');
}));

app.post('/admin/rules/:ruleId/delete', requireLogin, requireRole('ADMIN'), ah(async (req, res) => {
  const rule = await db.prepare('SELECT * FROM eligibility_rules WHERE id=?').get(req.params.ruleId);
  const group = rule ? await db.prepare('SELECT * FROM rule_groups WHERE id=?').get(rule.group_id) : null;
  await db.prepare('DELETE FROM eligibility_rules WHERE id=?').run(req.params.ruleId);
  res.redirect('/admin/schemes/' + (group ? group.scheme_id : '') + '/edit');
}));

// --- Admin: Users & NGOs ---
app.get('/admin/users', requireLogin, requireRole('ADMIN'), ah(async (req, res) => {
  const users = await db.prepare('SELECT * FROM users ORDER BY created_at DESC').all();
  res.render('admin_users', { users });
}));

app.post('/admin/users/:id/role', requireLogin, requireRole('ADMIN'), ah(async (req, res) => {
  const { role } = req.body;
  const allowed = ['USER', 'VOLUNTEER', 'NGO', 'ADMIN'];
  if (allowed.includes(role)) {
    await db.prepare('UPDATE users SET role=? WHERE id=?').run(role, req.params.id);
  }
  res.redirect('/admin/users');
}));

app.post('/admin/users/:id/delete', requireLogin, requireRole('ADMIN'), ah(async (req, res) => {
  if (parseInt(req.params.id) === req.session.user.id) return res.redirect('/admin/users');
  await db.prepare('DELETE FROM users WHERE id=?').run(req.params.id);
  res.redirect('/admin/users');
}));

// --- Admin: Applications monitoring ---
app.get('/admin/applications', requireLogin, requireRole('ADMIN'), ah(async (req, res) => {
  const apps = await db.prepare(`
    SELECT a.*, s.name as scheme_name, u.name as applicant_name, v.name as assigned_name
    FROM applications a
    JOIN schemes s ON s.id=a.scheme_id
    JOIN users u ON u.id=a.user_id
    LEFT JOIN users v ON v.id = a.assigned_to
    ORDER BY a.created_at DESC
  `).all();
  res.render('admin_applications', { apps });
}));

app.post('/applications/:id/status', requireLogin, requireRole('ADMIN', 'NGO', 'VOLUNTEER'), ah(async (req, res) => {
  const { status, remarks } = req.body;
  const allowed = ['Draft', 'Submitted', 'Document Verification', 'Verified', 'Forwarded', 'Approved', 'Rejected'];
  if (!allowed.includes(status)) return res.status(400).send('Invalid status');
  await db.prepare('UPDATE applications SET status=? WHERE id=?').run(status, req.params.id);
  await addHistory(req.params.id, status, req.session.user.id, remarks || null);

  const app_ = await db.prepare('SELECT * FROM applications WHERE id=?').get(req.params.id);
  const scheme = await db.prepare('SELECT * FROM schemes WHERE id=?').get(app_.scheme_id);
  if (status === 'Approved') {
    await addNotification(app_.user_id, 'Application Approved 🎉', `Your application ${app_.application_code} for "${scheme.name}" has been approved.`);
  } else if (status === 'Rejected') {
    await addNotification(app_.user_id, 'Application Rejected', `Your application ${app_.application_code} for "${scheme.name}" was rejected. ${remarks || ''}`);
  } else {
    await addNotification(app_.user_id, `Application Update: ${status}`, `Your application ${app_.application_code} status changed to ${status}.`);
  }

  res.redirect('/applications/' + req.params.id);
}));

app.post('/admin/applications/:id/assign', requireLogin, requireRole('ADMIN'), ah(async (req, res) => {
  const { assigned_to } = req.body;
  await db.prepare('UPDATE applications SET assigned_to=? WHERE id=?').run(assigned_to || null, req.params.id);
  await addHistory(req.params.id, 'Assigned', req.session.user.id, 'Reassigned by admin.');
  res.redirect('/applications/' + req.params.id);
}));

// ================= NOTIFICATIONS =================
app.get('/notifications', requireLogin, ah(async (req, res) => {
  const list = await db.prepare('SELECT * FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 50').all(req.session.user.id);
  await db.prepare('UPDATE notifications SET is_read=1 WHERE user_id=?').run(req.session.user.id);
  res.render('notifications', { list });
}));

app.get('/api/notifications/unread-count', requireLogin, ah(async (req, res) => {
  const c = (await db.prepare('SELECT COUNT(*) c FROM notifications WHERE user_id=? AND is_read=0').get(req.session.user.id)).c;
  res.json({ count: parseInt(c, 10) || 0 });
}));

// ================= ERROR HANDLING =================
app.use((req, res) => {
  res.status(404).render('error', { message: 'Page not found.', user: req.session.user });
});

app.use((err, req, res, next) => {
  console.error('Request error:', err);

  // Multer file-type/size rejections are user-actionable — show the real message.
  if (err && (err.code === 'LIMIT_FILE_SIZE' || /Only PDF, JPG, PNG, or WEBP/.test(err.message || ''))) {
    const msg = err.code === 'LIMIT_FILE_SIZE' ? 'That file is too large — the limit is 10MB.' : err.message;
    return res.status(400).render('error', { message: msg, user: req.session.user || null });
  }

  res.status(500).render('error', { message: 'Something went wrong on our end. Please try again.', user: req.session.user || null });
});

// ================= STARTUP =================
async function start() {
  try {
    await initSchema();
  } catch (e) {
    console.error('\n  Could not connect to PostgreSQL / initialize schema.');
    console.error('  Check that PostgreSQL is running and DATABASE_URL is correct.');
    console.error('  Error:', e.message, '\n');
    process.exit(1);
  }

  await autoExpireSchemes();
  setInterval(autoExpireSchemes, 1000 * 60 * 60); // re-check hourly

  app.listen(PORT, () => {
    console.log(`\n  GrantMatch running at http://localhost:${PORT}\n`);
  });
}

start();
