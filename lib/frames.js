// Durable frame archive — the 48-hour replay history.
//
// Separate from lib/db.js on purpose. That module's file backend rewrites the
// whole database on every mutation, which is fine for a handful of workspaces
// and rules and catastrophic for a write every sixty seconds across a dozen
// feeds. This is append-only: a frame is written once, read by time range, and
// deleted when it ages out. Nothing is ever updated in place.
//
// Separate from lib/store.js too. That store stays in memory and exists so
// lib/cache.js has a last-good payload to serve when an upstream call fails.
// This one survives a restart, which is the whole point: an operator scrubbing
// back two days should not lose the picture because the service was redeployed.
//
// ---------------------------------------------------------------------------
// Why full fidelity rather than trimmed positions
//
// Measured on the Sydney region, 2026-08-14:
//
//     layer          features   bytes/frame
//     transport          1038        308758
//     cameras             150         58217
//     vessels              30         15131
//     all layers                      401 KB
//
// 401 KB every thirty seconds for 48 hours is 2.4 GB, which is why the first
// instinct was to trim each feature down to an id and a coordinate. Gzip made
// that unnecessary: a transport frame compresses 300 KB -> 40 KB, a ratio of
// 7.6x, because a thousand bus records share almost all of their structure.
// At 7.6x and a sixty-second cadence the whole 48 hours is roughly 125 MB, so
// the frames keep every property and a replayed contact still opens a popup
// with its route, its operator and its timestamp. Trimming would have bought
// nothing except a worse product.
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { promisify } from 'node:util';

import {
  payloadVersionFor,
  resolveStoredPayloadVersion,
  PAYLOAD_VERSION_BASELINE,
} from './payload-version.js';

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

// One frame a minute. The in-memory hot tier runs at thirty seconds for the
// live view; the archive is the long horizon and doubling the interval halves
// two days of storage. At sixty seconds a Sydney ferry moves about 400 m
// between frames and a train about a kilometre, so motion still reads as
// motion rather than as teleportation.
export const ARCHIVE_INTERVAL_MS = 60_000;
export const RETENTION_MS = 48 * 60 * 60 * 1000;

// Prune is a directory walk, so it does not run on every write.
const PRUNE_EVERY_WRITES = 200;

const KEY_PATTERN = /^[a-z0-9_-]+$/i;

// `feed` and `region` reach this module from a URL path segment and a query
// parameter. They are used to build a filesystem path, so they are validated
// rather than trusted — a feed id of `../../etc` must not be able to write
// outside the archive directory. The API layer checks feeds against FETCHERS
// and regions against the registry, which makes this the second line of
// defence rather than the first; that is the point of putting it here too.
function safeKey(feed, region) {
  const f = String(feed || '');
  const r = String(region || 'default');
  if (!KEY_PATTERN.test(f) || !KEY_PATTERN.test(r)) {
    throw new Error(`unsafe archive key: ${f}/${r}`);
  }
  return `${f}__${r}`;
}

// `<stamp>.v<payload version>.gz`. The version lives in the NAME rather than in
// the frame, so deciding whether a frame is readable costs no more than the
// directory listing `stamps()` already does — see the note above stamps().
const FRAME_FILE_PATTERN = /^(\d+)\.v(\d+)\.gz$/;
// `<stamp>.gz` — everything written before frames carried a version. Read as
// PAYLOAD_VERSION_BASELINE, in place, exactly as it sits on disk. These files
// are NOT renamed to pick up a `.v1` segment: a rename is a write, and there is
// no reason to rewrite two days of history to record something their absence
// already says.
const UNVERSIONED_FRAME_FILE_PATTERN = /^(\d+)\.gz$/;

