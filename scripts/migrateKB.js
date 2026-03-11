// scripts/migrateKB.js — node scripts/migrateKB.js (runs on every deployment)
const fs   = require('fs');
const path = require('path');

const SRC  = './knowledge_base';
const DEST = './kb/json';  // FLAT — no sub-folders

// ─── INVARIANT 1 ─── Canonical ID ──────────────────────────────────────────
// Input : any filename stem (mixed case, spaces, hyphens OK)
// Output: stable lowercase slug WITHOUT type-token
// e.g. "32_IV_IVC_HIGH_DOSE_Monograph_v3" → "32_iv_ivc_high_dose_v3"
// Rule: type tokens (monograph, protocol, policy) live in the JSON "type" field, NOT the id.
const TYPE_TOKENS = ['monograph', 'protocol', 'policy'];  // stripped from id slug
function canonicalId(stem) {
  let slug = stem
    .toLowerCase()
    .replace(/[\s\-]+/g, '_')   // spaces/hyphens → underscore
    .replace(/[^a-z0-9_]/g, ''); // strip everything else
  for (const tok of TYPE_TOKENS)
    slug = slug.replace(new RegExp(`_${tok}(?=_|$)`, 'g'), '');
  return slug.replace(/_{2,}/g, '_').replace(/^_|_$/g, ''); // clean artefacts
}

// ─── INVARIANT 3 ─── Fixed section key map ─────────────────────────────────
// Section numbers 0-5 map to normalised key names.
// VISIBILITY is read from the SECTION header line only — never from the body.
const SECTION_KEYS = {
  '0': 's0_quick_reference_internal',
  '1': 's1_claims_discipline_internal',
  '2': 's2_patient_communication',  // suffix added after VISIBILITY check
  '3': 's3_pharmacokinetics_adme_internal',
  '4': 's4_limitations_failure_modes_internal',
  '5': 's5_clinical_decision_trees_internal',
};

function parseSections(raw, file) {  // file passed for error context
  const content = {};
  // Match: "=== SECTION 2 [— ANYTHING] [PATIENT_OK] ===" followed by body until next === or EOF
  // C1 fix: \Z is Python-only — in JS use (?![\s\S]) to match end-of-string
  const re = /^={3,}[ \t]*SECTION[ \t]+(\d+)([^\n]*)\n([\s\S]*?)(?=^={3,}|(?![\s\S]))/gm;
  let m;
  while ((m = re.exec(raw)) !== null) {
    const num      = m[1];
    const header   = m[2];                         // rest of header line
    const isPublic = header.includes('PATIENT_OK');  // ONLY from header, never body
    const body     = m[3].trim();
    let key        = SECTION_KEYS[num];
    if (!key) { console.warn(`  ⚠ Unknown section ${num} — skipped`); continue; }
    // ─── Compile-time VISIBILITY guards (throw = blocks deploy) ──────────
    if (isPublic && num !== '2') {
      throw new Error(
        `[migrateKB] VISIBILITY ERROR in ${file}: [PATIENT_OK] on SECTION ${num} — ` +
        'only SECTION 2 (patient communication) may be public. Fix the .txt file.'
      );
    }
    if (num === '2' && !isPublic) {
      throw new Error(
        `[migrateKB] VISIBILITY ERROR in ${file}: SECTION 2 is missing [PATIENT_OK] — ` +
        'patient-facing section must be explicitly marked. Add [PATIENT_OK] to the SECTION 2 header.'
      );
    }
    // Section 2 suffix depends on header flag; all others have fixed suffix already
    if (num === '2') key += isPublic ? '_public' : '_internal';
    content[key] = body;
  }
  // MIN-3: require SECTION 0 (quick_ref) and SECTION 2 (patient_comms) — silently incomplete KB is a clinical hazard
  const REQUIRED_SECTIONS = ['0', '2'];
  for (const num of REQUIRED_SECTIONS) {
    if (!Object.keys(content).some(k => k.startsWith(`s${num}_`)))
      throw new Error(`[migrateKB] MISSING required SECTION ${num} in ${file}`);
  }
  return content;
}

// ─── BUILD ──────────────────────────────────────────────────────────────────
fs.mkdirSync(DEST, { recursive: true });

const files   = fs.readdirSync(SRC).filter(f => f.endsWith('.txt'));
const index   = [];
const seenIds = new Set();

files.forEach(file => {
  const raw  = fs.readFileSync(path.join(SRC, file), 'utf8');
  const id   = canonicalId(path.basename(file, '.txt'));

  // Collision guard — two source files must not produce the same canonical id
  if (seenIds.has(id)) throw new Error(`Duplicate canonical id: ${id} (from ${file})`);
  seenIds.add(id);

  // Fix G — header parser handles both "# TAGS: ..." and "TAGS: ..." formats
  const getMeta  = (k) => (raw.match(new RegExp(`^#?\\s*${k}:\\s*(.+)`, 'mi'))?.[1] ?? '').trim();
  const version  = getMeta('VERSION') || '1.0';
  const tags     = getMeta('TAGS').split(',').map(t => t.trim()).filter(Boolean);
  const content  = parseSections(raw, file);  // file in scope (forEach param)

  const obj = {
    id, version, status: 'active',
    metadata: {
      tags, category:              getMeta('CATEGORY'),
      intervention_priority:       getMeta('INTERVENTION_PRIORITY'),
      coupled_systems:             getMeta('COUPLED_SYSTEMS').split(',').map(s => s.trim()).filter(Boolean),
    },
    content,
  };

  const absPath  = path.join(DEST, `${id}.json`);
  // Store RELATIVE path from repo root — kbRetriever resolves via path.resolve(repoRoot, entry.filepath)
  const relPath  = path.relative(process.cwd(), absPath);  // e.g. "kb/json/32_iv_ivc_high_dose_v3.json"
  fs.writeFileSync(absPath, JSON.stringify(obj, null, 2));
  index.push({ id, version, tags, filepath: relPath });  // relative — never absolute
  console.log(`  ✓ ${file.padEnd(50)} → id: ${id}`);
});

// index.json canonical format: { generated_at, count, entries: [...] }
// getIndex() in kbRetriever parses .entries — do not change this structure.
const indexDoc = {
  generated_at: new Date().toISOString(),
  count: files.length,
  entries: index,
};
fs.writeFileSync(path.join(DEST, 'index.json'), JSON.stringify(indexDoc, null, 2));
console.log(`\n✅ KB compiled — ${files.length} files → ${DEST}/index.json`);

// ─── ACCEPTANCE TEST ────────────────────────────────────────────────────────
// Run: node -e "require('./scripts/migrateKB'); const doc = require('./kb/json/index.json');
//   doc.entries.forEach(e => { if (/[A-Z]/.test(e.id)) throw new Error('FAIL: uppercase in id: ' + e.id); });
//   console.log('✅ acceptance: all IDs lowercase, count=' + doc.count);"