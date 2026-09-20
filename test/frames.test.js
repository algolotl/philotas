import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';

import { payloadVersionFor, PAYLOAD_VERSION_BASELINE } from '../lib/payload-version.js';
import { NEWS_PAYLOAD_VERSION } from '../lib/feeds/news.js';

// The archive picks its backend from DATABASE_URL at import time and the file
// backend roots itself at process.cwd(), so both are fixed before the module
// loads. Running in a temporary directory keeps the suite off the developer's
// real .data/ — a test that deletes two days of frames because it shared a
// directory with the running server is a bad afternoon.
const cwd = process.cwd();
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'philotas-frames-'));

let frames;

before(async () => {
  delete process.env.DATABASE_URL;
  process.chdir(scratch);
  frames = await import('../lib/frames.js');
  assert.equal(frames.archiveKind, 'file', 'these tests exercise the file backend');
});

after(() => {
  process.chdir(cwd);
  fs.rmSync(scratch, { recursive: true, force: true });
});

beforeEach(() => {
  frames._resetCadenceState();
});

const fc = (n, offset = 0) => ({
  type: 'FeatureCollection',
  features: Array.from({ length: n }, (_, i) => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [151.2 + (i + offset) * 0.001, -33.85] },
    properties: { id: i, route: `route-${i}`, label: `contact ${i}` },
  })),
});

// Put a frame on disk at a chosen payload version, bypassing archive().
//
// This is what the archive genuinely looks like after a deploy: the frames
// already there were written by the previous build, and no production entry
// point can produce them any more. Adding a version-taking writer to
// lib/frames.js would be production surface existing only for tests, and the
// on-disk layout is itself the thing under test — so the test writes the file.
//
// `payloadVersion: null` writes the file with no `.v<n>` segment, reproducing
// every frame written before this change — the 12,139 rows on the trial and
// their on-disk equivalents. Those read back as PAYLOAD_VERSION_BASELINE, so
// this is the fixture for "still current" as well as for "superseded", and
// which one it is depends entirely on the feed.
function writeFrameAtVersion(feed, region, t, payload, payloadVersion) {
  const dir = path.join(scratch, '.data', 'frames', `${feed}__${region}`);
  fs.mkdirSync(dir, { recursive: true });
  const name = payloadVersion === null ? `${t}.gz` : `${t}.v${payloadVersion}.gz`;
  fs.writeFileSync(path.join(dir, name), zlib.gzipSync(Buffer.from(JSON.stringify(payload))));
}

test('a frame survives a write and comes back byte-identical', async () => {
  const t = Date.now();
  assert.equal(await frames.archive('roundtrip', 'test', fc(3), t), 'written');

  const got = await frames.framesBetween('roundtrip', 'test', t - 1000, t + 1000);
  assert.equal(got.length, 1);
  assert.equal(got[0].t, t);
  assert.equal(got[0].count, 3);
  // Properties survive compression, which is the whole reason frames are
  // archived whole rather than trimmed to coordinates.
  assert.equal(got[0].fc.features[1].properties.route, 'route-1');
});

test('frames inside the cadence interval are not written', async () => {
  const t = Date.now();
  assert.equal(await frames.archive('cadence', 'test', fc(1), t), 'written');
  assert.equal(await frames.archive('cadence', 'test', fc(2), t + 5_000), 'too-soon');
  assert.equal(await frames.archive('cadence', 'test', fc(3), t + 30_000), 'too-soon');
  assert.equal(await frames.archive('cadence', 'test', fc(4), t + 61_000), 'written');

  const extent = await frames.coverage('cadence', 'test');
  assert.equal(extent.frames, 2, 'four polls a minute apart is two frames, not four');
});

test('an unchanged payload does not earn a second frame', async () => {
  // Berths, facilities and camera sites return an identical payload every poll.
  // Two days of those at one a minute is 2,880 byte-identical copies.
  const t = Date.now();
  const staticPayload = fc(5);

  assert.equal(await frames.archive('static', 'test', staticPayload, t), 'written');
  assert.equal(await frames.archive('static', 'test', staticPayload, t + 61_000), 'unchanged');
  assert.equal(await frames.archive('static', 'test', staticPayload, t + 122_000), 'unchanged');
  // Something genuinely new is still recorded.
  assert.equal(await frames.archive('static', 'test', fc(6), t + 183_000), 'written');

  const extent = await frames.coverage('static', 'test');
  assert.equal(extent.frames, 2);
});

