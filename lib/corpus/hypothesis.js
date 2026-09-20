// Bounded explanations for co-mention connections — MODEL-WRITTEN, GOVERNED.
//
// connections.js establishes that a vessel, a restaurant and a hospital appear in
// the same public reporting. It cannot say why, and neither can any database. The
// interesting reading — a shared exposure event before departure — is a
// hypothesis, and a hypothesis about named real businesses is the single most
// dangerous thing this application can emit.
//
// So this file treats model output as untrusted input, not as an answer:
//
//   1. The prompt states the rules.
//   2. Every returned hypothesis is structurally validated against those same
//      rules, because a prompt is a request and not a guarantee.
//   3. Every survivor must then pass govern(). A rejected hypothesis is DROPPED.
//      Not downgraded, not flagged, not returned with a warning for the UI to
//      render smaller. Dropped.
//   4. Whatever survives carries `unverified: true` and its governor verdict, so
//      an operator reading it can see it was speculation that passed review, and
//      an auditor can see what reviewed it.
//
// There is NO deterministic fallback in this file, and that asymmetry is
// deliberate. When the model is unreachable, assess.js writes a template summary
// because a summary restates facts that are already established. A hypothesis
// establishes nothing — it is speculation about named parties, and a template
// that speculates on their behalf ("the outbreak may be linked to X") is worse
// than silence, not better. Unreachable model means no hypotheses. Empty array.

import { chat } from '../llm.js';

// Batch generation producing a complete artefact in one pass. Not `judge`: a
// hypothesis is stored and shown to an operator, and the shared client's
// guidance is that judge must not be used where a mistake becomes a stored fact.
const ROLE = 'author';

const MAX_HYPOTHESES = 5;
const MAX_SNIPPET = 400;
const MIN_STATEMENT_CHARS = 40;
const MIN_ACTION_CHARS = 25;

const SYSTEM = `You propose bounded hypotheses for an open-source intelligence tool.

You are given entities that appear together in public documents, and those
documents. Co-mention is ALL you have. Nothing in the input establishes that any
two entities are actually related — only that open sources mentioned them
together. Your job is to name what that co-occurrence MIGHT indicate, and to say
exactly what evidence would settle it.

Absolute rules:
- CO-OCCURRENCE IS NOT CAUSATION. Every statement must hedge with one of:
  "may indicate", "one reading is", "consistent with", "may suggest",
  "could indicate". A statement asserting that something IS the case is invalid.
- NEVER attribute fault, blame, negligence, wrongdoing, criminality, dishonesty
  or incompetence to any named party. These are real businesses, real hospitals
  and real crews. You are describing a pattern in public reporting, not making an
  allegation about anyone.
- confirms_if and refutes_if are mandatory, and must each be a CONCRETE,
  CHECKABLE action a person could actually carry out. "Compare health-district
  notification dates against the vessel's departure time" is valid. "Further
  investigation" or "more data is needed" is not, and makes the hypothesis
  worthless.
- Cite ONLY the document ids you were given. Never invent an id, a URL, a date,
  a name or a number.
- Reference ONLY the entity keys you were given, exactly as written.
- One or two sentences per statement. Plain professional English.

Return ONLY a JSON object:
{"hypotheses":[{"entity_keys":["<key>"],"statement":"<text>",
"confirms_if":"<concrete check>","refutes_if":"<concrete check>",
"document_ids":["<id>"]}]}`;

// A statement has to carry one of these. The list is deliberately short: the
// point is to catch confident phrasing, and a generous synonym list would let
// "clearly shows" through on the strength of a stray "possibly" elsewhere.
const HEDGES = [
  'may indicate', 'may suggest', 'may be', 'may reflect', 'may relate',
  'one reading is', 'consistent with', 'could indicate', 'could suggest',
  'could reflect', 'might indicate', 'might suggest', 'appears consistent',
  'may point', 'may correspond',
];

