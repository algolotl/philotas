// Case-file assessment — the operator-facing narrative.
//
// This is one of the three places a model is used, and it is used strictly
// after the fact: the deterministic layer has already decided that something
// happened and produced the numbers. The model only writes the paragraph an
// operator reads. It cannot create, suppress or reclassify a case file.
//
// If the model is unreachable, a deterministic summary is written from the same
// evidence and the method is recorded as `heuristic`. Either way the method is
// surfaced in the interface, so an operator can see whether they are reading a
// model's words or a template's.

import { chat } from '../llm.js';

// Role, not a host. This is batch generation producing a complete artefact in
// one pass — the 80B `coder` does this at ~134 tok/s (vs ~35s on the 27B).
// Deliberately NOT `judge` or `chat_fast`: the 8B must not be used where a
// mistake becomes a stored fact, and an assessment is written into the case
// file and read as the record.
const ROLE = 'coder';

const SYSTEM = `You write short situation assessments for a maritime and transport
common operating picture. You are given events that a deterministic detector has
already confirmed, with the exact figures that triggered each one.

Rules:
- 2 to 3 sentences. No preamble, no heading, no bullet points.
- State what was observed, then what it could mean, then what would confirm it.
- Use the figures you are given. Never invent a number, a name, or a location.
- Distinguish observation from inference. "Consistent with" and "may indicate"
  are correct; "is" is not, unless the evidence states it directly.
- Never assert intent. A vessel that stopped transmitting has stopped
  transmitting; it has not "gone dark to avoid detection".
- Plain professional English. No dramatic language.

Return ONLY a JSON object: {"assessments":[{"i":<index>,"text":"<assessment>"}]}`;

// Deterministic fallback. Built from the same evidence the model would see, so
// the operator loses the prose but not the substance.
function templateAssessment(file) {
  const where = file.position
    ? ` near ${file.position[1].toFixed(3)}, ${file.position[0].toFixed(3)}`
    : '';
  const when = Number.isFinite(file.at_ms) ? new Date(file.at_ms).toISOString().replace('T', ' ').slice(0, 16) + 'Z' : 'an unrecorded time';
  return `${file.title}${where}, recorded ${when}. Triggered because ${file.evidence || 'an active rule matched'}. ` +
    `Recorded frames are available either side of this moment for review.`;
}

export async function assessCaseFile(files, region) {
  if (files.length === 0) return files;

  const withTemplate = files.map((f) => ({
    ...f,
    assessment: templateAssessment(f),
    assessment_method: 'heuristic',
  }));

  if (process.env.ONTOLOGY_LLM === 'off') return withTemplate;

  const items = files.map((f, i) => ({
    i,
    event: f.type,
    title: f.title,
    evidence: f.evidence,
    when: Number.isFinite(f.at_ms) ? new Date(f.at_ms).toISOString() : null,
    region: region?.name || region?.id,
  }));

  try {
    const r = await chat(
      ROLE,
      [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: `Assess these confirmed events:\n${JSON.stringify(items)}` },
      ],
      {
        app: 'philotas/casefiles',
        // noThinking: reached from GET /api/casefiles via casefiles/service.js,
        // so a user is waiting on it. Measured on this client, reasoning costs
        // roughly 17x for a task whose output is three sentences.
        noThinking: true,
        temperature: 0.2,
        // Sized to the batch, not to one assessment. At 900 tokens the JSON for
        // MAX_FILES (12) events was cut off mid-string, so every call fell back
        // to the template — 19,813 times on the trial, which was also the load
        // that fed the heap leak. The model is local, so the headroom is compute
        // rather than money.
        maxTokens: 2600,
        // A slow model must not hold up the case-file list; the template is
        // already a usable answer.
        timeoutMs: 25_000,
        extra: { response_format: { type: 'json_object' } },
      }
    );

    // The client falls through to the reasoning channel when `content` is null,
    // which is the failure this migration exists to remove: previously a null
    // content parsed to {} and the caller dropped to the template without
    // anything raising.
    const parsed = JSON.parse(r.text || '{}');
    const assessments = Array.isArray(parsed?.assessments) ? parsed.assessments : null;
    if (!assessments) return withTemplate;

    return withTemplate.map((f, i) => {
      const written = assessments.find((a) => a.i === i)?.text;
      return typeof written === 'string' && written.trim().length > 20
        ? { ...f, assessment: written.trim(), assessment_method: 'llm' }
        : f;
    });
  } catch (err) {
    // Unreachable, slow, or refused by governance: the template already covers
    // the substance. Named rather than swallowed — a bare catch here is how the
    // old code made a dead endpoint look like a model that simply had nothing
    // to add.
    console.warn(`[casefiles] assessment fell back to the template: ${err.name}: ${err.message}`);
    return withTemplate;
  }
}