function makeFileBackend() {
  const ROOT = path.join(process.cwd(), '.data', 'frames');
  // A sibling of the frame tree, never inside it. prune() walks ROOT and
  // deletes by the leading numeric segment of a name, so a stamp living in a
  // frame directory would be one filename change away from being swept as a
  // stray. It also is not history: there is one stamp per (feed, region),
  // overwritten in place, and retention has nothing to say about it.
  const FRESHNESS_ROOT = path.join(process.cwd(), '.data', 'freshness');
  let writesSincePrune = 0;

  const dirFor = (key) => path.join(ROOT, key);
  const nameFor = (t, payloadVersion) => `${t}.v${payloadVersion}.gz`;
  const freshnessFileFor = (feed, region) =>
    path.join(FRESHNESS_ROOT, `${safeKey(feed, region)}.json`);

  return {
    kind: 'file',

    async write(feed, region, t, buffer, payloadVersion) {
      const dir = dirFor(safeKey(feed, region));
      await fs.promises.mkdir(dir, { recursive: true });
      // One file per frame. It costs an inode but it buys append-free writes,
      // range reads that are a directory listing, and retention that is an
      // unlink — none of which need a lock or a rewrite of anything else.
      // Written to a temporary name and renamed so a reader can never observe
      // a half-written frame.
      const target = path.join(dir, nameFor(t, payloadVersion));
      const temporary = `${target}.${process.pid}.tmp`;
      await fs.promises.writeFile(temporary, buffer);
      await fs.promises.rename(temporary, target);

      writesSincePrune += 1;
      if (writesSincePrune >= PRUNE_EVERY_WRITES) {
        writesSincePrune = 0;
        this.prune().catch(() => { /* pruning is housekeeping, never fatal */ });
      }
    },

    // `{ t, payloadVersion, file }` per frame, oldest first.
    //
    // `file` is the name as it actually exists on disk, carried through so
    // read() opens what the listing found rather than reconstructing a name
    // from the version. That is what lets a pre-versioning `<t>.gz` be served
    // as version 1 without being renamed: its version comes from the ABSENCE
    // of a `.v<n>` segment, and reconstructing `<t>.v1.gz` from that would
    // point at a file which does not exist.
    //
    // Still one readdir and no frame bodies. The version is a regex over names
    // the listing already returned, which is why it is in the filename: the
    // alternative — a version inside the gzipped JSON — would mean opening,
    // reading and inflating every frame in the directory just to find out which
    // ones to throw away.
    //
    // Measured 2026-08-16 over 2,880 transport-sized frames, which is 48 hours
    // at the one-a-minute cadence for a single (feed, region) — 283 KB raw and
    // 15 KB gzipped each, 44 MB on disk. Best of three warm runs:
    //
    //     version in the filename    1.7 ms
    //     version inside the frame   4,901.9 ms
    //
    // A factor of 2,944, and that is one feed in one region out of the ~19
    // regions and dozen feeds the archive holds. Reading the version off the
    // name is what keeps this an O(directory listing) check rather than a
    // several-second stall on the fallback path that runs after every restart.
    async stamps(feed, region) {
      const dir = dirFor(safeKey(feed, region));
      let names;
      try { names = await fs.promises.readdir(dir); }
      catch { return []; }
      const out = [];
      for (const name of names) {
        const versioned = FRAME_FILE_PATTERN.exec(name);
        if (versioned) {
          out.push({
            t: Number(versioned[1]),
            payloadVersion: resolveStoredPayloadVersion(versioned[2]),
            file: name,
          });
          continue;
        }
        const unversioned = UNVERSIONED_FRAME_FILE_PATTERN.exec(name);
        if (unversioned) {
          out.push({
            t: Number(unversioned[1]),
            // No `.v<n>` segment is not "unknown". It is the shape everything
            // was in before versioning, which resolveStoredPayloadVersion()
            // names once for both backends.
            payloadVersion: resolveStoredPayloadVersion(null),
            file: name,
          });
        }
      }
      return out.sort((a, b) => a.t - b.t);
    },

    // Takes a stamp record from stamps() rather than a timestamp and a version,
    // so the frame is opened at the name it is actually stored under.
    async read(feed, region, stamp) {
      const file = path.join(dirFor(safeKey(feed, region)), stamp.file ?? nameFor(stamp.t, stamp.payloadVersion));
      try { return await fs.promises.readFile(file); }
      catch { return null; }
    },

    // The freshness stamp: one small JSON file per (feed, region), written to a
    // temporary name and renamed so a reader can never observe a half-written
    // one. Same discipline as a frame, for the same reason.
    async writeFreshness(feed, region, t) {
      await fs.promises.mkdir(FRESHNESS_ROOT, { recursive: true });
      const target = freshnessFileFor(feed, region);
      const temporary = `${target}.${process.pid}.tmp`;
      await fs.promises.writeFile(temporary, JSON.stringify({ fresh_as_of: t }));
      await fs.promises.rename(temporary, target);
    },

    // null means "no usable stamp", which covers the file not existing at all —
    // the ordinary case for a pair that has not polled since this shipped — and
    // a stamp that cannot be parsed. Both resolve the same way upstream, to the
    // frame's own age, which is the behaviour that shipped before stamps
    // existed. Reporting a fault here instead would trade a small loss of
    // liveness precision for a layer that renders nothing.
    async readFreshness(feed, region) {
      let raw;
      try { raw = await fs.promises.readFile(freshnessFileFor(feed, region), 'utf8'); }
      catch (err) { return null; }
      try {
        const value = Number(JSON.parse(raw).fresh_as_of);
        return Number.isFinite(value) ? value : null;
      } catch (err) {
        return null;
      }
    },

    async prune() {
      const cutoff = Date.now() - RETENTION_MS;
      let directories;
      try { directories = await fs.promises.readdir(ROOT); }
      catch { return 0; }
      let removed = 0;
      for (const key of directories) {
        const dir = path.join(ROOT, key);
        let names;
        try { names = await fs.promises.readdir(dir); }
        catch { continue; }
        for (const name of names) {
          // Leading numeric segment, which every name this module writes starts
          // with: `<t>.gz`, `<t>.v2.gz`, and `<t>.v2.gz.<pid>.tmp` alike.
          // Matching on `.gz` and everything after it — which is what this did
          // before versions were in the name — turns `<t>.v2` into NaN, and a
          // superseded frame that cannot be parsed is a superseded frame that
          // never ages out. Retention has to apply to frames nobody can read;
          // they still occupy the 48-hour budget.
          const t = Number(name.split('.')[0]);
          // Temporary files from a process that died mid-write are swept on the
          // same pass; without this they would accumulate silently forever.
          const isStrayTemporary = name.endsWith('.tmp');
          if ((Number.isFinite(t) && t < cutoff) || isStrayTemporary) {
            try { await fs.promises.unlink(path.join(dir, name)); removed += 1; }
            catch { /* already gone */ }
          }
        }
      }
      return removed;
    },
  };
}

