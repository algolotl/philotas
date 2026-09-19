import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_MAP_STYLE, resolveMapStyle } from '../lib/map-style.js';

test('defaults to the keyless CARTO dark-matter style', () => {
  assert.equal(DEFAULT_MAP_STYLE, 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json');
  assert.equal(resolveMapStyle(undefined), DEFAULT_MAP_STYLE);
  assert.equal(resolveMapStyle(''), DEFAULT_MAP_STYLE);
  assert.equal(resolveMapStyle('   '), DEFAULT_MAP_STYLE);
});

test('honours an explicit self-hosted style URL', () => {
  const url = 'http://127.0.0.1:8080/styles/dark.json';
  assert.equal(resolveMapStyle(url), url);
  assert.equal(resolveMapStyle('  ' + url + '  '), url);
});
