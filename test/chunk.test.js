// test/chunk.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunkText } from '../lib/corpus/chunk.js';

// A deterministic stand-in for the serving tokenizer: one token per whitespace
// run. The real one is injected in production; tests must not need the network.
const fakeCount = async (s) => s.split(/\s+/).filter(Boolean).length;

const paragraph = (n) => Array.from({ length: n }, (_, i) => `word${i}`).join(' ');

test('short text is one chunk', async () => {
  const chunks = await chunkText('a short note.', { targetTokens: 100, countTokens: fakeCount });
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].ord, 0);
  assert.equal(chunks[0].content, 'a short note.');
  assert.equal(chunks[0].tokenCount, 3);
});

test('long text splits at the target size', async () => {
  const text = `${paragraph(60)}\n\n${paragraph(60)}\n\n${paragraph(60)}`;
  const chunks = await chunkText(text, { targetTokens: 70, overlapTokens: 0, countTokens: fakeCount });
  assert.ok(chunks.length >= 3, `expected at least 3 chunks, got ${chunks.length}`);
  for (const c of chunks) {
    assert.ok(c.tokenCount <= 70 * 1.5, `chunk ${c.ord} is ${c.tokenCount} tokens, well over target`);
  }
  assert.deepEqual(chunks.map((c) => c.ord), chunks.map((_, i) => i), 'ord is contiguous from zero');
});

test('chunks overlap by the requested amount', async () => {
  // Four paragraphs, not one 200-word run: chunkText bin-packs whole segments
  // (split on \n{2,}) and never splits within one, so a single flat blob
  // under the 2000-char sentence-split threshold can never be split at all.
  const text = [paragraph(50), paragraph(50), paragraph(50), paragraph(50)].join('\n\n');
  const chunks = await chunkText(text, { targetTokens: 50, overlapTokens: 10, countTokens: fakeCount });
  assert.ok(chunks.length > 1);
  const firstWords = chunks[0].content.split(/\s+/);
  const secondWords = chunks[1].content.split(/\s+/);
  const tail = firstWords.slice(-10);
  assert.deepEqual(secondWords.slice(0, 10), tail, 'the second chunk begins with the first chunk\'s tail');
});

test('paragraph boundaries are preferred to mid-sentence breaks', async () => {
  const text = `${paragraph(40)}\n\n${paragraph(40)}`;
  const chunks = await chunkText(text, { targetTokens: 45, overlapTokens: 0, countTokens: fakeCount });
  assert.equal(chunks.length, 2);
  assert.ok(!chunks[0].content.includes('\n\n'), 'the split landed on the paragraph break');
});

test('empty or whitespace-only text produces no chunks', async () => {
  assert.deepEqual(await chunkText('', { countTokens: fakeCount }), []);
  assert.deepEqual(await chunkText('   \n\n  ', { countTokens: fakeCount }), []);
});

test('a single oversized paragraph is split into multiple chunks at or under target', async () => {
  // 300 words, no periods, no paragraph breaks: one segment whose own token
  // count (300, under the fake counter) is six times targetTokens (50). The
  // main loop's guard only fires once a buffer already holds something, so
  // left un-split this segment would be pushed into a fresh buffer
  // unconditionally and emitted whole as a single 300-token chunk.
  const text = paragraph(300);
  const chunks = await chunkText(text, { targetTokens: 50, overlapTokens: 0, countTokens: fakeCount });
  assert.ok(chunks.length > 1, `expected multiple chunks, got ${chunks.length}`);
  for (const c of chunks) {
    assert.ok(c.tokenCount <= 50 * 1.1, `chunk ${c.ord} is ${c.tokenCount} tokens, over target`);
    assert.ok(!c.oversized, `chunk ${c.ord} split cleanly and should not carry the oversized flag`);
  }
});

test('a badly misestimated ratio corrects by bisection, not by walking down one word at a time', async () => {
  // One expensive word up front, followed by thousands of free ones. The
  // whole-run ratio the estimate is built from is dragged far below this
  // word run's true local density, so the ratio-based guess for the first
  // window overshoots by hundreds of words (this is what CJK text, a
  // table, or a base64 blob does to the "chars / 4" style estimate in
  // practice). A counter that charged one HTTP round trip per word of
  // correction would need hundreds of calls just for that first window;
  // bisecting the overshoot needs O(log words) instead.
  let calls = 0;
  const words = ['expensive', ...Array.from({ length: 6000 }, () => 'cheap')];
  const text = words.join(' ');
  const countTokens = async (s) => {
    calls++;
    const ws = s.split(/\s+/).filter(Boolean);
    // "expensive" alone already blows the 50-token target; "cheap" words
    // cost nothing, so the whole-run average (ratio) is dragged near zero
    // and the first window's ratio-based guess overshoots by hundreds.
    return ws.includes('expensive') ? 1000 : 0;
  };

  await chunkText(text, { targetTokens: 50, overlapTokens: 0, countTokens });

  const ceiling = 80;
  assert.ok(
    calls < ceiling,
    `expected fewer than ${ceiling} countTokens calls under a badly misestimated ratio (bisection), got ${calls}`
  );
});

test('a segment that cannot be reduced under target is flagged, not passed through silently', async () => {
  // hardSplitByWords cuts on whitespace; a run with none has no smaller unit
  // to cut on. The fake per-word counter used above always counts such a
  // run as exactly one token, so it can never model this case. Use a
  // counter where token count tracks characters instead, the way a real
  // subword tokenizer charges a long, unbroken identifier more than one
  // token.
  const charCount = async (s) => s.length;
  const atom = 'x'.repeat(120);
  const text = `short lead in. ${atom} short trail out.`;
  const chunks = await chunkText(text, { targetTokens: 50, overlapTokens: 0, countTokens: charCount });
  const flagged = chunks.filter((c) => c.oversized);
  assert.equal(flagged.length, 1, 'exactly one chunk carries the unsplittable run');
  assert.ok(flagged[0].tokenCount > 50, 'the flagged chunk is the one still over target');
  assert.ok(flagged[0].content.includes(atom), 'the flagged chunk is the one holding the unsplittable run');
});
