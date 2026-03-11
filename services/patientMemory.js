// services/patientMemory.js
const db = require('../db'); // no destructuring — db module exports the pool directly

async function loadPatientContext(tenantId, msisdnHash) {  // C4: tenantId added — prevents cross-tenant bleed
  const profile = await db.query(
    'SELECT * FROM patient_profiles WHERE tenant_id = $1 AND msisdn_hash = $2',
    [tenantId, msisdnHash]
  );
  if (!profile.rows[0]) return null;

  // FIX: tenant_id filter added for multi-tenant isolation
  const recentSessions = await db.query(
    `SELECT summary, chief_complaint, recommendations, follow_up_note, session_date
     FROM session_summaries WHERE tenant_id = $1 AND patient_id = $2
     ORDER BY session_date DESC LIMIT 3`,
    [tenantId, profile.rows[0].id]
  );
  return { profile: profile.rows[0], recentSessions: recentSessions.rows };
}

function formatPatientContext({ profile, recentSessions }) {
  let ctx = `PATIENT CONTEXT (hard memory — treat as known facts, never re-ask):\n`;
  ctx += `Name: ${profile.first_name} | Age: ${profile.age} | Sex: ${profile.sex}\n`;
  ctx += `Location: ${profile.location} | Language: ${profile.language} | Track: ${profile.track || 'unknown'}\n`;

  if (profile.allergies?.length)
    ctx += `Allergies: ${profile.allergies.join(', ')}\n`;
  if (profile.conditions?.length)
    ctx += `Conditions: ${profile.conditions.join(', ')}\n`;
  if (profile.medications?.length)
    ctx += `Medications: ${JSON.stringify(profile.medications)}\n`;
  if (profile.last_labs)
    ctx += `Last labs (${profile.last_labs_date}): ${JSON.stringify(profile.last_labs)}\n`;
  if (profile.terrain_flags)
    ctx += `Terrain: ${JSON.stringify(profile.terrain_flags)}\n`;
  if (profile.follow_up_note)
    ctx += `Follow-up pending: ${profile.follow_up_note}\n`;

  if (recentSessions?.length) {
    ctx += `\nRECENT SESSIONS (last ${recentSessions.length}):\n`;
    recentSessions.forEach(s => {
      ctx += `[${s.session_date}] ${s.chief_complaint} → ${s.summary}\n`;
      if (s.follow_up_note) ctx += `  ↳ Follow-up: ${s.follow_up_note}\n`;
    });
  }
  return ctx;
}

module.exports = { loadPatientContext, formatPatientContext };