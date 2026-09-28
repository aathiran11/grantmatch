const { Pool } = require('pg');
require('dotenv').config();

const connectionString = process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/grantmatch';

const pool = new Pool({ connectionString });

pool.on('error', (err) => {
  console.error('Unexpected PostgreSQL error on idle client:', err.message);
});

// ---------- Compatibility layer ----------
// The rest of the app is written against a small subset of the better-sqlite3 /
// node:sqlite prepared-statement API: db.prepare(sql).run(...) / .get(...) / .all(...).
// This shim lets every call site keep that familiar shape while actually running
// against PostgreSQL. Two differences callers must respect (both handled here):
//   1. Every call is now async — callers must `await` it.
//   2. Placeholders are written as `?` in the SQL (SQLite-style) and converted to
//      PostgreSQL's `$1, $2, ...` automatically.
function toPgParams(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => '$' + (++i));
}

function isInsert(sql) {
  return /^\s*INSERT/i.test(sql);
}

// Tables whose primary key is not literally called "id" — auto-RETURNING id
// would fail against these, so we skip it.
const TABLES_WITHOUT_ID_PK = ['user_profiles'];

function targetTable(sql) {
  const m = sql.match(/^\s*INSERT\s+INTO\s+(\w+)/i);
  return m ? m[1] : null;
}

const db = {
  prepare(sql) {
    let pgSql = toPgParams(sql.trim());
    const table = targetTable(pgSql);
    const autoReturning = isInsert(pgSql) && !/RETURNING/i.test(pgSql) && !TABLES_WITHOUT_ID_PK.includes(table);
    if (autoReturning) pgSql += ' RETURNING id';

    return {
      async run(...params) {
        const res = await pool.query(pgSql, params);
        return {
          lastInsertRowid: res.rows[0] ? res.rows[0].id : undefined,
          changes: res.rowCount
        };
      },
      async get(...params) {
        const res = await pool.query(pgSql, params);
        return res.rows[0];
      },
      async all(...params) {
        const res = await pool.query(pgSql, params);
        return res.rows;
      }
    };
  },

  async exec(sql) {
    await pool.query(sql);
  },

  async end() {
    await pool.end();
  }
};

// ---------- Schema ----------
async function initSchema() {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      phone TEXT,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'USER',
      organization_name TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS user_profiles (
      user_id INTEGER PRIMARY KEY REFERENCES users(id),
      date_of_birth TEXT,
      gender TEXT,
      state TEXT,
      district TEXT,
      occupation TEXT,
      annual_income REAL,
      education TEXT,
      category TEXT,
      disability_status TEXT DEFAULT 'No',
      family_members INTEGER,
      land_owner TEXT DEFAULT 'No',
      updated_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS schemes (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      department TEXT,
      level TEXT DEFAULT 'State',
      state TEXT DEFAULT 'All',
      category TEXT,
      benefits TEXT,
      start_date TEXT,
      end_date TEXT,
      official_url TEXT,
      application_instructions TEXT,
      contact_info TEXT,
      status TEXT DEFAULT 'Active',
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS rule_groups (
      id SERIAL PRIMARY KEY,
      scheme_id INTEGER NOT NULL REFERENCES schemes(id),
      logic_type TEXT DEFAULT 'AND'
    );

    CREATE TABLE IF NOT EXISTS eligibility_rules (
      id SERIAL PRIMARY KEY,
      group_id INTEGER NOT NULL REFERENCES rule_groups(id),
      field TEXT NOT NULL,
      operator TEXT NOT NULL,
      value TEXT NOT NULL,
      label TEXT
    );

    CREATE TABLE IF NOT EXISTS scheme_documents (
      id SERIAL PRIMARY KEY,
      scheme_id INTEGER NOT NULL REFERENCES schemes(id),
      document_name TEXT NOT NULL,
      required INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS applications (
      id SERIAL PRIMARY KEY,
      application_code TEXT UNIQUE NOT NULL,
      user_id INTEGER NOT NULL REFERENCES users(id),
      scheme_id INTEGER NOT NULL REFERENCES schemes(id),
      status TEXT DEFAULT 'Draft',
      assigned_to INTEGER REFERENCES users(id),
      assisted_by INTEGER REFERENCES users(id),
      eligibility_snapshot TEXT,
      submitted_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS application_documents (
      id SERIAL PRIMARY KEY,
      application_id INTEGER NOT NULL REFERENCES applications(id),
      document_name TEXT NOT NULL,
      file_path TEXT,
      verification_status TEXT DEFAULT 'Pending',
      verified_by INTEGER,
      remarks TEXT,
      uploaded_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS application_history (
      id SERIAL PRIMARY KEY,
      application_id INTEGER NOT NULL REFERENCES applications(id),
      status TEXT NOT NULL,
      changed_by INTEGER,
      remarks TEXT,
      changed_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      title TEXT NOT NULL,
      message TEXT,
      is_read INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  // Migration for DBs created before assisted_by existed
  try { await db.exec('ALTER TABLE applications ADD COLUMN IF NOT EXISTS assisted_by INTEGER REFERENCES users(id)'); } catch (e) { /* ignore */ }
}

module.exports = { db, pool, initSchema };
