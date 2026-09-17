import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchAviation } from '../lib/feeds/aviation.js';

// lib/feeds/aviation.js imports nothing that pulls in the sample-lake JSON, so
// no loader shim is needed — regions are built inline rather than imported.
async function withStubbedFetch(aircraft, fn) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ aircraft }) });
  try { return await fn(); } finally { globalThis.fetch = realFetch; }
}

const contact = (hex) => ({ hex, lat: 30.1, lon: 48.2, flight: 'TEST123', alt_baro: 30000, gs: 400, track: 90 });

function region(coverage) {
  return {
    id: 'probe',
    bbox: { west: 47.6, east: 48.8, south: 29.6, north: 30.6 },
    params: { aviation: { radiusNm: 150, ...(coverage ? { coverage } : {}) } },
  };
}

// Kuwait: 0 on both runs.
const BLIND = { state: 'blind', readings: [
  { run: 'run1', probedAt: '2026-08-16', aircraft: 0 },
  { run: 'run2', probedAt: '2026-08-16', aircraft: 0 },
] };
// Ningbo: 0 on run 1, 1 on run 2. The case the whole design turns on.
const UNMEASURED = { state: 'unmeasured', readings: [
  { run: 'run1', probedAt: '2026-08-16', aircraft: 0 },
  { run: 'run2', probedAt: '2026-08-16', aircraft: 1 },
] };
// Tokyo: 121 on run 2, plus a second run.
const COVERED = { state: 'covered', readings: [
  { run: 'run2', probedAt: '2026-08-16', aircraft: 121 },
  { run: 'run3', probedAt: '2026-08-16', aircraft: 118 },
] };

test('a blind region says no feeder is in range, and quotes every reading', async () => {
  const fc = await withStubbedFetch([], () => fetchAviation(region(BLIND)));
  assert.equal(fc.features.length, 0);
  assert.ok(fc.notice, 'a blind region must carry a notice');
  // Pin the blind wording specifically — "feeder" alone is shared with the
  // unmeasured sentence ("ADS-B feeder coverage here is not established"), so
  // asserting only /feeder/i lets a blind region emit the unmeasured finding
  // and still pass every assertion here.
  assert.match(fc.notice, /feeder is in range/i,
    'a blind region must use the blind finding, not one shared with unmeasured');
  assert.doesNotMatch(fc.notice, /not established|probe runs disagree/i,
    'reproducible blindness is not the same finding as disagreement between runs');
  assert.match(fc.notice, /run1/);
  assert.match(fc.notice, /run2/);
});

test('an unmeasured region says the runs disagreed, not that it is blind', async () => {
  // Run 1 read Ningbo at 0 and run 2 at 1. Reporting either one as the answer is
  // publishing a claim the evidence does not support.
  const fc = await withStubbedFetch([], () => fetchAviation(region(UNMEASURED)));
  assert.ok(fc.notice);
  // The blind finding is "No volunteer ADS-B feeder is in range" — matching on
  // the literal adjacent substring "volunteer feeder" can never fire, because
  // "ADS-B" always sits between those two words in the real wording. Anchored
  // on the phrase that is actually shared between the two findings' surface
  // text instead, so this goes red under the mutation it is named for.
  assert.doesNotMatch(fc.notice, /feeder is in range/i,
    'disagreement between runs is not the same finding as reproducible blindness');
  assert.match(fc.notice, /disagree|unmeasured|not established/i);
  // Anchored to the reading's own "<aircraft> on " prefix rather than a bare
  // digit — an unanchored /0/ or /1/ is also satisfied by the "2026-08-16"
  // timestamp and by "run1", so it asserts almost nothing about the readings.
  assert.match(fc.notice, /\b0 on /);
  assert.match(fc.notice, /\b1 on /);
});

test('a covered region gets no notice', async () => {
  const fc = await withStubbedFetch([contact('a1')], () => fetchAviation(region(COVERED)));
  assert.equal(fc.notice, undefined);
});

test('the notice survives a poll that did return contacts', async () => {
  // The record is a measurement, not a prediction. Gating the notice on an empty
  // response turns it back into the runtime inference it exists to replace, and
  // leaves a reader of "3 aircraft over Ningbo" with no way to know the number
  // reflects feeder density.
  const fc = await withStubbedFetch([contact('a1'), contact('a2'), contact('a3')],
    () => fetchAviation(region(UNMEASURED)));
  assert.equal(fc.features.length, 3);
  assert.ok(fc.notice, 'the notice must survive a non-empty response');
});

test('a region with no coverage record gets no notice, even at zero aircraft', async () => {
  const fc = await withStubbedFetch([], () => fetchAviation(region(null)));
  assert.equal(fc.features.length, 0);
  assert.equal(fc.notice, undefined,
    'an empty response is not by itself evidence about feeder coverage');
});

test('a coverage notice never marks the layer not live', async () => {
  // The feed is answering. A notice is information, not a fault — see Task 4.
  // aviation.js never assigns `live` on any path (grep the file — the only two
  // hits are in comments), so the correct pin is that the notice branch leaves
  // it exactly untouched: `undefined`, which app/api/status/route.js treats as
  // live by default. assert.notEqual(fc.live, false) would also pass for
  // live: null or live: 0 — neither of which this module should ever produce —
  // so it proves "not explicitly marked dead" rather than "genuinely alive".
  // Pinning `undefined` exactly is the stronger, accurate statement of the
  // actual contract.
  const fc = await withStubbedFetch([], () => fetchAviation(region(BLIND)));
  assert.equal(fc.live, undefined, 'the notice branch must leave live untouched');
});

test('both aviation sources failing names both of them', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 503 });
  try {
    await assert.rejects(
      () => fetchAviation(region(null)),
      (err) => {
        assert.match(err.message, /adsb\.fi/);
        assert.match(err.message, /OpenSky/);
        return true;
      },
    );
  } finally { globalThis.fetch = realFetch; }
});
