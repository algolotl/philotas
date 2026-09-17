import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { register } from 'node:module';
import { groupRegionsByTheatre, regionOptionLabel, THEATRE_ORDER, TYPE_RANK } from '../lib/region-groups.js';

// lib/regions.js reaches sample-lake JSON without an import attribute. Same
// loader shim, and for the same reason, as test/poller-reaping.test.js.
// lib/region-groups.js itself needs none of this — it imports nothing — which is
// the point of keeping it pure.
const jsonImportShim = `
  export async function load(url, context, nextLoad) {
    if (url.endsWith('.json') && (!context.importAttributes || context.importAttributes.type !== 'json')) {
      return nextLoad(url, { ...context, importAttributes: { ...(context.importAttributes || {}), type: 'json' } });
    }
    return nextLoad(url, context);
  }
`;
register(`data:text/javascript,${encodeURIComponent(jsonImportShim)}`, import.meta.url);
const { REGION_LIST, REGION_TYPES, THEATRES } = await import('../lib/regions.js');

const total = (groups) => groups.reduce((n, g) => n + g.regions.length, 0);

// The count is asserted as a literal, not as REGION_LIST.length, wherever the
// point is the size of the catalogue rather than the shape of the grouping.
// Building the expectation out of the same list the module reads proves nothing.
const REGION_COUNT = 83;

test('the picker order and the region schema agree on the theatres', () => {
  // As-declared, both sides. THEATRES is picker order — `Global` first — so
  // sorting either side here would leave the order that the whole grouping
  // depends on completely unguarded.
  assert.deepEqual([...THEATRE_ORDER], [...THEATRES]);
  assert.equal(THEATRE_ORDER[0], 'Global');
});

test('every region appears in exactly one group', () => {
  // The picker used to group by `type` against four hard-coded values, so
  // introducing `type: 'strait'` dropped all nine chokepoints out of the list
  // with no error anywhere. This is the assertion that catches that class of
  // change, whichever field the grouping is keyed on.
  const groups = groupRegionsByTheatre(REGION_LIST);
  assert.equal(REGION_LIST.length, REGION_COUNT);
  assert.equal(total(groups), REGION_COUNT);
  const seen = new Set();
  for (const group of groups) {
    for (const region of group.regions) {
      assert.ok(!seen.has(region.id), `${region.id} appears in more than one group`);
      seen.add(region.id);
    }
  }
  assert.equal(seen.size, REGION_COUNT);
});

test('all nine chokepoints are in the list', () => {
  const listed = groupRegionsByTheatre(REGION_LIST)
    .flatMap((g) => g.regions).filter((r) => r.type === 'strait').map((r) => r.id).sort();
  assert.deepEqual(listed, [
    'babelmandeb', 'copenhagen', 'dover', 'gibraltar', 'hormuz',
    'istanbul', 'kiel', 'suez', 'taiwanstrait',
  ]);
});

test('groups come back in the fixed theatre order, not insertion order', () => {
  // All seven theatres are populated, so the whole catalogue must come back as
  // the whole of THEATRE_ORDER and nothing else. This is not circular: measured
  // 2026-08-17 by listing the theatres in REGION_LIST order, the catalogue is
  // built Global, Australia & NZ, United States, Europe, Middle East, South East
  // Asia, North East Asia — the last two the other way round from THEATRE_ORDER.
  // An implementation that returned insertion order would fail here.
  assert.deepEqual(groupRegionsByTheatre(REGION_LIST).map((g) => g.theatre), [...THEATRE_ORDER]);

  const shuffled = [...REGION_LIST].reverse();
  const order = groupRegionsByTheatre(shuffled).map((g) => g.theatre);
  assert.deepEqual(order, [...THEATRE_ORDER]);
  assert.equal(order[0], 'Global');
});

test('a theatre with no regions produces no group', () => {
  const groups = groupRegionsByTheatre([
    { id: 'a', name: 'A', type: 'city', country: 'GB', theatre: 'Europe' },
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].theatre, 'Europe');
  // And an empty group never reaches the picker for the real catalogue either,
  // where an `<optgroup>` with no options renders as a dead heading.
  for (const group of groupRegionsByTheatre(REGION_LIST)) {
    assert.ok(group.regions.length > 0, `${group.theatre} came back empty`);
  }
});

test('a region with an unrecognised theatre still appears', () => {
  // Partition, never filter. A region nobody can select is worse than a region in
  // an oddly named group.
  const groups = groupRegionsByTheatre([
    { id: 'a', name: 'A', type: 'city', country: 'GB', theatre: 'Europe' },
    { id: 'mars', name: 'Mars', type: 'city', country: null, theatre: 'Mars' },
  ]);
  assert.equal(total(groups), 2);
  assert.equal(groups.at(-1).theatre, 'Other');
  assert.equal(groups.at(-1).regions[0].id, 'mars');
});

test('within a theatre, the wide views come before the cities', () => {
  const groups = groupRegionsByTheatre([
    { id: 'newyork', name: 'New York', type: 'city', country: 'US', theatre: 'United States' },
    { id: 'baltimore', name: 'Baltimore', type: 'city', country: 'US', theatre: 'United States' },
    { id: 'unitedstates', name: 'United States', type: 'country', country: 'US', theatre: 'United States' },
  ]);
  assert.deepEqual(groups[0].regions.map((r) => r.id), ['unitedstates', 'baltimore', 'newyork']);
});

