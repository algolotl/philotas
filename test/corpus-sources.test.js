import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildQuery, parseSeenDate, mapArticles, id as gdeltId } from '../lib/corpus/sources/gdelt.js';
import { parsePubDate, filterItems, id as nswHealthId } from '../lib/corpus/sources/nswhealth.js';
import { search as amsaSearch, id as amsaId } from '../lib/corpus/sources/amsa.js';
import { SOURCES } from '../lib/corpus/sources/index.js';
import { enrichEntity, SEARCHABLE_TYPES } from '../lib/corpus/retrieve.js';

// None of these hit the network. Live fetches against GDELT/NSW Health/AMSA
// belong in manual verification (see the header comments in each source
// file for how those endpoints were checked), not in a unit suite that runs
// on every `node --test` — that's exactly the "fetchHotspots itself needs a
// network round trip" reasoning in test/hotspots.test.js, applied here.

// ------------------------------------------------------------------ gdelt

test('gdelt buildQuery wraps the entity label in quotes so it searches as one phrase', () => {
  assert.equal(buildQuery('CORAL PRINCESS'), '"CORAL PRINCESS"');
});

test('gdelt buildQuery strips embedded quotes rather than breaking the query string', () => {
  assert.equal(buildQuery('The "Ever Given"'), '"The Ever Given"');
});

test('gdelt buildQuery returns empty for a missing or blank label, never a bare pair of quotes', () => {
  assert.equal(buildQuery(''), '');
  assert.equal(buildQuery('   '), '');
  assert.equal(buildQuery(undefined), '');
});

test('gdelt parseSeenDate turns GDELT\'s bare-digit UTC stamp into an epoch', () => {
  assert.equal(parseSeenDate('20260813T091500Z'), Date.parse('2026-08-13T09:15:00Z'));
});

test('gdelt parseSeenDate returns null for a missing or malformed stamp rather than throwing', () => {
  assert.equal(parseSeenDate(null), null);
  assert.equal(parseSeenDate(''), null);
  assert.equal(parseSeenDate('not-a-date'), null);
});

test('gdelt mapArticles maps the DOC artlist shape and drops articles with no url', () => {
  const raw = {
    articles: [
      { url: 'https://example.com/a', title: 'A Title', seendate: '20260813T091500Z', language: 'English', domain: 'example.com' },
      { title: 'No url, must be dropped' },
    ],
  };
  const docs = mapArticles(raw);
  assert.equal(docs.length, 1);
  assert.deepEqual(docs[0], {
    url: 'https://example.com/a',
    title: 'A Title',
    source: 'gdelt',
    published_ms: Date.parse('2026-08-13T09:15:00Z'),
    snippet: 'A Title',
    language: 'English',
  });
});

test('gdelt mapArticles tolerates a missing articles array', () => {
  assert.deepEqual(mapArticles({}), []);
  assert.deepEqual(mapArticles(null), []);
});

// -------------------------------------------------------------- nswhealth

test('nswhealth parsePubDate parses NSW Health\'s "Weekday, D Mon YYYY" format', () => {
  const ms = parsePubDate('Monday, 22 Jun 2026');
  assert.ok(Number.isFinite(ms));
  const parsed = new Date(ms);
  assert.equal(parsed.getUTCFullYear(), 2026);
});

test('nswhealth parsePubDate returns null rather than NaN for a missing date', () => {
  assert.equal(parsePubDate(null), null);
  assert.equal(parsePubDate(''), null);
});

test('nswhealth filterItems matches an entity label across title OR description, case-insensitively', () => {
  const items = [
    { title: 'Measles alert for Sydney CBD', link: 'https://example.com/1', pubDate: 'Monday, 22 Jun 2026' },
    { title: 'Unrelated release', metadata_description: 'Mentions sydney cbd in the body only', link: 'https://example.com/2' },
    { title: 'Completely unrelated', link: 'https://example.com/3' },
  ];
  const docs = filterItems(items, 'Sydney CBD');
  assert.deepEqual(docs.map((d) => d.url).sort(), ['https://example.com/1', 'https://example.com/2']);
});

test('nswhealth filterItems returns nothing for a blank label rather than the whole feed', () => {
  const items = [{ title: 'Anything', link: 'https://example.com/1' }];
  assert.deepEqual(filterItems(items, ''), []);
  assert.deepEqual(filterItems(items, undefined), []);
});

test('nswhealth filterItems drops items with no link — there is nothing to store as a document url', () => {
  const items = [{ title: 'Sydney CBD alert', metadata_description: '' }];
  assert.deepEqual(filterItems(items, 'Sydney CBD'), []);
});

// -------------------------------------------------------------------- amsa

