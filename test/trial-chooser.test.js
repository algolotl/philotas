import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  shouldShowChooser,
  FEATURED_REGION_IDS,
  FEATURED_REGION_LABELS,
  PREFERRED_REGION_KEY,
} from '../lib/trial-chooser.js';

test('shows the chooser on a cold landing with no preference', () => {
  assert.equal(shouldShowChooser({ hasViewParam: false, preferredRegion: null }), true);
});

test('hides when the URL already carries a view', () => {
  assert.equal(shouldShowChooser({ hasViewParam: true, preferredRegion: null }), false);
  assert.equal(shouldShowChooser({ hasViewParam: true, preferredRegion: 'rotterdam' }), false);
});

test('hides when a preferred region is stored', () => {
  assert.equal(shouldShowChooser({ hasViewParam: false, preferredRegion: 'rotterdam' }), false);
});

test('featured tiles are the marketing cities', () => {
  assert.deepEqual(FEATURED_REGION_IDS, [
    'sydney', 'melbourne', 'rotterdam', 'singapore', 'newyork', 'jebelali', 'shanghai',
  ]);
});

test('every featured tile has a hard-coded label so it renders pre-fetch', () => {
  for (const id of FEATURED_REGION_IDS) {
    assert.ok(FEATURED_REGION_LABELS[id], `missing label for featured id ${id}`);
  }
});

test('the preference key sits in the parallax.workspaces family', () => {
  assert.equal(PREFERRED_REGION_KEY, 'parallax.preferredRegion');
});
