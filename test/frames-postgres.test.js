import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import zlib from 'node:zlib';

// The trial runs on Postgres — the file backend is the developer default, not
// what is deployed. lib/frames.js picks between them once, at import time, from
// DATABASE_URL, so a test cannot reach the Postgres SQL through the module's
// own `backend`. makePostgresFrameBackend() exists to be constructed directly
// with an explicit connection string, which is what this file does.
//
// Measured on the reference deployment, 2026-08-16: the live `frames` table is
// (feed, region, t, fc) with 12,139 rows and no payload_version column. So the
// interesting case is not a fresh database — it is a populated table that
// predates the column, which is what `a table that predates the column` below
// builds on purpose.
import {
  makePostgresFrameBackend,
  FRAMES_SCHEMA_STATEMENTS,
} from '../lib/frames.js';
import { PAYLOAD_VERSION_BASELINE, resolveStoredPayloadVersion } from '../lib/payload-version.js';

const HAS_DB = !!process.env.DATABASE_URL;

// True regardless of backend: the rule that keeps 12,139 rows readable is a
// pure function, and it is worth pinning even where no database is available.
test('an absent stored version resolves to the baseline, and a recorded one is kept', () => {
  assert.equal(resolveStoredPayloadVersion(null), PAYLOAD_VERSION_BASELINE);
  assert.equal(resolveStoredPayloadVersion(undefined), PAYLOAD_VERSION_BASELINE);
  assert.equal(resolveStoredPayloadVersion(2), 2);
  // Postgres hands back BIGINT/INTEGER as strings through pg in some
  // configurations, so the string form has to resolve the same way.
  assert.equal(resolveStoredPayloadVersion('2'), 2);
  // The trap: Number(null) is 0, a version that could collide with a real one.
  assert.notEqual(resolveStoredPayloadVersion(null), 0);
});

test('the schema statements are idempotent in shape and add the column separately', () => {
  // Asserted without a database because this is what will run against a table
  // holding 12,139 rows on the next deploy. CREATE TABLE IF NOT EXISTS does
  // nothing to an existing table, so the ALTER has to be its own statement or
  // the column never appears on any instance that already has the table.
  assert.equal(FRAMES_SCHEMA_STATEMENTS.length, 3);
  assert.match(FRAMES_SCHEMA_STATEMENTS[0], /CREATE TABLE IF NOT EXISTS frames/);
  assert.match(FRAMES_SCHEMA_STATEMENTS[1], /ALTER TABLE frames ADD COLUMN IF NOT EXISTS payload_version INTEGER/);
  // Nullable. A NOT NULL or a DEFAULT would rewrite every existing row.
  assert.doesNotMatch(FRAMES_SCHEMA_STATEMENTS[1], /NOT NULL|DEFAULT/);

  // Every statement in the list runs on every cold start of every process, so
  // every one of them has to be a no-op against a database that already has it.
  for (const statement of FRAMES_SCHEMA_STATEMENTS) {
    assert.match(statement, /IF NOT EXISTS/, `not idempotent: ${statement.slice(0, 60)}`);
  }
});

