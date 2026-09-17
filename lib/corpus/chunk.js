// lib/corpus/chunk.js
//
// Token-bounded chunking, counted with the serving model's own tokenizer.
//
// Character counts divided by four are the usual shortcut and they mis-size
// every chunk that is not English prose — a manifest, a table of berth codes,
// a German place name. bge-m3 exposes /tokenize, so the real count costs one
// HTTP call and removes the guess.

import { countTokens } from '../embed.js';

// Attributed to the corpus component rather than the embedder's default, so
// chunking cost is separable from query-time embedding at the gateway.
const serviceCountTokens = (text) => countTokens(text, { app: 'parallax/corpus' });

const TARGET_TOKENS = 512;
const OVERLAP_TOKENS = 64;

// Cheap pre-segmentation guard, not a token budget: this is a character
// count so one enormous paragraph does not arrive at segments() as a single
// indivisible unit. It is deliberately not a token count — that would cost
// a tokenizer round trip per paragraph just to decide whether to pre-split.
// The actual token bound is enforced downstream, against measured token
// counts, by chunkText's main loop and by splitOversizedPart/hardSplitByWords
// below for any segment that individually exceeds targetTokens regardless of
// its character length. This number is sized to comfortably exceed the
// character length of a prose paragraph that would fit under a typical
// target token budget — it is a coarse hint, not a substitute for the real
// bound.
const PARAGRAPH_PRESPLIT_CHARS = 2000;

// Split on paragraph breaks first, then sentence ends. A chunk that stops
// mid-sentence retrieves badly: the embedding carries half a thought.
function segments(text) {
  const paragraphs = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const out = [];
  for (const p of paragraphs) {
    if (p.length < PARAGRAPH_PRESPLIT_CHARS) { out.push(p); continue; }
    const sentences = p.split(/(?<=[.!?])\s+/);
    let buffer = '';
    for (const s of sentences) {
      if ((buffer + ' ' + s).length > PARAGRAPH_PRESPLIT_CHARS && buffer) { out.push(buffer.trim()); buffer = s; }
      else buffer = buffer ? `${buffer} ${s}` : s;
    }
    if (buffer.trim()) out.push(buffer.trim());
  }
  return out;
}

// A "sentence" (or an oversized run with no [.!?] break at all) gets cut on
// word boundaries. The cut is sized by that run's own token-per-word ratio,
// then corrected against a real count so it lands at or under target. A run
// of a single "word" (no internal whitespace — one long token-dense string)
// cannot be reduced any further by this method and is returned as-is.
// `unsplittable` marks exactly that case: a piece still over target after
// this function has done everything it can. It is the signal the caller
// uses to flag the resulting chunk instead of measuring tokenCount after
// the fact, which would also catch ordinary overlap-tail overshoot — that
// is expected packing behavior, not a defect, and must not trip the flag.
async function hardSplitByWords(text, targetTokens, countTokens) {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length <= 1) {
    const tokens = await countTokens(text);
    return [{ text, tokens, unsplittable: tokens > targetTokens }];
  }
  const totalTokens = await countTokens(text);
  const ratio = totalTokens / words.length || 1;
  const out = [];
  let start = 0;
  while (start < words.length) {
    const remaining = words.length - start;
    let count = Math.max(1, Math.min(remaining, Math.floor(targetTokens / ratio)));
    let candidate = words.slice(start, start + count).join(' ');
    let tokens = await countTokens(candidate);
    // The ratio is an estimate from the whole run; correct it against the
    // real count rather than trusting it blindly. Bisect the overshoot
    // instead of walking down one word at a time: for text the ratio badly
    // misjudges (CJK, a table, base64 — see module comment), the initial
    // guess can land hundreds of words past the true answer, and a linear
    // walk pays for every one of those words with its own HTTP round trip.
    // Word count is monotonic in token count (more words never tokenizes
    // to fewer tokens), so a binary search for the largest fitting count
    // is safe and turns an O(words) correction into an O(log words) one.
    if (tokens > targetTokens && count > 1) {
      let lo = 1;
      let hi = count - 1;
      let bestCount = null;
      let bestCandidate = null;
      let bestTokens = null;
      let lastCandidate;
      let lastTokens;
      while (lo <= hi) {
        const mid = lo + Math.floor((hi - lo) / 2);
        const midCandidate = words.slice(start, start + mid).join(' ');
        const midTokens = await countTokens(midCandidate);
        lastCandidate = midCandidate;
        lastTokens = midTokens;
        if (midTokens <= targetTokens) {
          bestCount = mid;
          bestCandidate = midCandidate;
          bestTokens = midTokens;
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }
      if (bestCount !== null) {
        count = bestCount;
        candidate = bestCandidate;
        tokens = bestTokens;
      } else {
        // The search always probes count === 1 last when nothing fits (the
        // range [1, count - 1] collapses to it), so its result is already
        // in hand: no word run is left to try, this one word is unsplittable.
        count = 1;
        candidate = lastCandidate;
        tokens = lastTokens;
      }
    }
    out.push({ text: candidate, tokens, unsplittable: count === 1 && tokens > targetTokens });
    start += count;
  }
  return out;
}