test('every declared region type has a rank', () => {
  // Otherwise a whole vocabulary entry falls to the unranked fallback and sorts
  // behind the cities, which is how `strait` was lost from the picker the first
  // time — a new `type` value that nothing downstream had been told about.
  for (const type of REGION_TYPES) {
    assert.equal(typeof TYPE_RANK[type], 'number', `${type} has no rank`);
  }
});

test('a strait is labelled a chokepoint, not left bare', () => {
  assert.equal(
    regionOptionLabel({ name: 'Bab el-Mandeb', type: 'strait', country: null }),
    'Bab el-Mandeb · chokepoint');
  assert.equal(
    regionOptionLabel({ name: 'Felixstowe', type: 'city', country: 'GB' }),
    'Felixstowe · GB');
  assert.equal(
    regionOptionLabel({ name: 'Worldwide', type: 'world', country: null }),
    'Worldwide');
});

test('grouping does not reorder the caller\'s list', () => {
  // The picker calls this on the `regions` state array every render. Sorting
  // that array in place would mutate React state outside setState.
  const input = [
    { id: 'newyork', name: 'New York', type: 'city', country: 'US', theatre: 'United States' },
    { id: 'unitedstates', name: 'United States', type: 'country', country: 'US', theatre: 'United States' },
  ];
  const before = input.map((r) => r.id);
  groupRegionsByTheatre(input);
  assert.deepEqual(input.map((r) => r.id), before);
});

// ---------------------------------------------------------------------------
// The consumer.
//
// Everything above pins lib/region-groups.js, and none of it can see whether
// app/page.jsx still calls it. Measured on this branch before these tests
// existed: reverting the picker JSX to the pre-branch four-type `optgroup`
// block left the whole suite at 536 / 532 / 0 fail, and so did replacing
// `regionOptionLabel(r)` with `r.name`. Every test above passes either way,
// because they test a module the page no longer imports — which is the same gap
// Task 4 found for splitContactCounts, and the remedy is the one already in the
// repo at test/status-notice.test.js.
//
// app/page.jsx is a `'use client'` JSX module behind the `@/` alias, so bare
// `node --test` cannot import it and there is no renderer without a new
// dependency. What can be checked without one is that the component asks this
// module for the grouping and keeps no rival grouping of its own.
const pageSource = readFileSync(fileURLToPath(new URL('../app/page.jsx', import.meta.url)), 'utf8');

// Only executable code is scanned: the comments in page.jsx discuss the old
// four-type grouping at length and would otherwise trip the rival-rule check
// below. page.jsx contains no `://` (checked), so stripping `//` to end of line
// cannot eat a URL.
const pageCode = pageSource
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/[^\n]*/g, '');

test('the region picker gets its grouping from lib/region-groups.js', () => {
  assert.match(
    pageCode,
    /import\s*\{[^}]*\bgroupRegionsByTheatre\b[^}]*\}\s*from\s*'@\/lib\/region-groups'/,
    'app/page.jsx must import the shared grouping'
  );
  assert.match(
    pageCode,
    /import\s*\{[^}]*\bregionOptionLabel\b[^}]*\}\s*from\s*'@\/lib\/region-groups'/,
    'app/page.jsx must import the shared option label'
  );
  assert.match(
    pageCode,
    /groupRegionsByTheatre\(\s*regions\s*\)/,
    'app/page.jsx must build the picker from groupRegionsByTheatre(regions), not from a grouping of its own'
  );
  assert.match(
    pageCode,
    /<option\b[^>]*>\s*\{\s*regionOptionLabel\(/,
    'each <option> must take its text from regionOptionLabel, or the nine chokepoints render as bare names'
  );
});

test('app/page.jsx keeps no rival grouping of the region list', () => {
  // The exact shape of the defect this branch existed to fix: grouping by
  // `type` against four hard-coded values drops every `type: 'strait'` region —
  // hormuz, suez, dover, gibraltar, babelmandeb, taiwanstrait, istanbul,
  // copenhagen, kiel — out of the picker with nothing anywhere reporting it.
  const offenders = pageCode
    .split('\n')
    .map((line, i) => [i + 1, line])
    .filter(([, line]) => /\bregions\s*\.\s*filter\s*\(/.test(line));
  assert.deepEqual(
    offenders,
    [],
    'the region list is grouped in lib/region-groups.js and nowhere else; these lines partition it again:\n'
      + offenders.map(([n, line]) => `  ${n}: ${line.trim()}`).join('\n')
  );
});

test('the news layer is on by default for every region', () => {
  // Alex's controller ruling. Before this branch news defaulted off for every
  // region but `world`, and reverting to that — `region === 'world' ? … :
  // (data.layers || []).filter((l) => l !== 'news')` — left the suite green.
  // With the catchment now wider than the map box for a city or a chokepoint,
  // some of what a region matches is filed next door and invisible while the
  // layer is off, so the default is load-bearing rather than cosmetic.
  assert.match(
    pageCode,
    /setEnabled\(\s*data\.layers\s*\|\|\s*\[\]\s*\)/,
    'a region opens on exactly the layers its context declares — no layer is filtered out on arrival'
  );
  const offenders = pageCode
    .split('\n')
    .map((line, i) => [i + 1, line])
    .filter(([, line]) => /['"]news['"]/.test(line) && /filter|!==|slice|splice/.test(line));
  assert.deepEqual(
    offenders,
    [],
    'these lines single the news layer out of a layer list:\n'
      + offenders.map(([n, line]) => `  ${n}: ${line.trim()}`).join('\n')
  );
});
