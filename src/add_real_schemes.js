// Upgrades the demo/generic schemes to real, named central government schemes
// with eligibility criteria compiled from public sources (see disclaimer below).
// Safe to re-run: it updates by name if the scheme exists, inserts if not.
//
// IMPORTANT — read before relying on this data for anything real:
// Government scheme eligibility is often based on data sources this app's rule
// engine cannot model (SECC 2011 deprivation criteria, BPL ration card status,
// Awaas+ survey inclusion, etc.) rather than a simple income/age threshold.
// Every scheme below approximates the real criteria using the closest available
// proxy field and says so in its description. This is accurate enough for a
// demo/prototype, but is NOT a substitute for checking the official portal.
// Rules and amounts also change over time — verify against the official_url
// before treating this as current.

const { db, initSchema, pool } = require('./db');

const DISCLAIMER = ' [Data compiled from public sources for demo purposes — verify current details at the official link before relying on this.]';

async function upsertScheme(scheme, ruleGroupsDefs, documents) {
  const existing = await db.prepare('SELECT id FROM schemes WHERE name = ?').get(scheme.name);
  let schemeId;

  if (existing) {
    schemeId = existing.id;
    await db.prepare(`UPDATE schemes SET description=?, department=?, level=?, state=?, category=?, benefits=?, start_date=?, end_date=?, official_url=?, application_instructions=?, contact_info=?, status='Active' WHERE id=?`)
      .run(scheme.description, scheme.department, scheme.level, scheme.state, scheme.category, scheme.benefits,
        scheme.start_date, scheme.end_date, scheme.official_url, scheme.application_instructions, scheme.contact_info, schemeId);

    // wipe old rules/documents for this scheme before re-adding
    const groupIds = (await db.prepare('SELECT id FROM rule_groups WHERE scheme_id=?').all(schemeId)).map(g => g.id);
    for (const gid of groupIds) {
      await db.prepare('DELETE FROM eligibility_rules WHERE group_id=?').run(gid);
    }
    await db.prepare('DELETE FROM rule_groups WHERE scheme_id=?').run(schemeId);
    await db.prepare('DELETE FROM scheme_documents WHERE scheme_id=?').run(schemeId);
    console.log(`Updated: ${scheme.name}`);
  } else {
    const info = await db.prepare(`INSERT INTO schemes (name, description, department, level, state, category, benefits, start_date, end_date, official_url, application_instructions, contact_info, status)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'Active')`)
      .run(scheme.name, scheme.description, scheme.department, scheme.level, scheme.state, scheme.category, scheme.benefits,
        scheme.start_date, scheme.end_date, scheme.official_url, scheme.application_instructions, scheme.contact_info);
    schemeId = info.lastInsertRowid;
    console.log(`Created: ${scheme.name}`);
  }

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

async function deleteSchemeByName(name) {
  const existing = await db.prepare('SELECT id FROM schemes WHERE name = ?').get(name);
  if (!existing) return;
  const id = existing.id;
  const groupIds = (await db.prepare('SELECT id FROM rule_groups WHERE scheme_id=?').all(id)).map(g => g.id);
  for (const gid of groupIds) {
    await db.prepare('DELETE FROM eligibility_rules WHERE group_id=?').run(gid);
  }
  await db.prepare('DELETE FROM rule_groups WHERE scheme_id=?').run(id);
  await db.prepare('DELETE FROM scheme_documents WHERE scheme_id=?').run(id);
  // Applications referencing this scheme are left alone deliberately — deleting
  // a scheme a citizen already applied to would silently break their history.
  // We only remove it if nobody has applied yet.
  const appCount = (await db.prepare('SELECT COUNT(*) c FROM applications WHERE scheme_id=?').get(id)).c;
  if (parseInt(appCount, 10) === 0) {
    await db.prepare('DELETE FROM schemes WHERE id=?').run(id);
    console.log(`Removed superseded generic scheme: ${name}`);
  } else {
    await db.prepare("UPDATE schemes SET status='Inactive' WHERE id=?").run(id);
    console.log(`Deactivated (has applications, kept for history): ${name}`);
  }
}

async function main() {
  await initSchema();
  console.log('Upgrading demo schemes with real, sourced government scheme data...\n');

  // Remove the generic placeholder schemes that are now superseded by real,
  // named equivalents below (only if nobody has applied to them yet).
  await deleteSchemeByName('PM Farmer Income Support Scheme');
  await deleteSchemeByName('Senior Citizen & Disability Support Pension');
  await deleteSchemeByName('Affordable Housing Assistance Scheme');
  console.log('');

  // --- 1. PM-KISAN — fix: real scheme has no simple income cap. It's based on
  // farmer-family land ownership, with exclusions for institutional landholders,
  // income-tax payers, and government employees/pensioners (not modeled here). ---
  await upsertScheme({
    name: 'PM-KISAN (Pradhan Mantri Kisan Samman Nidhi)',
    description: 'Direct income support of ₹6,000 per year, paid in three ₹2,000 installments, to landholding farmer families across India via direct bank transfer.' + DISCLAIMER + ' The real scheme also excludes institutional landholders, income-tax payers, and current/former holders of constitutional posts or government jobs — none of which this demo checks.',
    department: 'Ministry of Agriculture & Farmers Welfare',
    level: 'Central',
    state: 'All',
    category: 'Agriculture',
    benefits: '₹6,000 per year in 3 installments of ₹2,000 directly to Aadhaar-linked bank account',
    start_date: '2019-02-01',
    end_date: '2029-03-31',
    official_url: 'https://pmkisan.gov.in',
    application_instructions: 'Register online at pmkisan.gov.in or through a Common Service Centre, with land records and an Aadhaar-linked bank account. e-KYC is mandatory to receive installments.',
    contact_info: 'PM-KISAN Helpline: 1800-11-5526'
  }, [
    { logic_type: 'AND', conditions: [
      { field: 'occupation', operator: '=', value: 'Farmer' },
      { field: 'land_owner', operator: '=', value: 'Yes' }
    ]}
  ], ['Aadhaar Card', 'Land Ownership Document', 'Bank Passbook (Aadhaar-linked)']);

  // --- 2. Ayushman Bharat PM-JAY — real eligibility is SECC-2011 deprivation /
  // occupational-category based, not a clean income threshold. We approximate
  // with an income proxy, OR universal inclusion for age 70+. ---
  await upsertScheme({
    name: 'Ayushman Bharat – PM-JAY (Health Insurance)',
    description: 'Free health insurance cover of up to ₹5 lakh per family per year for hospitalization at empanelled public and private hospitals. All citizens aged 70 and above qualify regardless of income; other households qualify based on deprivation/occupational criteria from the 2011 Socio-Economic Caste Census.' + DISCLAIMER + ' Real eligibility below age 70 is based on SECC-2011 deprivation and occupational categories (e.g. landless manual labourers, specific informal-sector jobs), which this demo approximates with an income threshold instead.',
    department: 'National Health Authority, Ministry of Health & Family Welfare',
    level: 'Central',
    state: 'All',
    category: 'Healthcare',
    benefits: 'Up to ₹5 lakh per family per year, cashless and paperless hospitalization cover; citizens 70+ get an additional individual ₹5 lakh top-up',
    start_date: '2018-09-23',
    end_date: '2029-03-31',
    official_url: 'https://pmjay.gov.in',
    application_instructions: 'Check eligibility using the "Am I Eligible" tool on pmjay.gov.in or the PM-JAY mobile app with your mobile number and state. If eligible, an Ayushman Card is issued.',
    contact_info: 'PM-JAY Helpline: 14555'
  }, [
    { logic_type: 'OR', conditions: [
      { field: 'annual_income', operator: '<=', value: '250000' },
      { field: 'age', operator: '>=', value: '70' }
    ]}
  ], ['Aadhaar Card', 'Ration Card', 'Income Certificate (if not 70+)']);

  // --- 3. PM Ujjwala Yojana 2.0 — free LPG connection for BPL women ---
  await upsertScheme({
    name: 'PM Ujjwala Yojana 2.0 (Free LPG Connection)',
    description: 'Free LPG (cooking gas) connection for adult women from low-income households who don\u2019t already have one, covering the security deposit and first refill.' + DISCLAIMER + ' Real eligibility is BPL/SECC-2011 status verified against the ration card and Oil Marketing Company records, which this demo approximates with an income threshold.',
    department: 'Ministry of Petroleum & Natural Gas',
    level: 'Central',
    state: 'All',
    category: 'Welfare',
    benefits: 'Free LPG connection (deposit-free cylinder + free pressure regulator), worth approximately ₹1,600',
    start_date: '2021-08-10',
    end_date: '2027-03-31',
    official_url: 'https://pmuy.gov.in',
    application_instructions: 'Apply at your nearest LPG distributor with KYC form, ration card, Aadhaar, and bank passbook. Migrants without a ration card can use a self-declaration under Ujjwala 2.0.',
    contact_info: 'LPG Helpline: 1906'
  }, [
    { logic_type: 'AND', conditions: [
      { field: 'gender', operator: '=', value: 'Female' },
      { field: 'age', operator: '>=', value: '18' },
      { field: 'annual_income', operator: '<=', value: '200000' }
    ]}
  ], ['Aadhaar Card', 'Ration Card', 'Bank Passbook']);

  // --- 4. IGNOAPS — Indira Gandhi National Old Age Pension Scheme ---
  await upsertScheme({
    name: 'Indira Gandhi National Old Age Pension Scheme (IGNOAPS)',
    description: 'Monthly non-contributory pension for senior citizens from Below Poverty Line households, with no regular means of financial support.' + DISCLAIMER + ' Real eligibility is BPL-list based, approximated here with an income threshold.',
    department: 'Ministry of Rural Development (National Social Assistance Programme)',
    level: 'Central',
    state: 'All',
    category: 'Social Welfare',
    benefits: '₹200/month (ages 60–79), ₹500/month (age 80+) from the Centre — many states add a top-up',
    start_date: '1995-08-15',
    end_date: '2029-03-31',
    official_url: 'https://nsap.nic.in',
    application_instructions: 'Apply at the Gram Panchayat / Block Development Office (rural) or Municipal / District Social Welfare Office (urban) with age and BPL proof.',
    contact_info: 'Contact your local Social Welfare Department'
  }, [
    { logic_type: 'AND', conditions: [
      { field: 'age', operator: '>=', value: '60' },
      { field: 'annual_income', operator: '<=', value: '200000' }
    ]}
  ], ['Age Proof', 'BPL Card / Ration Card', 'Bank Passbook']);

  // --- 5. PMAY-Gramin — rural housing ---
  await upsertScheme({
    name: 'Pradhan Mantri Awas Yojana – Gramin (Rural Housing)',
    description: 'Financial assistance to build a pucca house for rural households that are houseless or living in a kutcha/dilapidated house.' + DISCLAIMER + ' Real beneficiary selection is via the SECC-2011 list and Awaas+ survey verified by the Gram Sabha, not open online application — this demo approximates eligibility with an income threshold and does not check house-ownership/SECC status.',
    department: 'Ministry of Rural Development',
    level: 'Central',
    state: 'All',
    category: 'Housing',
    benefits: '₹1.20 lakh (plain areas) or ₹1.30 lakh (hilly/difficult areas) plus MGNREGA wage convergence for construction labour',
    start_date: '2016-04-01',
    end_date: '2029-03-31',
    official_url: 'https://pmayg.nic.in',
    application_instructions: 'Beneficiaries are identified via the SECC-2011/Awaas+ list verified by the Gram Sabha — contact your Gram Panchayat or Block Development Office to check or request inclusion.',
    contact_info: 'Contact your Gram Panchayat / Block Development Office'
  }, [
    { logic_type: 'AND', conditions: [
      { field: 'annual_income', operator: '<=', value: '180000' }
    ]}
  ], ['Aadhaar Card', 'Bank Passbook', 'MGNREGA Job Card (if available)']);

  // --- 6. PMMVY — maternity benefit ---
  await upsertScheme({
    name: 'Pradhan Mantri Matru Vandana Yojana (PMMVY)',
    description: 'Cash incentive for pregnant and lactating mothers to help offset wage loss around childbirth and encourage antenatal care, institutional delivery, and immunization.' + DISCLAIMER + ' The real scheme also covers this via SC/ST status, 40%+ disability, BPL ration card, or PM-JAY/e-Shram/MGNREGA registration even above the income line — none of which this demo checks, and it does not track pregnancy/child-birth events at all.',
    department: 'Ministry of Women & Child Development',
    level: 'Central',
    state: 'All',
    category: 'Welfare',
    benefits: '₹5,000 for the first living child (2 installments); an additional ₹6,000 for a second child if the child is a girl',
    start_date: '2017-01-01',
    end_date: '2029-03-31',
    official_url: 'https://pmmvy.wcd.gov.in',
    application_instructions: 'Register at your nearest Anganwadi Centre or approved health facility with Form 1A, Aadhaar, and bank account details as early in pregnancy as possible.',
    contact_info: 'Contact your local Anganwadi Centre'
  }, [
    { logic_type: 'AND', conditions: [
      { field: 'gender', operator: '=', value: 'Female' },
      { field: 'age', operator: '>=', value: '19' },
      { field: 'annual_income', operator: '<=', value: '800000' }
    ]}
  ], ['Aadhaar Card', 'Pregnancy/Birth Registration (MCP Card)', 'Bank Passbook']);

  // --- 7. IGNDPS — disability pension ---
  await upsertScheme({
    name: 'Indira Gandhi National Disability Pension Scheme (IGNDPS)',
    description: 'Monthly pension for people with severe disability (80% or more) from Below Poverty Line households.' + DISCLAIMER + ' The real scheme requires a certified disability level of 80%+ specifically, which this demo approximates with a simple Yes/No disability flag, and BPL status is approximated with an income threshold.',
    department: 'Ministry of Rural Development (National Social Assistance Programme)',
    level: 'Central',
    state: 'All',
    category: 'Social Welfare',
    benefits: '₹300/month (ages 18–79), ₹500/month (age 80+) from the Centre — many states add a substantial top-up',
    start_date: '2009-02-01',
    end_date: '2029-03-31',
    official_url: 'https://nsap.nic.in',
    application_instructions: 'Apply at the Block Development Office / Municipal Office / Collector\u2019s Office with a certified disability certificate, BPL proof, Aadhaar, and bank details.',
    contact_info: 'Contact your local Social Welfare / Social Security Department'
  }, [
    { logic_type: 'AND', conditions: [
      { field: 'age', operator: '>=', value: '18' },
      { field: 'age', operator: '<=', value: '79' },
      { field: 'disability_status', operator: '=', value: 'Yes' },
      { field: 'annual_income', operator: '<=', value: '200000' }
    ]}
  ], ['Disability Certificate (80%+)', 'BPL Card / Ration Card', 'Aadhaar Card', 'Bank Passbook']);

  // --- 8. PM Mudra Yojana — business loans ---
  await upsertScheme({
    name: 'Pradhan Mantri Mudra Yojana (PMMY) – Business Loans',
    description: 'Collateral-free loans up to ₹20 lakh for non-farm micro and small enterprises — covering trading, manufacturing, and services businesses, from early-stage (Shishu) to established (Tarun/Tarun Plus).' + DISCLAIMER + ' This is a loan scheme, not an income-based grant — the real qualifying factor is having (or starting) an eligible non-farm business, which this demo cannot verify, so eligibility here is approximated using age alone.',
    department: 'Department of Financial Services, Ministry of Finance',
    level: 'Central',
    state: 'All',
    category: 'Employment',
    benefits: 'Collateral-free loans: Shishu (up to ₹50,000), Kishore (₹50,000–5 lakh), Tarun (₹5–10 lakh), Tarun Plus (up to ₹20 lakh)',
    start_date: '2015-04-08',
    end_date: '2029-03-31',
    official_url: 'https://www.mudra.org.in',
    application_instructions: 'Apply through any participating bank, NBFC, or microfinance institution with a business plan, ID/address proof, and business proof (if already operating).',
    contact_info: 'Mudra Helpline: 1800-180-1111'
  }, [
    { logic_type: 'AND', conditions: [
      { field: 'age', operator: '>=', value: '18' },
      { field: 'age', operator: '<=', value: '65' }
    ]}
  ], ['Aadhaar Card', 'PAN Card', 'Business Plan / Proof of Business', 'Bank Statements (last 6 months, if applicable)']);

  console.log('\nDone. Real scheme data upgraded — reload the Discover page to see the changes.');
  await pool.end();
}

main().catch(async (e) => {
  console.error('\nFailed:', e.message);
  try { await pool.end(); } catch (_) {}
  process.exit(1);
});