// Split a single segment whose own token count already exceeds targetTokens:
// sentence boundaries first, then a hard word-count split for any sentence
// that is still too big on its own. Returns {text, tokens} pieces so the
// caller does not have to recount ones that are already known.
async function splitOversizedPart(part, targetTokens, countTokens) {
  const sentences = part.split(/(?<=[.!?])\s+/).filter(Boolean);
  if (sentences.length <= 1) return hardSplitByWords(part, targetTokens, countTokens);

  const out = [];
  for (const sentence of sentences) {
    const tokens = await countTokens(sentence);
    if (tokens <= targetTokens) { out.push({ text: sentence, tokens }); continue; }
    out.push(...(await hardSplitByWords(sentence, targetTokens, countTokens)));
  }
  return out;
}

export async function chunkText(text, {
  targetTokens = TARGET_TOKENS,
  overlapTokens = OVERLAP_TOKENS,
  countTokens = serviceCountTokens,
} = {}) {
  const trimmed = (text || '').trim();
  if (!trimmed) return [];

  // Expand any segment whose own token count exceeds targetTokens before it
  // ever reaches the packing loop below. Left alone, a single oversized
  // segment is emitted whole and silently violates the module's token
  // bound — the main loop's guard only fires once a buffer already holds
  // something, so a fresh buffer takes any one segment unconditionally.
  const rawParts = segments(trimmed);
  const parts = [];
  for (const raw of rawParts) {
    const tokens = await countTokens(raw);
    if (tokens > targetTokens) {
      parts.push(...(await splitOversizedPart(raw, targetTokens, countTokens)));
    } else {
      parts.push({ text: raw, tokens });
    }
  }

  const chunks = [];
  let buffer = [];
  let bufferTokens = 0;
  // True only when the current buffer contains a piece that
  // splitOversizedPart/hardSplitByWords could not bring under target (a
  // single unsplittable word run). Ordinary overlap-tail-plus-part
  // overshoot also pushes tokenCount over target sometimes — that is
  // expected, tolerated packing behavior, not a defect, so it must not
  // trip the same flag.
  let bufferHasUnsplittable = false;

  const flush = async () => {
    if (!buffer.length) return;
    const content = buffer.join('\n\n');
    const tokenCount = await countTokens(content);
    const chunk = { ord: chunks.length, content, tokenCount };
    // Reported, not swallowed: the caller can read chunk.oversized rather
    // than discover the violation by re-measuring the content itself.
    if (bufferHasUnsplittable) {
      chunk.oversized = true;
      console.warn(`[chunk] chunk ${chunk.ord} is ${tokenCount} tokens, over target ${targetTokens} and could not be split further`);
    }
    chunks.push(chunk);
  };

  for (const part of parts) {
    const { text: partText, tokens: partTokens, unsplittable } = part;
    if (bufferTokens > 0 && bufferTokens + partTokens > targetTokens) {
      await flush();
      // Carry the tail forward so a fact spanning a boundary is retrievable
      // from either side of it.
      if (overlapTokens > 0) {
        const words = buffer.join('\n\n').split(/\s+/);
        const tail = words.slice(-overlapTokens).join(' ');
        buffer = tail ? [tail] : [];
        bufferTokens = tail ? await countTokens(tail) : 0;
      } else {
        buffer = [];
        bufferTokens = 0;
      }
      bufferHasUnsplittable = false;
    }
    buffer.push(partText);
    bufferTokens += partTokens;
    if (unsplittable) bufferHasUnsplittable = true;
  }
  await flush();
  return chunks;
}