test('a payload that only differs by its generated timestamp is unchanged', async () => {
  // Every real feed sets `generated: Date.now()`, which the first version of
  // the change check hashed along with everything else — so nothing was ever
  // equal to the frame before it and the skip never fired once in production.
  // Measured over 9.6 hours on the deployed instance before this was fixed:
  // berths 11 frames, facilities 59, camera sites 117, every one of them
  // byte-identical apart from that field.
  frames._resetCadenceState();
  const t = Date.now();
  const base = { ...fc(4), generated: t };

  assert.equal(await frames.archive('volatile', 'test', base, t), 'written');
  assert.equal(
    await frames.archive('volatile', 'test', { ...base, generated: t + 61_000 }, t + 61_000),
    'unchanged',
    'a new generated stamp on identical features is not a new frame'
  );

  // A real change still lands, generated stamp and all.
  assert.equal(
    await frames.archive('volatile', 'test', { ...fc(5), generated: t + 122_000 }, t + 122_000),
    'written'
  );
  assert.equal((await frames.coverage('volatile', 'test')).frames, 2);
});

test('the cadence clock survives a process restart', async () => {
  // lastWrite is in-memory. Without seeding it from the archive, the first poll
  // after a restart writes immediately however recently the last frame landed —
  // and the unit restarts always, five seconds apart, so a crash loop would
  // fill the archive at 12 frames a minute.
  const t = Date.now();
  frames._resetCadenceState();
  assert.equal(await frames.archive('restart', 'test', fc(2), t), 'written');

  // Simulate the restart: process state is gone, the archive is not.
  frames._resetCadenceState();
  assert.equal(
    await frames.archive('restart', 'test', fc(3), t + 10_000),
    'too-soon',
    'ten seconds after the last archived frame is still inside the interval'
  );
  assert.equal((await frames.coverage('restart', 'test')).frames, 1);
});

test('a window returns the frame before it as well as the ones inside it', async () => {
  const t = Date.now();
  await frames.archive('edge', 'test', fc(1), t);
  await frames.archive('edge', 'test', fc(2), t + 61_000);
  await frames.archive('edge', 'test', fc(3), t + 122_000);

  // A window opening after the first frame. Without the preceding frame the
  // replay would render an empty layer for the start of the window, when in
  // fact the contacts were there — we had simply last heard about them before
  // the window opened.
  const got = await frames.framesBetween('edge', 'test', t + 90_000, t + 200_000);
  assert.equal(got.length, 2);
  assert.equal(got[0].t, t + 61_000, 'the nearest earlier frame carries the window in');
  assert.equal(got[1].t, t + 122_000);
});

test('a window wider than the frame budget is thinned, not truncated', async () => {
  const t = Date.now();
  for (let i = 0; i < 40; i += 1) {
    await frames.archive('wide', 'test', fc(2, i), t + i * 61_000);
  }

  const got = await frames.framesBetween('wide', 'test', t - 1000, t + 41 * 61_000, 10);
  assert.ok(got.length <= 11, `expected at most 11 frames, got ${got.length}`);
  // Truncation would return the first ten and silently drop the rest of the
  // window, presenting a quarter of the span as though it were all of it.
  assert.equal(got[got.length - 1].t, t + 39 * 61_000, 'the newest frame is always kept');
  assert.ok(got[0].t <= t, 'the oldest frame is kept too');
});

test('newestFrame is what a failed upstream falls back to', async () => {
  const t = Date.now();
  await frames.archive('fallback', 'test', fc(2), t);
  await frames.archive('fallback', 'test', fc(9), t + 61_000);

  const newest = await frames.newestFrame('fallback', 'test');
  assert.equal(newest.t, t + 61_000);
  assert.equal(newest.fc.features.length, 9);
});

test('newestFrame is null when nothing was ever archived', async () => {
  assert.equal(await frames.newestFrame('never-written', 'test'), null);
});

test('the archive retention window is 48 hours, and the value is pinned here rather than derived', () => {
  // Every other retention assertion in this file writes its boundary as
  // `now - frames.RETENTION_MS - 60_000` (lines below, and the superseded-version
  // prune test near the foot). That is the right way to write those tests — but
  // both sides of every boundary then move together, so the formula is pinned and
  // the duration itself never was. Measured 2026-08-18 by mutation: changing
  // lib/frames.js:56 from 48 to 24 hours left the whole suite green at 725 tests.
  //
  // The value is load-bearing. lib/frames.js:421 issues
  // `DELETE FROM frames WHERE t < $1` against `Date.now() - RETENTION_MS`, and the
  // file backend prunes on the same cutoff, so a smaller value silently destroys
  // history the replay and coverage surfaces are supposed to be able to reach, and
  // a larger one lets the archive grow without bound. Same finding, same fix and
  // same wording as test/news-store.test.js:34, which pins its own 24 hour window
  // after halving it went unnoticed by 603 tests.
  assert.equal(frames.RETENTION_MS, 48 * 60 * 60 * 1000);
  assert.equal(frames.RETENTION_MS, 172_800_000, 'the arithmetic too, so a unit slip is not arithmetic that agrees with itself');
});

