# GrantMatch

A government-scheme discovery, eligibility, application, and verification platform.

`User Profile → Eligibility Engine → Matched Schemes → Apply → Document Upload → NGO/Volunteer Verification → Application Tracking → Admin Monitoring`

Built with **Node.js + Express + PostgreSQL** and server-rendered EJS views.

> **Why PostgreSQL instead of SQLite?** This version trades a bit of setup simplicity for real scalability — PostgreSQL handles many simultaneous users, concurrent writes, and larger datasets the way SQLite (a single-file, single-writer database) isn't designed to. If you used an earlier version of GrantMatch built on SQLite, this replaces it; your old `.db` file is not compatible and won't be used.

---

## 1. Requirements

- **Node.js 18+** — https://nodejs.org
- **PostgreSQL** — a database server, set up one of two ways below. **Docker is the easier path** if you're not sure which to pick.

Check Node is installed:
```powershell
node -v
npm -v
```

---

## 2. Set up PostgreSQL (pick one)

### Option A — Docker (recommended, easiest)

1. Install [Docker Desktop for Windows](https://www.docker.com/products/docker-desktop/) if you don't have it, and make sure it's running.
2. From inside the `grantmatch` folder in PowerShell:
   ```powershell
   docker compose up -d
   ```
   This starts a PostgreSQL server in the background, pre-configured to match the app's default settings. You won't need to touch it again — just leave it running (or `docker compose up -d` again after a reboot).

### Option B — Install PostgreSQL directly on Windows

1. Download and run the installer from https://www.postgresql.org/download/windows/
2. During setup, set the password for the `postgres` user to `postgres` (or note whatever you choose).
3. Once installed, open **pgAdmin** (installed alongside) or `psql` and create a database named `grantmatch`:
   ```sql
   CREATE DATABASE grantmatch;
   ```
4. If you used a different username/password/database name than the defaults, update `.env` (see below) to match.

---

## 3. App setup (PowerShell)

Unzip this project, then open PowerShell **inside the `grantmatch` folder**:

```powershell
cd path\to\grantmatch
```

Copy the example environment file:
```powershell
copy .env.example .env
```
The defaults in `.env` match the Docker setup (Option A) exactly, so if you used Docker you don't need to edit anything. If you used Option B with different credentials, edit `.env` and update `DATABASE_URL`.

Install dependencies:
```powershell
npm install
```

> If PowerShell blocks npm with a script-execution error, run this once:
> ```powershell
> Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
> ```

Seed the database with demo users and sample schemes:
```powershell
npm run seed
```
If this fails with a connection error, PostgreSQL isn't running or reachable — check Docker Desktop is open (Option A) or the PostgreSQL service is running (Option B).

Start the app:
```powershell
npm start
```

You'll see:
```
GrantMatch running at http://localhost:3000
```

Open that URL in your browser.

---

## 4. Demo Logins

| Role      | Email                     | Password    |
|-----------|----------------------------|-------------|
| Citizen   | citizen@grantmatch.gov     | citizen123  |
| NGO       | ngo@grantmatch.gov         | ngo123      |
| Volunteer | volunteer@grantmatch.gov   | vol123      |
| Admin     | admin@grantmatch.gov       | admin123    |

Or register a brand-new account from the homepage.

---

## 5. What's included (by module)

- **Citizen module** — registration, profile builder, scheme discovery with filters, "Why am I eligible?" explainability, apply, document upload, application tracking timeline.
- **Eligibility Rule Engine** — evaluates a citizen's profile against admin-defined rule groups (AND/OR logic supported), returns pass/fail per condition with human-readable reasons, not just a yes/no.
- **Scheme Management (Admin)** — create/edit/delete schemes, define required documents, build eligibility rules through a UI (no code required).
- **Application Workflow** — Draft → Submitted → Document Verification → Verified → Forwarded → Approved/Rejected, fully configurable by admin/NGO/volunteer.
- **Document Management** — per-application document upload, verification status, verifier remarks.
- **NGO/Volunteer Module** — dashboard of assigned + unassigned applications, claim applications, verify/reject documents with remarks, and **assist a citizen in person**: search for a citizen, view their eligibility, and submit an application on their behalf (marked "Assisted by" on the application) — for citizens who can't self-serve online.
- **Admin Dashboard** — platform-wide stats, user role management, application monitoring, reassignment.
- **Notifications** — in-app notifications on submission, verification, approval/rejection, with a live unread-count badge in the navbar.
- **Scheme expiry automation** — schemes past their `end_date` are automatically flipped to "Expired" and hidden from citizen discovery, with no manual admin action needed.
- **Visual design** — a deliberate "civic registry" identity (deep navy, warm paper, an ochre accent, serif headlines) instead of a generic SaaS template look, with eligibility/verification statuses shown as an original stamp-style mark rather than colored emoji.

## 6. Project structure

```
grantmatch/
├── src/
│   ├── server.js            # Express app, all routes (async, PostgreSQL-backed)
│   ├── db.js                 # PostgreSQL connection pool + schema + query helper
│   ├── eligibilityEngine.js  # Core rule-evaluation engine
│   ├── middleware.js         # Auth/role guards
│   └── seed.js                # Demo data
├── views/                    # EJS templates (all pages)
├── public/css/style.css      # Styling
├── uploads/                   # Uploaded documents land here
├── docker-compose.yml         # One-command local PostgreSQL
├── .env.example                # Copy to .env and adjust if needed
└── package.json
```

## 7. Resetting the database

To wipe and reseed everything:
```powershell
npm run seed
```
This clears all data and reloads the demo users/schemes. Uploaded files in `/uploads` are not deleted automatically — remove them manually if needed.

## 8. Loading real government scheme data

After seeding, run:
```powershell
npm run add-real-schemes
```
This replaces the generic placeholder schemes with **eight real, named central government schemes** — PM-KISAN, Ayushman Bharat (PM-JAY), PM Ujjwala Yojana 2.0, the Indira Gandhi National Old Age Pension Scheme, PM Awas Yojana–Gramin, the Pradhan Mantri Matru Vandana Yojana (maternity benefit), the Indira Gandhi National Disability Pension Scheme, and the Pradhan Mantri Mudra Yojana (business loans) — with eligibility criteria and benefit amounts compiled from public sources.

**Read this before treating the results as authoritative:** real scheme eligibility is often based on data this app's rule engine can't check — SECC-2011 census deprivation markers, BPL ration card status, Awaas+ survey inclusion, and similar — rather than a clean income or age threshold. Each of these five schemes approximates the real criteria with the closest field this app has (usually `annual_income`) and says so directly in its description on the scheme page, not just in this README. Scheme rules, amounts, and cutoffs also change over time — always point people to the linked official portal rather than treating this app's output as a final determination. This script is safe to re-run any time; it updates matching schemes by name rather than duplicating them, and only removes a superseded generic scheme if nobody has applied to it yet.

To add further real schemes yourself, either use the Admin → Manage Schemes UI directly, or extend `src/add_real_schemes.js` following the same pattern.

## 9. Security

This build includes real security hardening, not just the bare minimum to run locally:

- **CSRF protection** — every form includes a per-session token that's verified on submission, so a malicious page on another site can't silently submit requests using a logged-in visitor's session cookie.
- **Rate limiting** — login and registration are limited to 20 attempts per 15 minutes per client, blunting brute-force and credential-stuffing attempts. The rest of the app has a lighter general limit (600 req/15min) mainly to blunt scripted abuse.
- **Security headers** via Helmet — Content-Security-Policy (script execution restricted to same-origin), Strict-Transport-Security, X-Content-Type-Options, X-Frame-Options, and friends, all set automatically.
- **Restricted file uploads** — only PDF, JPG, PNG, and WEBP files are accepted (blocks executables/scripts outright), and every uploaded file is served with `Content-Disposition: attachment`, so even if something slipped through, a browser downloads it rather than running it inline. This closes off stored-XSS via uploaded HTML/SVG.
- **Secure session cookies** — `httpOnly` (JavaScript can't read the cookie), `sameSite: lax`, and `secure` (HTTPS-only) automatically once `NODE_ENV=production` is set.
- **Startup warning** — the app refuses to stay quiet if `SESSION_SECRET` is left at its default value; it prints a warning on every boot until you set a real one.
- Passwords are hashed with bcrypt; login/registration give a generic "invalid email or password" message rather than confirming which part was wrong (prevents account enumeration).

**What's still needed before a genuine production deployment** — this app is meaningfully hardened for what it is, but a few things are deliberately out of scope for a project at this stage and need to be addressed by whoever actually deploys it:

- **HTTPS/TLS termination** — this app runs plain HTTP; a real deployment needs a reverse proxy (nginx, Caddy, a cloud load balancer) handling TLS in front of it, with `NODE_ENV=production` set so secure cookies activate.
- **Persistent session store** — sessions are currently in-memory, meaning everyone gets logged out on every restart and sessions won't survive across multiple server instances. Swap in something like `connect-pg-simple` (stores sessions in the same Postgres database) before running more than one instance or caring about uptime.
- **A real `SESSION_SECRET`** — generate one with `node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"` and put it in `.env`; never reuse the default.
- **Object storage for uploads** — files currently live on local disk; that doesn't survive redeploys or scale across multiple servers. Move to S3 or equivalent before production.
- **A CERT-In empanelled security audit and DPDP Act compliance work** — required for anything handling real citizens' income, disability status, and identity documents at scale. See the accompanying partnership proposal document for the full list of what real government deployment requires (DigiLocker/Aadhaar/PFMS integration, official data-sharing agreements, and so on) — this security hardening pass does not substitute for that.

## 10. Notes on this build

This is a fully functional MVP covering all the modules discussed, now running on production-grade database technology with real security hardening (see Section 9):

- **Database**: PostgreSQL via connection pooling (`pg` package) — supports real concurrent usage, unlike the single-writer SQLite version this replaced.
- The eligibility engine supports numeric/text operators (`>=,<=,>,<,=,!=`) and nested AND/OR rule groups per scheme — extend the `field` list in `eligibilityEngine.js` and the rule-builder dropdown in `admin_scheme_form.ejs` to add new profile attributes.
- This is still a prototype, not a government-authorized platform — see the accompanying partnership proposal document for what's required to take this further.
