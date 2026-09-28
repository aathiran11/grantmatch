const { db } = require('./db');

/**
 * Field extractor: builds a normalized profile object used for rule evaluation.
 */
function buildProfileForEval(profile) {
  const age = profile.date_of_birth ? calcAge(profile.date_of_birth) : null;
  return {
    age,
    annual_income: profile.annual_income ?? null,
    occupation: (profile.occupation || '').toLowerCase(),
    state: (profile.state || '').toLowerCase(),
    gender: (profile.gender || '').toLowerCase(),
    category: (profile.category || '').toLowerCase(),
    disability_status: (profile.disability_status || 'no').toLowerCase(),
    education: (profile.education || '').toLowerCase(),
    family_members: profile.family_members ?? null,
    land_owner: (profile.land_owner || 'no').toLowerCase()
  };
}

function calcAge(dobStr) {
  const dob = new Date(dobStr);
  if (isNaN(dob)) return null;
  const diff = Date.now() - dob.getTime();
  return Math.floor(diff / (1000 * 60 * 60 * 24 * 365.25));
}

function compare(actual, operator, expected) {
  if (actual === null || actual === undefined || actual === '') return false;

  // numeric comparison if both look numeric
  const numActual = parseFloat(actual);
  const numExpected = parseFloat(expected);
  const bothNumeric = !isNaN(numActual) && !isNaN(numExpected) && typeof actual !== 'string' || (!isNaN(numActual) && !isNaN(numExpected));

  switch (operator) {
    case '>=':
      return bothNumeric ? numActual >= numExpected : String(actual) >= String(expected);
    case '<=':
      return bothNumeric ? numActual <= numExpected : String(actual) <= String(expected);
    case '>':
      return bothNumeric ? numActual > numExpected : String(actual) > String(expected);
    case '<':
      return bothNumeric ? numActual < numExpected : String(actual) < String(expected);
    case '=':
      if (bothNumeric) return numActual === numExpected;
      return String(actual).toLowerCase().trim() === String(expected).toLowerCase().trim();
    case '!=':
      if (bothNumeric) return numActual !== numExpected;
      return String(actual).toLowerCase().trim() !== String(expected).toLowerCase().trim();
    default:
      return false;
  }
}

function fieldDisplayName(field) {
  const map = {
    age: 'Age',
    annual_income: 'Annual Income',
    occupation: 'Occupation',
    state: 'State',
    gender: 'Gender',
    category: 'Category',
    disability_status: 'Disability Status',
    education: 'Education',
    family_members: 'Family Members',
    land_owner: 'Land Ownership'
  };
  return map[field] || field;
}

/**
 * Evaluate a single scheme's rule groups against a user profile.
 * Rule groups are combined with AND across groups.
 * Within a group, conditions combine using the group's logic_type (AND/OR).
 *
 * Returns: { eligible, totalConditions, metConditions, groups: [...], reasons: [...] }
 */
async function evaluateScheme(schemeId, rawProfile) {
  const profile = buildProfileForEval(rawProfile);

  const groups = await db.prepare('SELECT * FROM rule_groups WHERE scheme_id = ?').all(schemeId);

  if (groups.length === 0) {
    return { eligible: true, totalConditions: 0, metConditions: 0, groups: [], reasons: ['No eligibility rules defined — open to all.'] };
  }

  let allGroupsPass = true;
  let totalConditions = 0;
  let metConditions = 0;
  const groupResults = [];

  for (const group of groups) {
    const conditions = await db.prepare('SELECT * FROM eligibility_rules WHERE group_id = ?').all(group.id);
    const condResults = conditions.map(c => {
      const actual = profile[c.field];
      const passed = compare(actual, c.operator, c.value);
      totalConditions++;
      if (passed) metConditions++;
      return {
        field: c.field,
        fieldLabel: fieldDisplayName(c.field),
        operator: c.operator,
        expected: c.value,
        actual: actual,
        passed,
        label: c.label
      };
    });

    let groupPass;
    if (group.logic_type === 'OR') {
      groupPass = condResults.some(r => r.passed);
    } else {
      groupPass = condResults.every(r => r.passed);
    }
    if (!groupPass) allGroupsPass = false;

    groupResults.push({ logic_type: group.logic_type, conditions: condResults, passed: groupPass });
  }

  const reasons = [];
  for (const g of groupResults) {
    for (const c of g.conditions) {
      if (c.passed) {
        reasons.push({ type: 'pass', text: `${c.fieldLabel} requirement met (need ${c.operator} ${c.expected})` });
      } else {
        reasons.push({ type: 'fail', text: `${c.fieldLabel} requirement not met — needs ${c.operator} ${c.expected}, your value: ${c.actual === null || c.actual === '' ? 'not provided' : c.actual}` });
      }
    }
  }

  return {
    eligible: allGroupsPass,
    totalConditions,
    metConditions,
    groups: groupResults,
    reasons
  };
}

/**
 * Evaluate ALL active schemes for a user profile, returning sorted matches.
 */
async function evaluateAllSchemes(rawProfile, filters = {}) {
  let query = 'SELECT * FROM schemes WHERE status = ?';
  const params = ['Active'];

  if (filters.state) {
    query += ' AND (state = ? OR state = ?)';
    params.push(filters.state, 'All');
  }
  if (filters.category) {
    query += ' AND category ILIKE ?';
    params.push(filters.category);
  }
  if (filters.search) {
    query += ' AND (name ILIKE ? OR description ILIKE ?)';
    params.push(`%${filters.search}%`, `%${filters.search}%`);
  }

  const schemes = await db.prepare(query).all(...params);

  const results = [];
  for (const scheme of schemes) {
    const evalResult = await evaluateScheme(scheme.id, rawProfile);
    results.push({ scheme, evalResult });
  }

  // Sort: eligible first, then by % of conditions met
  results.sort((a, b) => {
    if (a.evalResult.eligible !== b.evalResult.eligible) return a.evalResult.eligible ? -1 : 1;
    const pctA = a.evalResult.totalConditions ? a.evalResult.metConditions / a.evalResult.totalConditions : 1;
    const pctB = b.evalResult.totalConditions ? b.evalResult.metConditions / b.evalResult.totalConditions : 1;
    return pctB - pctA;
  });

  return results;
}

module.exports = { evaluateScheme, evaluateAllSchemes, buildProfileForEval, calcAge };