test('frames older than the retention window are pruned', async () => {
  const now = Date.now();
  await frames.archive('retain', 'test', fc(1), now - frames.RETENTION_MS - 60_000);
  frames._resetCadenceState();
  await frames.archive('retain', 'test', fc(2), now);

  assert.equal((await frames.coverage('retain', 'test')).frames, 2);

  const removed = await frames._pruneNow();
  assert.ok(removed >= 1, 'the frame older than the retention window is removed');

  const extent = await frames.coverage('retain', 'test');
  assert.equal(extent.frames, 1);
  assert.equal(extent.from, now);
});

test('a feed id that walks the filesystem is refused', async () => {
  // `feed` arrives from a URL path segment. The route validates it against
  // FETCHERS first, so this is the second line of defence — which is exactly
  // why it is worth having and worth testing.
  await assert.rejects(
    () => frames.archive('../../escape', 'test', fc(1)),
    /unsafe archive key/
  );
  await assert.rejects(
    () => frames.archive('ok', '../../escape', fc(1)),
    /unsafe archive key/
  );
});

// ---------------------------------------------------------------------------
// Payload format versioning
//
// Deployed to the reference deployment on 2026-08-16 at 368f7e7, the first request for the london
// region returned `count=60 src=None live=False window=None` with the article
// sitting on the London centroid [-0.1126, 51.5074]. Every one of those is a
// pre-GKG shape: 60 is the DOC API's per-query cap, the centroid is the invented
// spiral placement the GKG change existed to remove, and `source`,
// `window_records` and `placed_at` are absent because the code that wrote that
// frame did not have them. The frame came out of the durable archive, which had
// no way to tell it apart from one the current build wrote.
// ---------------------------------------------------------------------------

test('the news payload version is ahead of the baseline, so its pre-GKG frames are stale', () => {
  // Requirement 5: the constant has to move, or nothing on disk gets skipped.
  assert.equal(payloadVersionFor('news'), NEWS_PAYLOAD_VERSION);
  assert.ok(
    NEWS_PAYLOAD_VERSION > PAYLOAD_VERSION_BASELINE,
    `the GKG rewire changed the news payload shape, so its version must be past ${PAYLOAD_VERSION_BASELINE}`
  );
});

test('a frame archived under the previous payload version is not served', async () => {
  const t = Date.now();
  // The shape that actually caused the incident: a DOC-API frame, placed on the
  // London centroid, with none of the GKG fields.
  writeFrameAtVersion('news', 'london', t, {
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [-0.1126, 51.5074] },
      properties: { layer: 'news', title: 'pre-GKG article', domain: 'kidderminstershuttle.co.uk' },
    }],
  }, NEWS_PAYLOAD_VERSION - 1);

  assert.equal(
    await frames.newestFrame('news', 'london'),
    null,
    'a frame one version behind is skipped, not repaired and not served with a warning'
  );
});

test('a pre-versioning frame is version 1: served for a version-1 feed, skipped for news', async () => {
  // The load-bearing test for this whole change, and the only thing separating
  // the fix from the sledgehammer.
  //
  // Measured on the trial database 2026-08-16: 12,139 rows, no payload_version
  // column at all. Calling every one of those "unknown shape" and discarding it
  // would cost berths, facilities, cameras, vessels, satellites and hotspots two
  // days of replay in order to fix one feed. Their shape did not change. News's
  // did.
  //
  // These two frames are byte-identical and neither carries a version marker.
  // The only thing that differs is which feed they belong to.
  const t = Date.now();
  writeFrameAtVersion('weather', 'split', t, fc(4), null);
  writeFrameAtVersion('news', 'split', t, fc(4), null);

  const stillGood = await frames.newestFrame('weather', 'split');
  assert.ok(stillGood, 'weather never changed shape, so its pre-versioning history is still readable');
  assert.equal(stillGood.fc.features.length, 4);
  assert.equal(stillGood.t, t);

  assert.equal(
    await frames.newestFrame('news', 'split'),
    null,
    'news left the DOC API for the GKG window, so the same bytes are a shape it can no longer show'
  );
});

