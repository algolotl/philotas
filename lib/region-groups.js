// How the region picker groups its 83 entries.
//
// Kept free of every import that reaches lib/config.js, so it can be tested
// without the JSON loader shim and imported by a client component without
// dragging the sample lake into the browser bundle. THEATRE_ORDER duplicates
// THEATRES in lib/regions.js on purpose, and test/region-groups.test.js asserts
// the two agree — as declared, in order — rather than leaving it to a comment.

export const THEATRE_ORDER = Object.freeze([
  'Global',
  'Australia & NZ',
  'United States',
  'Europe',
  'Middle East',
  'North East Asia',
  'South East Asia',
]);

// Where a region whose theatre this build does not recognise lands. It is not a
// member of THEATRE_ORDER: nothing is ever assigned to it deliberately, and on
// the shipped catalogue it never appears.
const UNRECOGNISED_THEATRE = 'Other';

// Within a theatre, the views that contain the others come first: the whole
// earth, then a country, then a multi-country region, then a chokepoint, then the
// cities alphabetically. Someone opening "United States" wants the national view
// at the top, not between Tampa and Wilmington. Every value in REGION_TYPES
// carries a rank here, which test/region-groups.test.js pins.
export const TYPE_RANK = Object.freeze({ world: 0, country: 1, region: 2, strait: 3, city: 4 });

// A type this build has not been told about sorts last rather than first, so a
// vocabulary change shows up at the bottom of a group instead of displacing the
// wide view someone opened the group to find.
const UNRANKED_TYPE = 9;

export function regionOptionLabel(region) {
  // A chokepoint spans countries, so it carries none and would otherwise read as
  // a bare name among 83 entries that all carry a suffix.
  if (region.type === 'strait') return `${region.name} · chokepoint`;
  return region.country ? `${region.name} · ${region.country}` : region.name;
}

function byViewThenName(a, b) {
  const rank = (TYPE_RANK[a.type] ?? UNRANKED_TYPE) - (TYPE_RANK[b.type] ?? UNRANKED_TYPE);
  return rank !== 0 ? rank : a.name.localeCompare(b.name);
}

export function groupRegionsByTheatre(regions) {
  const buckets = new Map(THEATRE_ORDER.map((theatre) => [theatre, []]));
  // Partition, never filter. The previous picker grouped by `type` against four
  // hard-coded values, so adding `type: 'strait'` dropped all nine chokepoints
  // out of the list with nothing anywhere reporting it. A region with a theatre
  // this build does not recognise is still a region someone can select, so it
  // lands in a trailing group instead of vanishing.
  const unrecognised = [];
  for (const region of regions || []) {
    const bucket = buckets.get(region.theatre);
    if (bucket) bucket.push(region);
    else unrecognised.push(region);
  }

  // The buckets are built here, so sorting them sorts nothing the caller owns —
  // the picker passes its React state array in on every render.
  const groups = THEATRE_ORDER
    .map((theatre) => ({ theatre, regions: buckets.get(theatre).sort(byViewThenName) }))
    .filter((group) => group.regions.length > 0);

  if (unrecognised.length) {
    groups.push({ theatre: UNRECOGNISED_THEATRE, regions: unrecognised.sort(byViewThenName) });
  }
  return groups;
}