// Fault vocabulary. Checked structurally as well as by the prompt and the
// governor, because this is the failure that cannot be walked back: an
// unverified accusation against a named restaurant is defamatory the moment it
// renders, and no downstream flag undoes it. Fail closed — dropping a legitimate
// hypothesis costs an operator one idea they can have themselves.
const FAULT_TERMS = [
  'negligen', 'liable', 'liability', 'criminal', 'crime', 'fraud', 'fraudulent',
  'illegal', 'unlawful', 'at fault', 'blame', 'culpab', 'malpractice',
  'misconduct', 'wrongdoing', 'cover-up', 'covered up', 'concealed', 'conceal',
  'reckless', 'prosecut', 'guilty', 'violation', 'violated', 'breach of',
  'failed to', 'failure to', 'responsible for', 'caused by', 'to blame',
  'incompeten', 'lied', 'misled', 'deliberately', 'knowingly',
];

// Non-actions. These are what a model reaches for when it has no real test in
// mind, and a hypothesis whose confirms_if is "investigate further" is not a
// hypothesis — it has no failure condition, so it can never be wrong.
const VAGUE_ACTIONS = [
  'further investigation', 'further research', 'investigate further',
  'more investigation', 'additional investigation', 'more research',
  'more data', 'more information', 'further data', 'further information',
  'follow up', 'follow-up', 'look into', 'to be determined', 'tbd',
  'additional analysis', 'further analysis', 'unknown', 'n/a',
];