test('amsa search always returns an empty array — no real endpoint was found (see the header comment in lib/corpus/sources/amsa.js)', async () => {
  assert.deepEqual(await amsaSearch({ entity_key: 'Vessel:X', entity_label: 'X' }), []);
  assert.deepEqual(await amsaSearch(), []);
  assert.deepEqual(await amsaSearch(null), []);
});

// ----------------------------------------------------------------- registry

test('the source registry lists all three sources with an id, a label and a search function', () => {
  assert.equal(SOURCES.length, 3);
  const ids = SOURCES.map((s) => s.id);
  assert.deepEqual(new Set(ids), new Set([gdeltId, nswHealthId, amsaId]), 'registry ids must match each source module\'s own exported id');
  for (const s of SOURCES) {
    assert.ok(s.label, `${s.id} must have a label`);
    assert.equal(typeof s.search, 'function', `${s.id}.search must be a function`);
  }
});

// -------------------------------------------------------------- retrieve

test('SEARCHABLE_TYPES includes the entity types with an open-source footprint', () => {
  for (const t of ['Vessel', 'Berth', 'Facility', 'FireIncident', 'Aircraft', 'GroundStation', 'Cafe', 'Earthquake']) {
    assert.ok(SEARCHABLE_TYPES.has(t), `expected ${t} to be searchable`);
  }
});

test('SEARCHABLE_TYPES deliberately excludes TransportVehicle', () => {
  // See the comment beside SEARCHABLE_TYPES in lib/corpus/retrieve.js: a
  // fleet bus/light-rail vehicle has no open-source footprint to find, and
  // Sydney runs thousands of them — searching every one would drown the
  // rate-limited sources in lookups that can only come back empty.
  assert.ok(!SEARCHABLE_TYPES.has('TransportVehicle'));
});

test('enrichEntity: one source throwing does not stop the others, and the failure is reported in source_errors', async () => {
  const entity = { entity_key: 'Vessel:CORAL PRINCESS', entity_type: 'Vessel', entity_label: 'CORAL PRINCESS' };
  const fakeSources = [
    { id: 'broken', label: 'Broken', search: async () => { const e = new Error('broken 429'); e.status = 429; throw e; } },
    { id: 'working', label: 'Working', search: async () => [{ url: 'https://example.com/w1', title: 'W1', source: 'working' }] },
  ];
  const result = await enrichEntity(entity, fakeSources);
  assert.equal(result.source_errors.length, 1);
  assert.equal(result.source_errors[0].source, 'broken');
  assert.match(result.source_errors[0].error, /429/);
  assert.equal(result.documents.length, 1, 'the working source\'s document must still come through');
  assert.equal(result.documents[0].url, 'https://example.com/w1');
});

test('enrichEntity dedups by url across sources within one call', async () => {
  const entity = { entity_key: 'Vessel:X', entity_type: 'Vessel', entity_label: 'X' };
  const fakeSources = [
    { id: 'a', label: 'A', search: async () => [{ url: 'https://example.com/shared', title: 'From A', source: 'a' }] },
    { id: 'b', label: 'B', search: async () => [{ url: 'https://example.com/shared', title: 'From B', source: 'b' }] },
  ];
  const result = await enrichEntity(entity, fakeSources);
  assert.equal(result.documents.length, 1, 'the same url from two sources must collapse to one document');
  assert.equal(result.documents[0].title, 'From A', 'first source to report a url wins — later duplicates are dropped, not merged');
});

test('enrichEntity builds one mention per stored document, tagged with the entity that was searched for', async () => {
  const entity = { entity_key: 'Vessel:X', entity_type: 'Vessel', entity_label: 'X' };
  const fakeSources = [
    { id: 'a', label: 'A', search: async () => [{ url: 'https://example.com/1' }, { url: 'https://example.com/2' }] },
  ];
  const result = await enrichEntity(entity, fakeSources);
  assert.equal(result.mentions.length, 2);
  for (const m of result.mentions) {
    assert.equal(m.entity_key, 'Vessel:X');
    assert.equal(m.entity_type, 'Vessel');
    assert.equal(m.entity_label, 'X');
    assert.equal(m.method, 'exact');
    assert.ok(m.confidence > 0 && m.confidence <= 1);
  }
});

test('enrichEntity never throws even when every source fails', async () => {
  const entity = { entity_key: 'Vessel:X', entity_type: 'Vessel', entity_label: 'X' };
  const fakeSources = [
    { id: 'a', label: 'A', search: async () => { throw new Error('dead'); } },
    { id: 'b', label: 'B', search: async () => { throw new Error('also dead'); } },
  ];
  const result = await enrichEntity(entity, fakeSources);
  assert.equal(result.documents.length, 0);
  assert.equal(result.source_errors.length, 2);
});
