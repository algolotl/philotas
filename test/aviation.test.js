// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

// lib/regions.js reaches JSON modules (sample-lake berths/facilities) through
// lib/config.js, and Node's ESM loader wants `with { type: 'json' }` where the
// Next bundler resolves it natively. Same inline loader shim as
// test/region-schema.test.js.
const jsonImportShim = `
  export async function load(url, context, nextLoad) {
    if (url.endsWith('.json') && (!context.importAttributes || context.importAttributes.type !== 'json')) {
      return nextLoad(url, { ...context, importAttributes: { ...(context.importAttributes || {}), type: 'json' } });
    }
    return nextLoad(url, context);
  }
`;
register(`data:text/javascript,${encodeURIComponent(jsonImportShim)}`, import.meta.url);

const { REGIONS } = await import('../lib/regions.js');
const { selectAviationSource, fetchAviation } = await import('../lib/feeds/aviation.js');

const world = REGIONS.world;

async function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) {
    saved[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  try {
    return await fn();
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

test('the world region carries aviation and defaults to adsb.fi', () => {
  assert.ok(world.layers.includes('aviation'), 'world must still carry the aviation layer');
  assert.equal(world.bbox, null, 'world has no bbox (precondition for the source switch)');
  assert.equal(selectAviationSource({}), 'adsb.fi');
});

test('OpenSky credentials alone do not switch the source', () => {
  assert.equal(
    selectAviationSource({ OPENSKY_CLIENT_ID: 'id', OPENSKY_CLIENT_SECRET: 'secret' }),
    'adsb.fi',
  );
});

test('OpenSky requires the explicit OPENSKY_ENABLE=1 opt-in', () => {
  assert.equal(
    selectAviationSource({ OPENSKY_CLIENT_ID: 'id', OPENSKY_CLIENT_SECRET: 'secret', OPENSKY_ENABLE: '1' }),
    'OpenSky',
  );
});

test('a disabled OpenSky reports bring-your-own credentials, not a silent empty layer', async () => {
  await withEnv({ OPENSKY_CLIENT_ID: undefined, OPENSKY_CLIENT_SECRET: undefined, OPENSKY_ENABLE: undefined }, async () => {
    const fc = await fetchAviation(world);
    assert.deepEqual(fc.features, []);
    assert.ok(fc.notice, 'an empty world aviation layer must explain itself');
    assert.match(fc.notice, /bring your own credentials/i);
    assert.match(fc.notice, /non-commercial/i);
  });
});