test('a pre-versioning frame is read where it lies, not rewritten to carry a version', async () => {
  // Migrating 12,139 Postgres rows is not on the table, and neither is renaming
  // two days of files. The ABSENCE of a version marker is itself the record
  // that a frame is at the baseline, so reading one must not quietly start
  // rewriting history to say what it already says.
  const t = Date.now();
  const dir = path.join(scratch, '.data', 'frames', 'weather__inplace');
  writeFrameAtVersion('weather', 'inplace', t, fc(4), null);

  assert.ok(await frames.newestFrame('weather', 'inplace'), 'the frame reads back');
  assert.equal((await frames.framesBetween('weather', 'inplace', t - 1_000, t + 1_000)).length, 1);
  assert.equal((await frames.coverage('weather', 'inplace')).frames, 1);

  assert.deepEqual(
    fs.readdirSync(dir),
    [`${t}.gz`],
    'still exactly the file that was there, with no .v1 segment grown onto it'
  );
});

test('a frame carrying no payload version is skipped for news, which did change shape', async () => {
  const t = Date.now();
  // A pre-versioning frame resolves to version 1. News is at 2, so this frame is
  // the DOC-API shape and does not get served.
  writeFrameAtVersion('news', 'unversioned', t, fc(60), null);

  assert.equal(await frames.newestFrame('news', 'unversioned'), null);
  assert.equal(
    payloadVersionFor('news') - 1,
    PAYLOAD_VERSION_BASELINE,
    'skipped because news moved off the baseline, not because the frame is unreadable in principle'
  );
});

test('every feed that did not change shape is on the baseline version', () => {
  // The register in lib/payload-version.js is a positive statement that these
  // payloads were reviewed and found unchanged, not merely that nobody got round
  // to listing them. If one of them ever does change shape, this is the line
  // that has to be edited alongside it.
  for (const feed of [
    'aviation', 'satellites', 'vessels', 'transport', 'cameras',
    'fires', 'hotspots', 'seismic', 'weather', 'space',
  ]) {
    assert.equal(payloadVersionFor(feed), PAYLOAD_VERSION_BASELINE, `${feed} keeps its archived history`);
  }
  assert.equal(payloadVersionFor('news'), PAYLOAD_VERSION_BASELINE + 1, 'news is the exception');
  // A feed with no entry — a connector registered at runtime — inherits the
  // baseline rather than landing in a state where nothing it wrote can be read.
  assert.equal(payloadVersionFor('some-connector-added-later'), PAYLOAD_VERSION_BASELINE);
});

test('a frame archived under the current payload version IS served', async () => {
  // The load-bearing one. A guard that rejects every frame would make all the
  // other tests here pass while leaving the archive permanently unreadable —
  // which is the same outage as having no archive, arrived at differently.
  const t = Date.now();
  assert.equal(await frames.archive('news', 'current', fc(21), t), 'written');

  const newest = await frames.newestFrame('news', 'current');
  assert.ok(newest, 'a frame the current build wrote is readable by the current build');
  assert.equal(newest.t, t);
  assert.equal(newest.fc.features.length, 21);
});

test('a replay spanning a version change does not interleave the two shapes', async () => {
  const t = Date.now();
  // Two frames from the old build, then two from this one, alternating in time
  // so a reader that ignored the version would return them interleaved.
  writeFrameAtVersion('news', 'mixed', t, fc(60), NEWS_PAYLOAD_VERSION - 1);
  await frames.archive('news', 'mixed', fc(21), t + 61_000);
  writeFrameAtVersion('news', 'mixed', t + 122_000, fc(60), NEWS_PAYLOAD_VERSION - 1);
  frames._resetCadenceState();
  await frames.archive('news', 'mixed', fc(22), t + 183_000);

  const got = await frames.framesBetween('news', 'mixed', t - 1_000, t + 200_000);
  assert.equal(got.length, 2, 'only the frames this build can read come back');
  assert.deepEqual(got.map((f) => f.t), [t + 61_000, t + 183_000]);
  assert.deepEqual(got.map((f) => f.count), [21, 22], 'no 60-feature DOC-API frame survives the filter');
});

test('the frame carried in from before the window obeys the version rule too', async () => {
  // framesBetween pulls in the nearest earlier frame so a replay does not open
  // on an empty layer. That lead-in frame is served to the client exactly like
  // the ones inside the window, so it needs the same filter — picking the
  // nearest earlier frame of ANY version would put the old shape back on screen
  // at the very moment an operator starts scrubbing.
  //
  // The superseded frame is deliberately the CLOSEST one before the window: if
  // it sat further back, a reader with no filter at all would still pick the
  // readable frame and this would pass without proving anything.
  const t = Date.now();
  await frames.archive('news', 'leadin', fc(21), t);
  writeFrameAtVersion('news', 'leadin', t + 61_000, fc(60), NEWS_PAYLOAD_VERSION - 1);
  frames._resetCadenceState();
  await frames.archive('news', 'leadin', fc(22), t + 122_000);

  const got = await frames.framesBetween('news', 'leadin', t + 90_000, t + 200_000);
  assert.equal(got.length, 2);
  assert.equal(got[0].t, t, 'the lead-in skips back past the superseded frame to the last readable one');
  assert.equal(got[0].count, 21, 'and it is the GKG shape, not the 60-article DOC-API one');
  assert.equal(got[1].t, t + 122_000);
});