test('the freshness stamp is a side table, not a column on frames', () => {
  // The design point, pinned. The stamp advances on polls that write no frame —
  // that is the case it exists for — so putting it on `frames` would mean an
  // UPDATE of the newest row on every poll: 227 updates a minute against a
  // 12,139-row table that is otherwise strictly append-only, each leaving a
  // dead tuple. If someone later moves it onto `frames` for tidiness, this says
  // why not.
  // Matched on the exact table name the queries use. `feed_freshness` as a
  // prefix is not enough: a statement creating `feed_freshness_v2` would satisfy
  // a looser pattern while leaving writeFreshness() failing against a table that
  // does not exist — and it would fail QUIETLY, because a stamp that cannot be
  // written degrades to the old frame-age rule rather than to an error.
  const freshness = FRAMES_SCHEMA_STATEMENTS
    .find((s) => /CREATE TABLE IF NOT EXISTS feed_freshness\s*\(/.test(s));
  assert.ok(freshness, 'the freshness table is part of the schema this module applies');
  assert.match(freshness, /PRIMARY KEY \(feed, region\)/, 'one row per pair, upserted, never appended');
  assert.match(freshness, /fresh_as_of\s+BIGINT/, 'a millisecond epoch, which does not fit an INTEGER');
  // Nothing is added to `frames` for this.
  const framesStatements = FRAMES_SCHEMA_STATEMENTS.filter((s) => !/feed_freshness/.test(s));
  for (const statement of framesStatements) {
    assert.doesNotMatch(statement, /fresh_as_of/, 'the stamp does not live on the frames table');
  }
});

if (!HAS_DB) {
  test('frames Postgres backend suite: SKIPPED', {
    skip: 'DATABASE_URL is not set. Point it at a real Postgres connection string to run the frames archive against the backend the trial actually deploys.',
  }, () => {});
} else {
  const RUN = crypto.randomUUID().slice(0, 8);
  const backend = makePostgresFrameBackend({ connectionString: process.env.DATABASE_URL });

  const body = (n) => zlib.gzipSync(Buffer.from(JSON.stringify({
    type: 'FeatureCollection',
    features: Array.from({ length: n }, (_, i) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [151.2, -33.85] },
      properties: { id: i },
    })),
  })));

  const inflate = (buf) => JSON.parse(zlib.gunzipSync(buf).toString('utf8'));

  test('a versioned frame round-trips through the real table', async () => {
    const feed = `t-${RUN}-versioned`;
    const t = Date.now();
    await backend.write(feed, 'r', t, body(3), 2);

    const stamps = await backend.stamps(feed, 'r');
    assert.equal(stamps.length, 1);
    assert.equal(stamps[0].t, t);
    assert.equal(stamps[0].payloadVersion, 2);

    const read = await backend.read(feed, 'r', stamps[0]);
    assert.ok(read, 'the frame comes back');
    assert.equal(inflate(read).features.length, 3);
  });

  test('a table that predates the column reads its rows as version 1, unmigrated', async () => {
    // Reproduces the live table exactly: a row inserted with no
    // payload_version, which is what all 12,139 of them look like. Written
    // through raw SQL rather than backend.write() because backend.write()
    // always records a version and the whole question is what happens to rows
    // that do not have one.
    const pg = (await import('pg')).default;
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    const feed = `t-${RUN}-legacy`;
    const t = Date.now();
    try {
      for (const statement of FRAMES_SCHEMA_STATEMENTS) await pool.query(statement);
      await pool.query(
        'INSERT INTO frames (feed, region, t, fc) VALUES ($1, $2, $3, $4)',
        [feed, 'r', t, body(7)]
      );

      const stamps = await backend.stamps(feed, 'r');
      assert.equal(stamps.length, 1);
      assert.equal(
        stamps[0].payloadVersion,
        PAYLOAD_VERSION_BASELINE,
        'a NULL column is the pre-versioning shape, which is version 1'
      );

      // The load-bearing half: it is not merely reported as version 1, it can
      // actually be fetched. A bare `payload_version = $n` predicate would miss
      // here, because NULL equals nothing.
      const read = await backend.read(feed, 'r', stamps[0]);
      assert.ok(read, 'the pre-versioning row is readable without being migrated');
      assert.equal(inflate(read).features.length, 7);

      // And it is still NULL afterwards. Nothing backfilled it.
      const after = await pool.query(
        'SELECT payload_version FROM frames WHERE feed = $1 AND region = $2 AND t = $3',
        [feed, 'r', t]
      );
      assert.equal(after.rows[0].payload_version, null, 'read, not rewritten');
    } finally {
      await pool.query('DELETE FROM frames WHERE feed LIKE $1', [`t-${RUN}-%`]).catch(() => {});
      await pool.end();
    }
  });

  test('a frame at the wrong version is not fetched even by an explicit read', async () => {
    const feed = `t-${RUN}-mismatch`;
    const t = Date.now();
    await backend.write(feed, 'r', t, body(3), 1);
    // Ask for the same row as though it were version 2, the way readableStamps
    // would never do but a direct caller might.
    assert.equal(await backend.read(feed, 'r', { t, payloadVersion: 2 }), null);
    assert.ok(await backend.read(feed, 'r', { t, payloadVersion: 1 }), 'and the right version still works');
  });

  test('the freshness stamp round-trips and never moves backwards', async () => {
    const feed = `t-${RUN}-freshness`;
    // No row yet is the state of all 122 pairs the moment this deploys, and it
    // has to read as "no stamp" rather than as an epoch timestamp.
    assert.equal(await backend.readFreshness(feed, 'r'), null);

    const t = Date.now();
    await backend.writeFreshness(feed, 'r', t);
    assert.equal(await backend.readFreshness(feed, 'r'), t);

    // Upsert, not insert: one row per (feed, region) for the life of the
    // deployment, however many polls run through it.
    await backend.writeFreshness(feed, 'r', t + 60_000);
    assert.equal(await backend.readFreshness(feed, 'r'), t + 60_000);

    // Two workers can have their upserts arrive out of order. A stamp that went
    // backwards would report a working feed as last answering earlier than it
    // did, which is the inversion this whole change removes.
    await backend.writeFreshness(feed, 'r', t);
    assert.equal(await backend.readFreshness(feed, 'r'), t + 60_000, 'GREATEST, not last-write-wins');
  });

  test('cleanup', async () => {
    const pg = (await import('pg')).default;
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    try {
      await pool.query('DELETE FROM frames WHERE feed LIKE $1', [`t-${RUN}-%`]);
      await pool.query('DELETE FROM feed_freshness WHERE feed LIKE $1', [`t-${RUN}-%`]);
    } finally {
      await pool.end();
      await backend._end();
    }
  });
}
