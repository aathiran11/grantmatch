const bcrypt = require('bcryptjs');
const { db, initSchema, pool } = require('./db');

function hash(pw) { return bcrypt.hashSync(pw, 10); }

async function createScheme(scheme, ruleGroupsDefs, documents) {
  const info = await db.prepare(`INSERT INTO schemes (name, description, department, level, state, category, benefits, start_date, end_date, official_url, application_instructions, contact_info, status)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(scheme.name, scheme.description, scheme.department, scheme.level, scheme.state, scheme.category, scheme.benefits,
      scheme.start_date, scheme.end_date, scheme.official_url, scheme.application_instructions, scheme.contact_info, 'Active');
  const schemeId = info.lastInsertRowid;

  for (const groupDef of ruleGroupsDefs) {
    const g = await db.prepare('INSERT INTO rule_groups (scheme_id, logic_type) VALUES (?,?)').run(schemeId, groupDef.logic_type);
    for (const c of groupDef.conditions) {
      await db.prepare('INSERT INTO eligibility_rules (group_id, field, operator, value, label) VALUES (?,?,?,?,?)')
        .run(g.lastInsertRowid, c.field, c.operator, c.value, c.label || null);
    }
  }

  for (const d of documents) {
    await db.prepare('INSERT INTO scheme_documents (scheme_id, document_name, required) VALUES (?,?,1)').run(schemeId, d);
  }

  return schemeId;
}

async function main() {
  console.log('Connecting to PostgreSQL and initializing schema...');
  await initSchema();

  console.log('Seeding GrantMatch database...');

  // Clear existing data (order matters due to foreign keys)
  await db.exec(`
    DELETE FROM notifications;
    DELETE FROM application_history;
    DELETE FROM application_documents;
    DELETE FROM applications;
    DELETE FROM scheme_documents;
    DELETE FROM eligibility_rules;
    DELETE FROM rule_groups;
    DELETE FROM schemes;
    DELETE FROM user_profiles;
    DELETE FROM users;
  `);

  // Reset auto-increment sequences so IDs start fresh (matches prior SQLite demo behavior)
  await db.exec(`
    ALTER SEQUENCE users_id_seq RESTART WITH 1;
    ALTER SEQUENCE schemes_id_seq RESTART WITH 1;
    ALTER SEQUENCE rule_groups_id_seq RESTART WITH 1;
    ALTER SEQUENCE eligibility_rules_id_seq RESTART WITH 1;
    ALTER SEQUENCE scheme_documents_id_seq RESTART WITH 1;
    ALTER SEQUENCE applications_id_seq RESTART WITH 1;
    ALTER SEQUENCE application_documents_id_seq RESTART WITH 1;
    ALTER SEQUENCE application_history_id_seq RESTART WITH 1;
    ALTER SEQUENCE notifications_id_seq RESTART WITH 1;
  `);

  // --- Users ---
  const admin = await db.prepare('INSERT INTO users (name,email,phone,password_hash,role) VALUES (?,?,?,?,?)')
    .run('Admin User', 'admin@grantmatch.gov', '9999900000', hash('admin123'), 'ADMIN');

  const ngo = await db.prepare('INSERT INTO users (name,email,phone,password_hash,role,organization_name) VALUES (?,?,?,?,?,?)')
    .run('Seva Foundation', 'ngo@grantmatch.gov', '9999900001', hash('ngo123'), 'NGO', 'Seva Foundation Trust');

  const volunteer = await db.prepare('INSERT INTO users (name,email,phone,password_hash,role) VALUES (?,?,?,?,?)')
    .run('Priya Volunteer', 'volunteer@grantmatch.gov', '9999900002', hash('vol123'), 'VOLUNTEER');

  const citizen = await db.prepare('INSERT INTO users (name,email,phone,password_hash,role) VALUES (?,?,?,?,?)')
    .run('Ramesh Kumar', 'citizen@grantmatch.gov', '9999900003', hash('citizen123'), 'USER');

  await db.prepare(`INSERT INTO user_profiles (user_id, date_of_birth, gender, state, district, occupation, annual_income, education, category, disability_status, family_members, land_owner)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(citizen.lastInsertRowid, '2000-06-15', 'Male', 'Tamil Nadu', 'Coimbatore', 'Farmer', 180000, 'Higher Secondary', 'OBC', 'No', 4, 'Yes');

  console.log('Created users: admin, ngo, volunteer, citizen');

  // --- Scheme 1: PM Kisan-style farmer support ---
  await createScheme({
    name: 'PM Farmer Income Support Scheme',
    description: 'Direct income support of ₹6,000 per year to small and marginal farmer families, paid in three installments.',
    department: 'Ministry of Agriculture & Farmers Welfare',
    level: 'Central',
    state: 'All',
    category: 'Agriculture',
    benefits: '₹6,000 per year in 3 installments of ₹2,000 directly to bank account',
    start_date: '2024-01-01',
    end_date: '2027-12-31',
    official_url: 'https://pmkisan.gov.in',
    application_instructions: 'Apply online with land records and Aadhaar-linked bank account details.',
    contact_info: 'Toll-free: 1800-11-0001'
  }, [
    { logic_type: 'AND', conditions: [
      { field: 'occupation', operator: '=', value: 'Farmer' },
      { field: 'annual_income', operator: '<=', value: '250000' },
      { field: 'land_owner', operator: '=', value: 'Yes' }
    ]}
  ], ['Aadhaar Card', 'Land Ownership Document', 'Bank Passbook', 'Income Certificate']);

  // --- Scheme 2: Girl child education scholarship ---
  await createScheme({
    name: 'Girl Child Education Scholarship',
    description: 'Scholarship to support the education of girl children from economically weaker families.',
    department: 'Department of School Education',
    level: 'State',
    state: 'Tamil Nadu',
    category: 'Education',
    benefits: '₹10,000 per academic year',
    start_date: '2024-06-01',
    end_date: '2026-12-31',
    official_url: 'https://tn.gov.in/scholarships',
    application_instructions: 'Submit school enrollment certificate along with family income proof.',
    contact_info: 'District Education Office'
  }, [
    { logic_type: 'AND', conditions: [
      { field: 'gender', operator: '=', value: 'Female' },
      { field: 'annual_income', operator: '<=', value: '300000' },
      { field: 'state', operator: '=', value: 'Tamil Nadu' },
      { field: 'age', operator: '<=', value: '18' }
    ]}
  ], ['Birth Certificate', 'School Enrollment Certificate', 'Income Certificate', 'Bank Passbook']);

  // --- Scheme 3: Senior citizen / disability pension (OR logic demo) ---
  await createScheme({
    name: 'Senior Citizen & Disability Support Pension',
    description: 'Monthly pension for senior citizens (60+) or persons with disability, from economically weaker sections.',
    department: 'Department of Social Welfare',
    level: 'State',
    state: 'All',
    category: 'Social Welfare',
    benefits: '₹1,500 per month',
    start_date: '2023-04-01',
    end_date: '2027-03-31',
    official_url: 'https://socialwelfare.gov.in/pension',
    application_instructions: 'Apply at nearest social welfare office with age/disability proof and income certificate.',
    contact_info: 'Social Welfare Helpline: 1800-11-0002'
  }, [
    { logic_type: 'OR', conditions: [
      { field: 'age', operator: '>=', value: '60' },
      { field: 'disability_status', operator: '=', value: 'Yes' }
    ]},
    { logic_type: 'AND', conditions: [
      { field: 'annual_income', operator: '<=', value: '200000' }
    ]}
  ], ['Aadhaar Card', 'Age Proof / Disability Certificate', 'Income Certificate', 'Bank Passbook']);

  // --- Scheme 4: Unemployed youth skill development ---
  await createScheme({
    name: 'Youth Skill Development & Employment Scheme',
    description: 'Free vocational training and placement assistance for unemployed youth.',
    department: 'Ministry of Skill Development',
    level: 'Central',
    state: 'All',
    category: 'Employment',
    benefits: 'Free training + ₹3,000/month stipend during training',
    start_date: '2024-01-01',
    end_date: '2026-12-31',
    official_url: 'https://skillindia.gov.in',
    application_instructions: 'Register online and select a training center near you.',
    contact_info: 'Skill India Helpline: 1800-11-0003'
  }, [
    { logic_type: 'AND', conditions: [
      { field: 'age', operator: '>=', value: '18' },
      { field: 'age', operator: '<=', value: '35' }
    ]}
  ], ['Aadhaar Card', 'Educational Certificates', 'Bank Passbook']);

  // --- Scheme 5: Housing scheme for low income ---
  await createScheme({
    name: 'Affordable Housing Assistance Scheme',
    description: 'Financial assistance for construction/purchase of a house for low-income families without existing pucca housing.',
    department: 'Ministry of Housing & Urban Affairs',
    level: 'Central',
    state: 'All',
    category: 'Housing',
    benefits: 'Up to ₹2,50,000 subsidy',
    start_date: '2023-01-01',
    end_date: '2027-12-31',
    official_url: 'https://pmayg.gov.in',
    application_instructions: 'Apply with proof of not owning a pucca house and income certificate.',
    contact_info: 'Housing Helpline: 1800-11-0004'
  }, [
    { logic_type: 'AND', conditions: [
      { field: 'annual_income', operator: '<=', value: '300000' }
    ]}
  ], ['Aadhaar Card', 'Income Certificate', 'Residence Proof', 'Bank Passbook', 'Land Document (if applicable)']);

  console.log('Created 5 sample schemes with eligibility rules and required documents.');
  console.log('\n--- Login credentials ---');
  console.log('Admin:     admin@grantmatch.gov / admin123');
  console.log('NGO:       ngo@grantmatch.gov / ngo123');
  console.log('Volunteer: volunteer@grantmatch.gov / vol123');
  console.log('Citizen:   citizen@grantmatch.gov / citizen123');
  console.log('\nSeeding complete.');

  await pool.end();
}

main().catch(async (e) => {
  console.error('\nSeed failed:', e.message);
  console.error('Check that PostgreSQL is running and DATABASE_URL is correct (see .env / README).');
  try { await pool.end(); } catch (_) {}
  process.exit(1);
});
