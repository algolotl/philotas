// LLM adjudication adapter for the ontology pass.
//
// NOT ON THE LINK-RESOLUTION PATH ANY MORE. lib/ontology/build.js scores
// candidate links with a cross-encoder (lib/ontology/score.js): re-measured
// 2026-08-16, the generative model takes 17,109 ms on 40 candidate pairs
// against a 20-second abort, and bge-reranker-v2-m3 scores the same pairs in
// 435 ms. This module is retained because `llmAvailable` still reports whether
// a model is configured, and because a bounded uncertainty band may be routed
// back here once the calibration gold set exists.
//
// It now sets `noThinking`, which it did not until 2026-08-16. With reasoning
// on, 40 pairs took 54,576 ms and returned prose instead of JSON, and a real
// batch of 10 took 30,746 ms — both past the 20-second abort below, so this
// module would have degraded to heuristics every single time it was called and
// the timeout would have looked like the cause. Do not remove it.
//
// It previously carried the defect that motivated the shared client: hardcoded
// host and model defaults naming a port and a model generation that had not
// existed for months. An environment override was the only thing keeping it
// alive, and without that override the call hit a dead endpoint and the caller
// degraded silently to heuristics. Nothing raised.
//
// Both defaults are now GONE rather than repointed. Resolution is through
// lib/llm.js (the provider adapter), so there is no host or model name in this
// file to go stale again.
//
// Config (env):
//   ONTOLOGY_LLM        set to "off" to force the heuristic resolver
//   AXOQUANT_LLM_HOST   override the gateway when there is no LAN access

import { chat } from '../llm.js';

// Adjudication decides whether a link is real, and a kept link is written into
// the ontology artifact as a fact with provenance. The shared client's guidance
// is explicit that `judge` must not be used where a mistake becomes a stored
// fact, so this is `assistant`.
const ROLE = 'assistant';

// Stable rubric first (benefits from vLLM/Ollama automatic prefix caching);
// only the per-cycle candidate list varies between requests.
const SYSTEM = `You are an entity-resolution adjudicator for a real-time intelligence ontology.

You are given candidate links between a NEWS HEADLINE and a live ENTITY drawn from
operational feeds (aircraft, satellites, earthquakes, fires, ground stations).
For each candidate, decide whether the headline genuinely refers to that specific
entity — not merely the same category.

Rules:
- Be conservative. Default keep=false when the match is generic or uncertain.
- A headline mentioning "an earthquake" does NOT confirm a link to a specific
  quake unless the location/magnitude plausibly matches.
- A specific identifier in the headline (callsign, place name, operator) matching
  the entity is strong evidence — keep=true with high confidence.
- confidence is your calibrated probability the link is real, 0..1.

Return ONLY a JSON object of the form:
{"verdicts":[{"i":<index>,"keep":<bool>,"confidence":<0..1>,"why":"<=12 words"}]}`;

export function llmAvailable() {
  return process.env.ONTOLOGY_LLM !== 'off';
}

// candidates: [{ headline, entity, hint }]  (index-aligned with the caller)
// returns:    [{ i, keep, confidence, why }]  or null if unavailable/failed
export async function llmAdjudicate(candidates) {
  if (!llmAvailable() || candidates.length === 0) return null;

  const items = candidates.map((x, i) => ({ i, headline: x.headline, entity: x.entity, hint: x.hint }));

  try {
    const r = await chat(
      ROLE,
      [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: `Adjudicate these candidate links:\n${JSON.stringify(items)}` },
      ],
      {
        app: 'philotas/ontology',
        temperature: 0,
        maxTokens: 2048,
        // Reasoning off, and the timeout below depends on it. Measured
        // 2026-08-16 on a real batch of ADJUDICATION_BATCH_CAP = 10 candidates:
        //
        //   noThinking     5,698 ms    595 tokens   10 verdicts
        //   reasoning on  30,746 ms  1,646 tokens   10 verdicts
        //
        // So with reasoning on this call aborts at the 20 s ceiling every single
        // time, and the abort looks like a slow endpoint rather than like a
        // budget spent thinking. This output is parsed as JSON, which is exactly
        // the case where finishing beats deliberating.
        noThinking: true,
        // Never let a cycle hang on a slow model. 20 s is 3.5x the measured
        // noThinking figure above, not a round number picked for comfort.
        timeoutMs: 20_000,
        extra: { response_format: { type: 'json_object' } },
      }
    );

    // Empty text has two causes now and they need different fixes, so do not
    // let them share one message.
    //
    // @axoquant/llm 0.2.1 added a length guard: when the token budget dies
    // inside the reasoning channel there is no answer, only truncated
    // chain-of-thought with no closing tag, and the client returns empty text
    // rather than handing that back as the verdict. Verified against 0.2.0 on
    // 2026-08-16, same prompt and a 120-token budget: 0.2.0 returned
    // "We need answer user's request. Need output ONLY JSON object {..." and
    // JSON.parse threw on it; 0.2.1 returned "".
    //
    // The guard is right and the silence is the problem. An empty string here
    // reads identically to a model with nothing to say, and this file's whole
    // history is failures that looked like opinions. The finish reason is not
    // exposed on the response object — only at raw.choices[0].finish_reason —
    // so this is the one place that digs for it.
    if (!r.text || r.text.trim() === '') {
      const finishReason = r.raw?.choices?.[0]?.finish_reason ?? 'unknown';
      console.warn(
        finishReason === 'length'
          ? `[ontology] adjudication returned nothing: the token budget was consumed before an answer was emitted (finish_reason=length, ${r.totalTokens} tokens). Raise maxTokens or check that noThinking is still set.`
          : `[ontology] adjudication returned empty text (finish_reason=${finishReason}). Falling back to heuristics.`
      );
      return null;
    }

    return parseVerdicts(r.text);
  } catch (err) {
    // Named rather than swallowed. A bare `return null` here is precisely how a
    // dead endpoint looked identical to a model with no opinion.
    console.warn(`[ontology] adjudication unavailable, falling back to heuristics: ${err.name}: ${err.message}`);
    return null;
  }
}

function parseVerdicts(text) {
  try {
    const obj = JSON.parse(text);
    if (Array.isArray(obj)) return obj;
    if (Array.isArray(obj?.verdicts)) return obj.verdicts;
  } catch { /* fall through to bracket extraction */ }
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start >= 0 && end > start) {
    try { return JSON.parse(text.slice(start, end + 1)); } catch { /* ignore */ }
  }
  return null;
}