// Everything this module needs a Postgres database to have, in the order it is
// applied. Exported so a migration can be rehearsed against a scratch copy of a
// real database by running exactly these statements, rather than a hand-copied
// approximation of them that can drift from what the code actually issues.
//
// Both statements are idempotent, which they have to be: connect() runs them on
// every cold start of every process, against a table that on the trial already
// holds 12,139 rows.
//
// The ALTER is separate from the CREATE and is the load-bearing one. CREATE
// TABLE IF NOT EXISTS does nothing at all to a table that already exists —
// which is every deployed instance — so without a standalone ALTER the column
// would exist only on databases created after this change, and every read on
// an existing one would fail on a missing column.
//
// payload_version is nullable and stays nullable. The 12,139 existing rows are
// NOT backfilled: NULL is read as PAYLOAD_VERSION_BASELINE by
// resolveStoredPayloadVersion(), so those rows are already correct as they sit
// and an UPDATE across the whole table would be a large write that changes
// nothing about what is served.
//
// feed_freshness is a TABLE OF ITS OWN rather than a column on frames, and that
// is the decisive design point of the freshness stamp. The stamp has to advance
// on a poll that writes no frame — that is the entire case it exists for — so a
// column on `frames` would mean an UPDATE of the newest row on every poll. That
// is 227 updates a minute against a 12,139-row table which is otherwise
// strictly append-only (see the note at the top of this file: nothing is ever
// updated in place), and every one of them would leave a dead tuple behind. The
// side table holds one row per (feed, region) — 122 of them for the whole
// deployment — and is the only thing in this module that is written twice.
export const FRAMES_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS frames (
     feed            TEXT   NOT NULL,
     region          TEXT   NOT NULL,
     t               BIGINT NOT NULL,
     fc              BYTEA  NOT NULL,
     payload_version INTEGER,
     PRIMARY KEY (feed, region, t)
   )`,
  'ALTER TABLE frames ADD COLUMN IF NOT EXISTS payload_version INTEGER',
  `CREATE TABLE IF NOT EXISTS feed_freshness (
     feed        TEXT   NOT NULL,
     region      TEXT   NOT NULL,
     fresh_as_of BIGINT NOT NULL,
     PRIMARY KEY (feed, region)
   )`,
];

// Built against an explicit connection string rather than reading the
// environment, so a test can drive the real SQL without going through the
// process-level backend selection below — that selection happens once at import
// time and a test cannot influence it after the fact.
export function makePostgresFrameBackend({ connectionString } = {}) {
  let pool = null;
  let ready = null;
  let writesSincePrune = 0;

  async function connect() {
    if (ready) return ready;
    ready = (async () => {
      const pg = (await import('pg')).default;
      pool = new pg.Pool({ connectionString });
      for (const statement of FRAMES_SCHEMA_STATEMENTS) await pool.query(statement);
      // The only query shape this table serves is "frames for one feed and
      // region between two timestamps", and the primary key already leads with
      // exactly that prefix, so no second index is created. An unused index on
      // a table written to every sixty seconds is pure write amplification.
      // payload_version is deliberately NOT in the key: a version bump does not
      // change a frame's timestamp, so it cannot collide with one.
      return pool;
    })();
    return ready;
  }

  return {
    // Lets a test close the pool it opened. The process-level backend never
    // calls this — its pool lives as long as the process does.
    async _end() { if (pool) await pool.end(); pool = null; ready = null; },

    kind: 'postgres',

    async write(feed, region, t, buffer, payloadVersion) {
      const p = await connect();
      await p.query(
        'INSERT INTO frames (feed, region, t, fc, payload_version) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING',
        [feed, region, t, buffer, payloadVersion]
      );
      writesSincePrune += 1;
      if (writesSincePrune >= PRUNE_EVERY_WRITES) {
        writesSincePrune = 0;
        this.prune().catch(() => {});
      }
    },

    // The file backend's cheapness argument holds here for the same reason: the
    // version is a column beside the key, so it comes back on a query that was
    // already running and the BYTEA column is never touched. Selecting `fc` to
    // find out a frame's shape would pull ~40 KB per row across the wire for
    // frames most of which are about to be discarded.
    async stamps(feed, region) {
      const p = await connect();
      const r = await p.query(
        'SELECT t, payload_version FROM frames WHERE feed = $1 AND region = $2 ORDER BY t',
        [feed, region]
      );
      return r.rows.map((row) => ({
        t: Number(row.t),
        // NULL for every row written before this column existed — 12,139 of
        // them on the trial. Resolved, not rewritten: the same helper the file
        // backend uses turns the absence into PAYLOAD_VERSION_BASELINE on every
        // read. Number(null) would be 0, a version that could collide with a
        // real one, which is why this does not simply coerce.
        payloadVersion: resolveStoredPayloadVersion(row.payload_version),
      }));
    },

    // COALESCE rather than a bare `payload_version = $4`, because a NULL column
    // never equals anything — the pre-versioning rows would all miss and the
    // 48 hours of history this change exists to preserve would be unreadable
    // after all. The guard is kept rather than trusting the primary key alone
    // so that read() is correct when called directly, which is how a test
    // drives this backend.
    async read(feed, region, stamp) {
      const p = await connect();
      const r = await p.query(
        `SELECT fc FROM frames
          WHERE feed = $1 AND region = $2 AND t = $3
            AND COALESCE(payload_version, $4) = $5`,
        [feed, region, stamp.t, PAYLOAD_VERSION_BASELINE, stamp.payloadVersion]
      );
      return r.rows[0]?.fc ?? null;
    },

    // GREATEST rather than a plain assignment. Two workers polling the same
    // (feed, region) can have their upserts arrive out of order, and a stamp
    // that moves BACKWARDS would report a working feed as having last answered
    // earlier than it did — the same inversion this whole change exists to
    // remove, reintroduced by a race.
    async writeFreshness(feed, region, t) {
      const p = await connect();
      await p.query(
        `INSERT INTO feed_freshness (feed, region, fresh_as_of) VALUES ($1, $2, $3)
           ON CONFLICT (feed, region)
           DO UPDATE SET fresh_as_of = GREATEST(feed_freshness.fresh_as_of, EXCLUDED.fresh_as_of)`,
        [feed, region, t]
      );
    },

    async readFreshness(feed, region) {
      const p = await connect();
      const r = await p.query(
        'SELECT fresh_as_of FROM feed_freshness WHERE feed = $1 AND region = $2',
        [feed, region]
      );
      // No row is the ordinary case for a pair that has not polled since this
      // shipped. Guarded against a NULL rather than coerced, because Number(null)
      // is 0 — an epoch stamp that would read as "last good in 1970", which is
      // the loudest possible wrong answer.
      const stored = r.rows[0]?.fresh_as_of;
      if (stored == null) return null;
      const value = Number(stored);
      return Number.isFinite(value) ? value : null;
    },

    async prune() {
      const p = await connect();
      const r = await p.query('DELETE FROM frames WHERE t < $1', [Date.now() - RETENTION_MS]);
      return r.rowCount || 0;
    },
  };
}

// Chosen once, the same way lib/db.js chooses, so a deployment behaves the same
// way across both stores.
const backend = process.env.DATABASE_URL
  ? makePostgresFrameBackend({ connectionString: process.env.DATABASE_URL })
  : makeFileBackend();

export const archiveKind = backend.kind;

// Last archived stamp and payload hash per key, so the cadence and the
// unchanged-frame check cost nothing on the hot path.
const lastWrite = new Map(); // key -> { t, hash }

// ---------------------------------------------------------------------------
// The freshness stamp: when a feed was last known to be ANSWERING
//
// A frame's timestamp says when the DATA is from. That is not the same fact as
// whether the feed is working, and for a deduplicated layer the two diverge by
// design — the unchanged-frame skip below exists so that a static layer stops
// writing frames while it goes on polling successfully. fires, seismic and
// hotspots read zero features for days at a time, so their newest STORED frame
// is old precisely BECAUSE the feed is up and saying the same thing.
//
// Reading liveness off the newest frame therefore measured how long the world
// had been boring. Sampled on the trial 2026-08-15, three seconds after a
// deliberate restart: twelve layers answering from the archive, four of them
// (fires, news, seismic, weather) reporting NOT LIVE, all four of them working.
//
// The cadence clock already advances on the unchanged path, so the information
// existed in memory; it simply was not durable, and a restart is exactly when
// it is needed. This makes it durable.
// ---------------------------------------------------------------------------

// How often the stamp is actually persisted, per (feed, region).
//
// Measured 2026-08-16 against lib/config.js and lib/regions.js: 122 (feed,
// region) pairs have a layer active across the nineteen regions, and polling
// every one on its own TTL is 227.4 polls a minute — 13,647 an hour. A durable
// write per poll would put all of that on the archive backend, and the hot
// pairs are the ones that hurt: vessels at a 5-second TTL is 12 writes a minute
// on its own, transport and satellites 6 each.
//
// Throttled to one write per pair per interval that becomes at most 122 writes
// a minute, 7,320 an hour, and vessels drops from 12 a minute to 1. Overall
// that is a 46% cut rather than a dramatic one, because most feeds already poll
// slower than once a minute; the 12x on the hot pairs is where it earns its
// keep.
//
// What one stamp costs, measured 2026-08-16 on the file backend over 2,000
// archive() calls rotating across 122 (feed, region) pairs, best of three warm
// runs, with the noteFeedFreshness() call below patched out for the control:
//
//     archive() -> 'unchanged', no stamp     0.003 ms
//     archive() -> 'unchanged', with stamp   1.168 ms
//     freshAsOf() read, stamp present        0.318 ms
//     one stamp on disk                      29 bytes
//
// So the stamp is effectively the whole cost of a deduplicated poll, and at the
// deployed load that is 122 x 1.17 ms = about 143 ms of write time a minute,
// 0.24% of one core. Unthrottled it would be 227 x 1.17 ms = 266 ms. freshAsOf()
// is read once per (feed, region) per cold start, never per poll.
//
// The Postgres backend was NOT measured — nothing here connects to the trial
// database. There the throttle buys row churn rather than CPU: 122 upserts a
// minute against a 122-row table instead of 227.
//
// Set to ARCHIVE_INTERVAL_MS rather than to a number of its own, so a stamp
// costs at most one small write per frame interval — the cadence the archive
// already writes at. The staleness thresholds this feeds are never tighter than
// 2 * ARCHIVE_INTERVAL_MS (see staleAfterMsFor in lib/cache.js), so a stamp at
// worst one interval behind the truth still leaves a full interval of margin.
export const FRESHNESS_WRITE_INTERVAL_MS = ARCHIVE_INTERVAL_MS;

// key -> the value last actually PERSISTED, not the last poll seen. In memory
// like lastWrite, and like lastWrite it is gone after a restart — which is
// correct: the first poll of a new process writes a stamp immediately rather
// than waiting out an interval it cannot know it is inside.
const lastFreshnessWrite = new Map();

// Advance the durable stamp, at most once per FRESHNESS_WRITE_INTERVAL_MS.
//
// Returns a named outcome and never throws. A stamp that cannot be written
// costs liveness precision for one interval; it must not cost the poll, and it
// must not cost the frame the poll was about to archive.
async function noteFeedFreshness(feed, region, key, now) {
  const persisted = lastFreshnessWrite.get(key);
  if (persisted != null && now - persisted < FRESHNESS_WRITE_INTERVAL_MS) return 'throttled';

  // Claimed before the await for the same reason the cadence slot below is: on
  // a cold start several requests reach one feed at once, and without the claim
  // every one of them would write.
  lastFreshnessWrite.set(key, now);
  try {
    await backend.writeFreshness(feed, region, now);
    return 'stamped';
  } catch (err) {
    // Hand the claim back, so the next poll retries rather than waiting out a
    // full interval on a write that never landed.
    if (persisted == null) lastFreshnessWrite.delete(key);
    else lastFreshnessWrite.set(key, persisted);
    return 'stamp-failed';
  }
}

// When this feed was last known to be answering, in ms, or null if there is no
// usable stamp for this (feed, region).
//
// null is the signal for "no stamp", and it deliberately covers both "nothing
// has polled this pair since the stamp shipped" and "the freshness store cannot
// be read". lib/cache.js answers both by falling back to the frame's own
// timestamp, which is exactly the behaviour that shipped before this existed —
// so a missing or broken stamp degrades to the old rule rather than to a
// liveness claim in either direction.
export async function freshAsOf(feed, region) {
  try {
    return await backend.readFreshness(feed, region);
  } catch (err) {
    return null;
  }
}

// Fields that change on every poll while saying nothing about the data. They
// are stored — they are part of the payload contract — but they must not count
// as a difference, or nothing is ever "unchanged".
//
// This was measured wrong once and shipped. The skip below is supposed to store
// one frame for a static layer; in production it stored 11 for berths, 59 for
// facilities and 117 for camera sites over 9.6 hours, every one of them
// byte-identical apart from `generated`. The unit tests passed because their
// fixtures had no `generated` field — the one property every real feed sets.
const VOLATILE_FIELDS = ['generated', 'elements_age_minutes'];

function contentHash(fc) {
  const stable = { ...fc };
  for (const field of VOLATILE_FIELDS) delete stable[field];
  return crypto.createHash('sha1').update(JSON.stringify(stable)).digest('hex');
}

// The frames this build can actually read back, oldest first, plus a count of
// the ones it had to refuse.
//
// A frame is refused only when its shape is genuinely not this build's. For
// every feed but news that is nothing at all today: news moved to 2 when it
// left the DOC API, everything else is still at the baseline, and a frame with
// no recorded version resolves to the baseline rather than to "unknown". So the
// 12,139 rows on the trial stay readable and the pre-GKG news frames do not.
//
// The version is stored ALONGSIDE the frame — in the filename, or in a column —
// and never inside `fc`. Two reasons, and the second is the decisive one:
//
//  - Putting it in `fc` would put it inside contentHash(), and contentHash()
//    exists so a static layer stores one frame instead of 2,880 identical
//    ones. A version there would be one more field to reason about in
//    VOLATILE_FIELDS for no gain, since it changes at most once per deploy.
//  - `fc` is gzipped. A version inside it can only be read by inflating the
//    frame, so answering "which of these 2,880 frames can I serve?" would mean
//    inflating all 2,880 of them. Beside the frame, it is free — the stamps
//    query already returns it.
async function readableStamps(feed, region) {
  const expected = payloadVersionFor(feed);
  const all = await backend.stamps(feed, region);
  const readable = all.filter((s) => s.payloadVersion === expected);
  return { readable, incompatible: all.length - readable.length };
}

// Record a frame if it is due and if it says something new.
//
// Returns what it decided, which the tests assert on: 'written', 'too-soon',
// or 'unchanged'.
export async function archive(feed, region, fc, now = Date.now()) {
  const key = safeKey(feed, region);

  // Reaching here means the poll SUCCEEDED. lib/cache.js calls archive() only
  // on the success path of refreshFeed() and never from its catch, so this is
  // where the durable freshness stamp advances — and it advances for all three
  // outcomes below, including 'unchanged'. That is the case this exists for: a
  // working feed reporting the same thing again used to leave no durable trace
  // at all, so after a restart nothing could tell it apart from a dead one.
  //
  // Deliberately not folded into the return value. archive() answers 'written',
  // 'too-soon' or 'unchanged' and both callers and tests turn on those three;
  // whether the stamp was persisted this time or throttled is a different
  // question, and freshAsOf() is where to ask it.
  //
  // Above the cadence block on purpose. Everything from `const previous` to the
  // `lastWrite.set` claim further down still runs without an await between
  // them, which is the invariant that stops eight concurrent callers writing
  // eight frames.
  await noteFeedFreshness(feed, region, key, now);

  // On the first write of a process, take the cadence clock from the archive
  // rather than starting it fresh.
  //
  // `lastWrite` is in-memory, so a restart used to mean the next poll wrote
  // immediately no matter how recently the last frame had been stored. Two of
  // the 3,271 frames recorded overnight landed inside the interval that way —
  // harmless at one restart, but the unit is Restart=always with RestartSec=5,
  // so a crash loop would have written a frame every five seconds and called it
  // a minute's history.
  //
  // Seeded from the frames this build can READ, not from everything on disk. A
  // deploy that bumps a version leaves the previous build's frames sitting
  // there with recent timestamps; taking the cadence clock from one of those
  // would hold the slot for a full minute after the restart, and newestFrame()
  // would answer null for that minute because the only frames present are ones
  // it refuses. That is an empty archive at exactly the moment a restart makes
  // the archive worth having.
  if (!lastWrite.has(key)) {
    const { readable } = await readableStamps(feed, region).catch(() => ({ readable: [] }));
    if (readable.length) lastWrite.set(key, { t: readable[readable.length - 1].t, hash: null });
  }

  const previous = lastWrite.get(key);

  if (previous && now - previous.t < ARCHIVE_INTERVAL_MS) return 'too-soon';

  const json = JSON.stringify(fc);
  const hash = contentHash(fc);

  // Static layers — berths, facilities, camera sites — return an identical
  // payload every poll. Archiving 2,880 byte-identical copies of the berth
  // register would cost 34 MB over two days and tell a replay exactly nothing
  // that one copy does not, because the reader already picks the nearest
  // earlier frame.
  if (previous && previous.hash === hash) {
    // The cadence clock still advances. Without this a static layer would
    // re-hash its whole payload on every single poll rather than once a minute.
    lastWrite.set(key, { t: now, hash });
    return 'unchanged';
  }

  // Claim the slot BEFORE the first await, and note that everything above this
  // line is synchronous, so no other caller can interleave with the check.
  //
  // The first version set this marker after the gzip and the write, and the
  // cost showed up immediately: the fires layer wrote five frames inside
  // eighteen milliseconds (21:26:31.395 through .413, measured 2026-08-14).
  // On a cold start several requests reach a feed before its cache is warm,
  // every one of them passed a cadence check that nothing had yet updated, and
  // all five went on to compress and write. Claiming first makes the check and
  // the claim one indivisible step.
  lastWrite.set(key, { t: now, hash });
  try {
    const buffer = await gzip(Buffer.from(json));
    await backend.write(feed, region, now, buffer, payloadVersionFor(feed));
    return 'written';
  } catch (err) {
    // Hand the slot back. A failed write should cost this minute's frame, not
    // the next one's — leaving the claim in place would blind the archive for a
    // full interval after a transient disk error.
    if (previous) lastWrite.set(key, previous);
    else lastWrite.delete(key);
    throw err;
  }
}

// Every SERVABLE archived timestamp for a feed, oldest first. Cheap — a
// directory listing or an index scan, with no frame bodies read. Frames from a
// superseded payload version are not listed, because nothing here will return
// one and a timestamp a caller cannot fetch is worse than no timestamp.
export async function archivedStamps(feed, region) {
  const { readable } = await readableStamps(feed, region);
  return readable.map((s) => s.t);
}

// The frames covering [fromMs, toMs], oldest first, as { t, fc }.
//
// One frame BEFORE `fromMs` is included when one exists. A replay window that
// opens partway through a feed's history would otherwise render nothing until
// the first frame inside the window: the contact existed at the start of the
// window, we simply last heard about it earlier. This is the same
// nearest-earlier rule the client applies between frames, applied to the edge.
export async function framesBetween(feed, region, fromMs, toMs, maxFrames = 240) {
  // Filtered before the window is worked out rather than after, so the lead-in
  // frame is the nearest earlier frame this build can READ. Filtering
  // afterwards would let a superseded frame be chosen as the lead-in and then
  // dropped, opening the replay on an empty layer — or, worse, be chosen and
  // returned, putting the old shape on screen at the moment scrubbing starts.
  //
  // The stamp RECORDS are carried through the windowing and the thinning, not
  // just their timestamps, because read() needs to know where each frame is
  // actually stored — a pre-versioning frame lives under a name with no version
  // segment and cannot be found from its timestamp and version alone.
  const { readable } = await readableStamps(feed, region);
  if (!readable.length) return [];

  const inside = readable.filter((s) => s.t >= fromMs && s.t <= toMs);
  const earlier = readable.filter((s) => s.t < fromMs);
  const wanted = earlier.length ? [earlier[earlier.length - 1], ...inside] : inside;

  // A wide window over a dense feed can hold more frames than a browser should
  // be asked to hold at once, so thin by taking every nth. Thinning rather than
  // truncating matters: truncation would silently return the first N frames and
  // present a fraction of the window as though it were the whole of it.
  let selected = wanted;
  if (wanted.length > maxFrames) {
    const stride = Math.ceil(wanted.length / maxFrames);
    selected = wanted.filter((_, i) => i % stride === 0);
    const last = wanted[wanted.length - 1];
    if (selected[selected.length - 1] !== last) selected.push(last);
  }

  const out = [];
  for (const stamp of selected) {
    const buffer = await backend.read(feed, region, stamp);
    if (!buffer) continue;
    try {
      const fc = JSON.parse((await gunzip(buffer)).toString('utf8'));
      out.push({ t: stamp.t, count: fc.features?.length ?? 0, fc });
    } catch { /* a corrupt frame is skipped, not fatal to the window */ }
  }
  return out;
}

// The newest archived frame, used by lib/cache.js as a last-good payload when
// an upstream call fails and nothing is in memory — which is the state after
// every restart, and the reason the news layer came back empty rather than
// showing yesterday's articles while GDELT was rate-limiting us.
//
// An archive holding nothing but superseded frames answers null, the same as an
// archive holding nothing at all. That is deliberate and it is what lib/cache.js
// relies on: both callers there already treat null as "no archived payload" and
// fall through to the live path, so an unreadable archive degrades to an empty
// one rather than to an error the layer never had. There is no repair path and
// no serve-with-a-warning path — a frame in the wrong shape put invented
// positions and a NOT LIVE indicator on the london region on the public trial,
// which is worse than showing nothing for the one request it takes to refresh.
//
// For every feed except news this is now a path that never fires, and that is
// the point: only news changed shape, so only news loses its history to it.
export async function newestFrame(feed, region) {
  const { readable } = await readableStamps(feed, region);
  if (!readable.length) return null;
  const stamp = readable[readable.length - 1];
  const buffer = await backend.read(feed, region, stamp);
  if (!buffer) return null;
  try {
    return { t: stamp.t, fc: JSON.parse((await gunzip(buffer)).toString('utf8')) };
  } catch {
    return null;
  }
}

// Exported for the tests and for the archive status the replay bar reports.
//
// Counts only what framesBetween() would actually return. The replay bar sizes
// its scrub range from this, so counting frames the reader refuses would claim
// two days of history over an archive that can serve the last twenty minutes of
// it. `incompatible_frames` is the named signal for the difference: those
// frames exist, they are spending the retention budget, and they cannot be
// shown.
export async function coverage(feed, region) {
  const { readable, incompatible } = await readableStamps(feed, region);
  if (!readable.length) {
    return { frames: 0, from: null, to: null, incompatible_frames: incompatible };
  }
  return {
    frames: readable.length,
    from: readable[0].t,
    to: readable[readable.length - 1].t,
    incompatible_frames: incompatible,
  };
}

export function _resetCadenceState() {
  lastWrite.clear();
  // The freshness throttle is in-memory state exactly like the cadence clock,
  // so a test simulating a restart has to clear both. What must NOT be cleared
  // is the PERSISTED stamp — outliving the process is the whole point of it,
  // and a reset that wiped it would make the restart tests pass for the wrong
  // reason.
  lastFreshnessWrite.clear();
}

// Pruning normally runs as housekeeping every PRUNE_EVERY_WRITES writes, which
// a test would have to write two hundred frames to trigger. Exposed so the
// retention rule can be asserted directly rather than inferred.
export function _pruneNow() {
  return backend.prune();
}