const URL_RE = /https?:\/\/[^\s<>"')\]]+/g;

// Accepts the shapes both callers use: service.js passes {key,type,label},
// connections.js results are {entity_key,entity_type,entity_label}, and a plain
// string is allowed too.
function entityKeyOf(entity) {
  if (typeof entity === 'string') return entity;
  return entity?.entity_key || entity?.key || null;
}
function entityLabelOf(entity) {
  if (typeof entity === 'string') return entity;
  return entity?.entity_label || entity?.label || entityKeyOf(entity);
}
function entityTypeOf(entity) {
  if (typeof entity === 'string') return null;
  return entity?.entity_type || entity?.type || null;
}

function containsAny(text, terms) {
  const lower = text.toLowerCase();
  return terms.some((term) => lower.includes(term));
}

// Content-addressed id: the same hypothesis over the same evidence keeps the
// same id across runs, so a re-run can be diffed against the last one instead of
// looking like five brand-new claims.
function hypothesisId(statement, entityKeys, documentIds) {
  const canonical = [statement.trim().toLowerCase(), [...entityKeys].sort().join(','), [...documentIds].sort().join(',')].join('|');
  let hash = 0x811c9dc5;
  for (let i = 0; i < canonical.length; i += 1) {
    hash ^= canonical.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `hyp_${hash.toString(16).padStart(8, '0')}`;
}

// The default model adapter: a local OpenAI-compatible endpoint, same shape as
// lib/ontology/llm.js and lib/casefiles/assess.js. Returns the raw content
// string, or null when the endpoint is off, unreachable, slow or unhappy.
async function defaultCallModel({ system, user }) {
  if (process.env.ONTOLOGY_LLM === 'off') return null;

  const r = await chat(
    ROLE,
    [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    {
      app: 'philotas/hypothesis',
      // noThinking: reached from GET /api/intel via corpus/service.js, so a
      // user is waiting. Reasoning costs roughly 17x here for no gain the
      // operator can see.
      noThinking: true,
      temperature: 0.3,
      maxTokens: 1200,
      // A slow model must never hold up the panel. Hypotheses are the optional
      // layer; the documents and connections are already on screen.
      timeoutMs: 25_000,
      extra: { response_format: { type: 'json_object' } },
    }
  );
  // r.text carries the reasoning-channel fallback, so a null `content` no
  // longer reads as "the model had nothing to say".
  return r.text || null;
}

function parseHypotheses(text) {
  if (typeof text !== 'string' || text.trim() === '') return null;
  try {
    const obj = JSON.parse(text);
    if (Array.isArray(obj)) return obj;
    if (Array.isArray(obj?.hypotheses)) return obj.hypotheses;
    return null;
  } catch { /* fall through */ }
  // Some local servers wrap JSON in prose despite response_format. Recover the
  // object rather than throwing away a whole cycle's work.
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      const obj = JSON.parse(text.slice(start, end + 1));
      if (Array.isArray(obj?.hypotheses)) return obj.hypotheses;
    } catch { /* ignore */ }
  }
  return null;
}

// Structural quarantine. Everything here is also stated in the prompt; it is
// re-checked because a prompt is a request, and this layer is where a request
// becomes a guarantee. Returns a normalised candidate or null.
function validate(raw, { allowedKeys, allowedDocIds, allowedUrls }) {
  if (!raw || typeof raw !== 'object') return null;

  const statement = typeof raw.statement === 'string' ? raw.statement.trim() : '';
  const confirmsIf = typeof raw.confirms_if === 'string' ? raw.confirms_if.trim() : '';
  const refutesIf = typeof raw.refutes_if === 'string' ? raw.refutes_if.trim() : '';

  if (statement.length < MIN_STATEMENT_CHARS) return null;

  // Hedging is not a style preference here. An unhedged sentence about a named
  // hospital and a named restaurant reads as a finding, and this is not one.
  if (!containsAny(statement, HEDGES)) return null;

  // Both tests are mandatory and both must be real actions.
  if (confirmsIf.length < MIN_ACTION_CHARS || refutesIf.length < MIN_ACTION_CHARS) return null;
  if (containsAny(confirmsIf, VAGUE_ACTIONS) || containsAny(refutesIf, VAGUE_ACTIONS)) return null;
  // A hypothesis whose two tests are the same sentence has only one test.
  if (confirmsIf.toLowerCase() === refutesIf.toLowerCase()) return null;

  const wholeText = `${statement} ${confirmsIf} ${refutesIf}`;
  if (containsAny(wholeText, FAULT_TERMS)) return null;

  // Any URL in the prose must be one we supplied. Catches a model quoting a
  // source from its training data as though it were evidence in this corpus.
  for (const url of wholeText.match(URL_RE) || []) {
    if (!allowedUrls.has(url.replace(/[.,;]+$/, ''))) return null;
  }

  // Only cite what was supplied — filtered, not rejected wholesale, so one
  // hallucinated id does not discard an otherwise well-evidenced hypothesis.
  // But a hypothesis left citing nothing has no evidence and cannot stand.
  const documentIds = [...new Set(Array.isArray(raw.document_ids) ? raw.document_ids : [])]
    .filter((id) => allowedDocIds.has(id));
  if (documentIds.length === 0) return null;

  const entityKeys = [...new Set(Array.isArray(raw.entity_keys) ? raw.entity_keys : [])]
    .filter((key) => allowedKeys.has(key));
  if (entityKeys.length === 0) return null;

  return { statement, confirms_if: confirmsIf, refutes_if: refutesIf, document_ids: documentIds, entity_keys: entityKeys };
}

/**
 * Propose bounded, governed hypotheses about why a set of entities co-occur.
 *
 * @param {object}   input
 * @param {Array}    input.entities   {key,type,label} or {entity_key,...} or string
 * @param {Array}    input.documents  {id,url,title,source,published_ms,snippet}
 * @param {string}   input.region
 * @param {Function} [input.callModel] injected for tests; ({system,user}) => string|null
 * @param {Function} [input.govern]    injected for tests; defaults to governor.js
 * @param {Function} [input.now]       injected for tests
 * @returns {Promise<Array>} hypotheses, every one `unverified: true`
 */
export async function proposeHypotheses({
  entities,
  documents,
  region,
  callModel,
  govern,
  now = Date.now,
  maxHypotheses = MAX_HYPOTHESES,
} = {}) {
  const entityList = (entities || []).filter((e) => entityKeyOf(e));
  const docList = (documents || []).filter((d) => d && d.id);
  // Nothing to explain, or nothing to cite. Either way there is no hypothesis to
  // be had, and no reason to spend a model call finding that out.
  if (entityList.length === 0 || docList.length === 0) return [];

  const allowedKeys = new Set(entityList.map(entityKeyOf));
  const allowedDocIds = new Set(docList.map((d) => d.id));
  const allowedUrls = new Set(docList.map((d) => d.url).filter(Boolean));
  const docsById = new Map(docList.map((d) => [d.id, d]));

  const user = [
    `Region: ${region || 'unspecified'}`,
    '',
    'Entities that co-occur in these documents:',
    JSON.stringify(entityList.map((e) => ({
      entity_key: entityKeyOf(e), type: entityTypeOf(e), label: entityLabelOf(e),
    }))),
    '',
    'Documents (cite by id, and only these):',
    JSON.stringify(docList.map((d) => ({
      id: d.id,
      title: d.title,
      source: d.source,
      published: Number.isFinite(d.published_ms) ? new Date(d.published_ms).toISOString() : null,
      snippet: typeof d.snippet === 'string' ? d.snippet.slice(0, MAX_SNIPPET) : null,
    }))),
    '',
    `Propose at most ${maxHypotheses} hypotheses.`,
  ].join('\n');

  let rawText;
  try {
    rawText = await (callModel || defaultCallModel)({ system: SYSTEM, user });
  } catch {
    // Unreachable, timed out, refused. No fallback — see the file header.
    return [];
  }

  const candidates = parseHypotheses(rawText);
  // Nothing proposed, or nothing parseable. Resolve the governor only when there
  // is actually something for it to rule on.
  if (!candidates || candidates.length === 0) return [];

  const governFn = govern || (await import('./governor.js')).govern;
  const createdMs = now();
  const out = [];
  const seenIds = new Set();

  for (const raw of candidates.slice(0, maxHypotheses)) {
    const valid = validate(raw, { allowedKeys, allowedDocIds, allowedUrls });
    if (!valid) continue;

    const documentUrls = valid.document_ids
      .map((id) => docsById.get(id)?.url)
      .filter(Boolean);

    let verdict;
    try {
      verdict = await governFn({
        kind: 'hypothesis',
        // The governor sees the whole claim, tests included. A clean statement
        // with an accusatory refutes_if is still an accusation.
        text: `${valid.statement}\nConfirms if: ${valid.confirms_if}\nRefutes if: ${valid.refutes_if}`,
        // Scoped to the documents this hypothesis actually cites, not everything
        // supplied, so the governor is checking the claim against its own
        // evidence rather than against the corpus at large.
        allowedSourceUrls: documentUrls,
        entities: entityList.filter((e) => valid.entity_keys.includes(entityKeyOf(e))),
        region,
      });
    } catch {
      // A governor that throws has not approved anything. Fail closed.
      continue;
    }

    // The one line this whole file exists for. Rejected means gone.
    if (!verdict?.ok) continue;

    const id = hypothesisId(valid.statement, valid.entity_keys, valid.document_ids);
    if (seenIds.has(id)) continue; // same claim twice is still one claim
    seenIds.add(id);

    out.push({
      id,
      entity_keys: valid.entity_keys,
      statement: valid.statement,
      confirms_if: valid.confirms_if,
      refutes_if: valid.refutes_if,
      document_ids: valid.document_ids,
      document_urls: documentUrls,
      // Always 'llm'. The union includes 'heuristic' for consumers shared with
      // assess.js, but nothing in this file can ever produce one: there is no
      // deterministic path to a hypothesis.
      method: 'llm',
      governor: {
        verdict: verdict.verdict ?? null,
        reasons: verdict.reasons ?? [],
        checks: verdict.checks ?? null,
      },
      created_ms: createdMs,
      // Hard-coded, last, and never read from model output or options. A
      // hypothesis is not a finding, and no caller gets to say otherwise.
      unverified: true,
    });
  }

  return out;
}
