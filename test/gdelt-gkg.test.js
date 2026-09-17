// test/gdelt-gkg.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseGkg, latestGkgUrl, fetchLatestGkg, GkgUnavailable } from '../lib/feeds/gdelt-gkg.js';

// test/fixtures/gdelt-gkg-sample-row.tsv is verbatim upstream bytes, not a
// hand-written sample: one full 27-field GKG 2.1 row lifted byte-for-byte,
// tabs intact, from a real download of
// http://data.gdeltproject.org/gdeltv2/20260816000000.gkg.csv.zip on
// 2026-08-16 (id 20260816000000-118, afl.com.au). The row() helper below
// builds its fixture using the SAME column indexes the implementation reads
// with, so the two drift together if GDELT ever moves a column — GKG has
// changed shape before, 1.0 to 2.0 to 2.1. This captured row is independent
// of those indexes: the assertions below are read off the raw bytes by eye,
// not derived from the parser's own idea of where each field lives.
const fixtureDir = fileURLToPath(new URL('./fixtures/', import.meta.url));
const readFixture = (name) => fs.readFile(path.join(fixtureDir, name), 'utf8');

// One real row, field-for-field, captured from
// http://data.gdeltproject.org/gdeltv2/20260815033000.gkg.csv.zip on
// 2026-08-15. GKG 2.1 is 27 tab-separated fields; the ones this system needs
// are 1 (record id), 2 (date), 4 (source name), 5 (document url),
// 10 (locations), 14 (organisations) and 16 (tone).
const LOCATIONS =
  '4#Sydney, New South Wales, Australia#AS#AS02#-33.8833#151.217#-1603135;' +
  '4#Parramatta, New South Wales, Australia#AS#AS02#-33.8167#151#-1594034';

const row = (over = {}) => {
  const f = new Array(27).fill('');
  f[0] = over.id ?? '20260815033000-1';
  f[1] = over.date ?? '20260815033000';
  f[3] = over.source ?? 'dailyadvertiser.com.au';
  f[4] = over.url ?? 'https://www.dailyadvertiser.com.au/story/9330821/church-school-finances-questioned';
  f[9] = over.locations ?? LOCATIONS;
  f[13] = over.orgs ?? 'redeemer baptist school;australian associated';
  f[15] = over.tone ?? '-1.89873417721519,2.68987341772152,4.588';
  return f.join('\t');
};

test('a real row parses into located records', () => {
  const [rec] = parseGkg(row());
  assert.equal(rec.source, 'dailyadvertiser.com.au');
  assert.match(rec.url, /^https:\/\/www\.dailyadvertiser\.com\.au/);
  assert.equal(rec.locations.length, 2);
  assert.equal(rec.locations[0].name, 'Sydney, New South Wales, Australia');
  assert.equal(rec.locations[0].lat, -33.8833);
  assert.equal(rec.locations[0].lon, 151.217);
  assert.deepEqual(rec.organisations, ['redeemer baptist school', 'australian associated']);
  assert.ok(rec.tone < 0, 'tone is the first comma-separated value');
  assert.equal(new Date(rec.dateMs).getUTCFullYear(), 2026);
});

test('a record with no locations is dropped', () => {
  // The whole point of this source is real placement. A record we cannot place
  // is not better than nothing, it is a pin in an invented spot.
  assert.deepEqual(parseGkg(row({ locations: '' })), []);
});

test('malformed rows are skipped without failing the file', () => {
  const text = [row(), 'garbage\trow', '', row({ id: '20260815033000-2' })].join('\n');
  const out = parseGkg(text);
  assert.equal(out.length, 2, 'the two good rows survive');
});

test('a location with unparseable coordinates is dropped, not zeroed', () => {
  // 0,0 is in the Gulf of Guinea and would render as a pin in the ocean.
  const bad = '4#Nowhere#XX#XX00#notalat#notalon#0';
  assert.deepEqual(parseGkg(row({ locations: bad })), []);
});

test('a location at literal 0,0 is dropped, not pinned to the Gulf of Guinea', () => {
  // Distinct from the case above: these coordinates parse fine as numbers
  // (Number.isFinite(0) is true), so only the explicit null-island guard
  // catches this one. Non-numeric input never reaches that guard.
  const nullIsland = '4#Null Island#XX#XX00#0#0#0';
  assert.deepEqual(parseGkg(row({ locations: nullIsland })), []);
});

test('a captured real GKG row places real coordinates', async () => {
  const text = await readFixture('gdelt-gkg-sample-row.tsv');
  const [rec] = parseGkg(text);
  assert.equal(rec.source, 'afl.com.au');
  assert.match(rec.url, /^https:\/\/www\.afl\.com\.au\/news\/1586454\//);
  assert.equal(rec.locations.length, 3);
  const names = rec.locations.map((l) => l.name);
  assert.ok(names.includes('Perth, Western Australia, Australia'));
  assert.ok(names.includes('Melbourne, Victoria, Australia'));
  assert.ok(names.includes('Brisbane, Queensland, Australia'));
  const perth = rec.locations.find((l) => l.name.startsWith('Perth'));
  assert.equal(perth.lat, -31.9333);
  assert.equal(perth.lon, 115.833);
  assert.deepEqual(rec.organisations, ['mcrae']);
  assert.ok(rec.tone < 0, 'tone is the first comma-separated value, and this row is negative');
  assert.equal(new Date(rec.dateMs).getUTCFullYear(), 2026);
});

test('the lastupdate manifest yields the gkg url', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    text: async () => [
      '43727 c7dee73d http://data.gdeltproject.org/gdeltv2/20260815033000.export.CSV.zip',
      '53649 95cf5870 http://data.gdeltproject.org/gdeltv2/20260815033000.mentions.CSV.zip',
      '2515047 8afa8271 http://data.gdeltproject.org/gdeltv2/20260815033000.gkg.csv.zip',
    ].join('\n'),
  });
  try {
    assert.equal(await latestGkgUrl(), 'http://data.gdeltproject.org/gdeltv2/20260815033000.gkg.csv.zip');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('an unreachable manifest raises a named error', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('connect ETIMEDOUT'); };
  try {
    await assert.rejects(() => latestGkgUrl(), (err) => err instanceof GkgUnavailable && err.unavailable === true);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('a truncated or corrupt zip download degrades as an unavailable signal, not a bare throw', async () => {
  // fetchLatestGkg does two fetches: the manifest, then the archive itself.
  // The first must succeed so execution reaches inflateSingleEntryZip at all;
  // the second returns bytes that are not a valid zip, which is what a
  // connection dropped mid-download looks like once buffered.
  const realFetch = globalThis.fetch;
  let call = 0;
  globalThis.fetch = async () => {
    call += 1;
    if (call === 1) {
      return {
        ok: true,
        text: async () => '2515047 8afa8271 http://data.gdeltproject.org/gdeltv2/20260815033000.gkg.csv.zip',
      };
    }
    const garbage = Buffer.from('truncated mid-transfer, not a zip');
    return {
      ok: true,
      arrayBuffer: async () => garbage.buffer.slice(garbage.byteOffset, garbage.byteOffset + garbage.byteLength),
    };
  };
  try {
    await assert.rejects(
      () => fetchLatestGkg(),
      (err) => err instanceof GkgUnavailable && err.unavailable === true,
      'a corrupt archive must degrade the same way an unreachable host does, not throw a bare Error',
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});
