const crypto = require('crypto');

function requireLogin(req, res, next) {
  if (!req.session.user) return res.redirect('/login');
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.session.user) return res.redirect('/login');
    if (!roles.includes(req.session.user.role)) {
      return res.status(403).render('error', { message: 'You do not have permission to access this page.', user: req.session.user });
    }
    next();
  };
}

function attachUser(req, res, next) {
  res.locals.user = req.session.user || null;
  res.locals.fmtDate = (d) => {
    if (!d) return '';
    const date = d instanceof Date ? d : new Date(d);
    if (isNaN(date)) return String(d);
    return date.toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  };
  next();
}

// ---------- CSRF protection ----------
// Simple synchronizer-token pattern: a random token is stored in the session
// and must be echoed back on every state-changing request (POST/PUT/DELETE).
// This stops a malicious page on another site from silently submitting forms
// to this app using the visitor's logged-in session cookie.
function csrfToken(req, res, next) {
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  }
  res.locals.csrfToken = req.session.csrfToken;
  next();
}

function verifyCsrf(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const submitted = req.body && req.body._csrf;
  const expected = req.session && req.session.csrfToken;
  if (!expected || !submitted || submitted !== expected) {
    return res.status(403).render('error', {
      message: 'Your session security check failed (this can happen if a form was left open too long). Please go back, refresh the page, and try again.',
      user: req.session.user || null
    });
  }
  next();
}

module.exports = { requireLogin, requireRole, attachUser, csrfToken, verifyCsrf };
