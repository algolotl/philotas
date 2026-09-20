// When the trial shows its region chooser, and which cities it features.
//
// Kept free of the page so the decision is testable under node --test without a
// DOM, and free of window/localStorage at module scope so the module imports in
// that same environment. The caller reads the URL and storage and passes the
// two booleans in.

export const PREFERRED_REGION_KEY = 'philotas.preferredRegion';

export const FEATURED_REGION_IDS = Object.freeze([
  'sydney', 'melbourne', 'rotterdam', 'singapore', 'newyork', 'jebelali', 'shanghai',
]);

// Display names for the featured tiles, keyed by id. Hard-coded so the row
// renders before /api/regions answers — the tiles are a marketing surface, not
// a projection of the loaded list, and on cold landing that list is still
// seeding.
export const FEATURED_REGION_LABELS = Object.freeze({
  sydney: 'Sydney',
  melbourne: 'Melbourne',
  rotterdam: 'Rotterdam',
  singapore: 'Singapore',
  newyork: 'New York',
  jebelali: 'Jebel Ali',
  shanghai: 'Shanghai',
});

export function shouldShowChooser({ hasViewParam, preferredRegion }) {
  return !hasViewParam && !preferredRegion;
}