test('coverage reports the window it can actually show, not the frames on disk', async () => {
  // The replay bar sizes itself from this. Counting frames the reader will
  // refuse to return would claim two days of history over an archive that can
  // serve twenty minutes of it.
  const t = Date.now();
  writeFrameAtVersion('news', 'extent', t, fc(60), NEWS_PAYLOAD_VERSION - 1);
  writeFrameAtVersion('news', 'extent', t + 61_000, fc(60), null);
  await frames.archive('news', 'extent', fc(21), t + 122_000);

  const extent = await frames.coverage('news', 'extent');
  assert.equal(extent.frames, 1);
  assert.equal(extent.from, t + 122_000, 'the window starts where the readable history starts');
  assert.equal(extent.to, t + 122_000);
  // A named signal rather than a silent drop: the frames are on disk, they are
  // taking up the retention budget, and they cannot be shown.
  assert.equal(extent.incompatible_frames, 2);
});

test('a version bump lets the first poll after a deploy write immediately', async () => {
  // The cadence clock is seeded from the archive so a crash loop cannot write a
  // frame every five seconds. It has to be seeded from the frames this build
  // can READ: seeding it from a frame the version guard just rejected would
  // leave newestFrame() answering null for a full minute after every deploy
  // that bumps a version — an archive that is empty precisely when the restart
  // has made it most useful.
  const t = Date.now();
  writeFrameAtVersion('news', 'deploy', t, fc(60), NEWS_PAYLOAD_VERSION - 1);

  frames._resetCadenceState();
  assert.equal(
    await frames.archive('news', 'deploy', fc(21), t + 10_000),
    'written',
    'an unreadable frame ten seconds ago does not hold the cadence slot'
  );
});

test('frames from a superseded version are still pruned when they age out', async () => {
  // They cannot be served, but they still occupy the retention budget. A
  // filename the pruner cannot parse would leave them there forever.
  const now = Date.now();
  writeFrameAtVersion('news', 'prune-old', now - frames.RETENTION_MS - 60_000, fc(60), NEWS_PAYLOAD_VERSION - 1);
  writeFrameAtVersion('news', 'prune-old', now - frames.RETENTION_MS - 30_000, fc(60), null);
  frames._resetCadenceState();
  await frames.archive('news', 'prune-old', fc(21), now);

  const removed = await frames._pruneNow();
  assert.ok(removed >= 2, `both superseded frames are removed, ${removed} were`);
  assert.equal((await frames.coverage('news', 'prune-old')).frames, 1);
  assert.equal(
    fs.readdirSync(path.join(scratch, '.data', 'frames', 'news__prune-old')).length,
    1,
    'and they are gone from disk, not merely hidden from the reader'
  );
});

test('compression is what makes the 48 hour window affordable', async () => {
  // The measurement the design rests on, pinned so a future change that stores
  // frames uncompressed fails here rather than quietly filling a disk.
  const dense = {
    type: 'FeatureCollection',
    features: Array.from({ length: 1000 }, (_, i) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [151.17 + i * 1e-5, -33.84] },
      properties: {
        layer: 'transport', mode: 'Bus', title: `Bus ${i}`, route: `9-F8-sj2-${i}`,
        trip: `CI2045-WD-IN.100826.31.${i}`, label: `service ${i}`,
        bearing: 82, speed_kmh: 0, status: '1', ts: 1786706334000,
      },
    })),
  };
  const raw = Buffer.byteLength(JSON.stringify(dense));

  const t = Date.now();
  await frames.archive('dense', 'test', dense, t);
  // The frame's payload version is part of its filename — that is what lets the
  // reader skip a superseded frame without inflating it. See lib/frames.js.
  const name = `${t}.v${payloadVersionFor('dense')}.gz`;
  const stored = fs.statSync(path.join(scratch, '.data', 'frames', 'dense__test', name)).size;

  const ratio = raw / stored;
  assert.ok(ratio > 4, `expected better than 4x compression, measured ${ratio.toFixed(1)}x`);
});
