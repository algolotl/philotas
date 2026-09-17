// What shape a feed's payload is in, as an integer a human bumps.
//
// The durable archive in lib/frames.js survives a deploy. That is the whole
// point of it — the news layer stopped coming back empty after a restart
// because a frame from a minute ago was still on disk. It also means a frame
// written by the PREVIOUS build is still on disk, and until this module existed
// there was nothing to tell it apart from one the current build wrote.
//
// Deployed to the reference deployment on 2026-08-16 at 368f7e7, the first request for the london
// region after the restart returned `count=60 src=None live=False window=None`
// with its one article on the London centroid [-0.1126, 51.5074]. That is the
// DOC-API shape: 60 is that API's per-query cap and the centroid is the
// invented placement the GKG rewire existed to remove. The archive served it as
// though it were current because it had no notion of payload format.
//
// ---------------------------------------------------------------------------
// Why an explicit constant rather than something derived
//
// The obvious cheap version is a hash of the payload's property names. It does
// not work. `notice` is set only when a feed has something to say — see
// lib/feeds/news.js, where it appears on an upstream outage and on a region
// with no coverage, and is absent otherwise. A name hash would change every
// time a notice appeared or cleared, so the archive would invalidate itself
// several times a day and the 48-hour replay would never accumulate. Same for
// any other optional field.
//
// So it is a number, and changing a feed's payload shape means changing it
// here.
//
// ---------------------------------------------------------------------------
// Why an absent version means 1 rather than "unknown"
//
// The first cut of this module treated a frame with no version marker as
// unreadable, on the reasoning that there is no safe way to guess its shape.
// That reasoning is wrong, and it is expensive. We know exactly what shape
// those frames are: whatever the code produced before versioning existed. For
// every feed except news that shape is still the current one, because news is
// the only layer whose payload actually changed.
//
// Measured on the trial database, 2026-08-16: the `frames` table holds 12,139
// rows with no payload_version column at all. Treating all of them as
// unreadable would discard two days of replay history for berths, facilities,
// cameras, vessels, satellites, hotspots and the rest in order to fix one feed.
//
// So version 1 IS the pre-versioning shape — a real, known shape rather than a
// guess — and a frame that does not say otherwise is at version 1. News moved
// to 2, so its stale frames are skipped and every other layer keeps its 48
// hours. Nothing on disk or in Postgres is rewritten to make this work; see the
// note above the file backend's stamps() in lib/frames.js.
// ---------------------------------------------------------------------------

import { NEWS_PAYLOAD_VERSION } from './feeds/news.js';

// The shape everything was in before frames carried a version. A frame with no
// version marker reads as this, and so does a feed that has never declared one.
export const PAYLOAD_VERSION_BASELINE = 1;

// The register of payload shapes, one line per feed.
//
// Listed even where the value is the baseline, so this file answers "was this
// feed's shape reviewed?" and not merely "which feed changed?". An entry that
// equals PAYLOAD_VERSION_BASELINE is a positive statement that the layer's
// payload is still what it was before versioning — checked against the trial's
// archived frames on 2026-08-16, not assumed.
//
// A feed missing from this map still resolves to the baseline, which is the
// correct answer for a newly added feed and for any connector registered at
// runtime through lib/connectors/registry.js. The map is documentation with
// teeth, not the enforcement mechanism.
const DECLARED_PAYLOAD_VERSIONS = {
  aviation:   PAYLOAD_VERSION_BASELINE,
  satellites: PAYLOAD_VERSION_BASELINE,
  vessels:    PAYLOAD_VERSION_BASELINE,
  transport:  PAYLOAD_VERSION_BASELINE,
  cameras:    PAYLOAD_VERSION_BASELINE,
  fires:      PAYLOAD_VERSION_BASELINE,
  hotspots:   PAYLOAD_VERSION_BASELINE,
  seismic:    PAYLOAD_VERSION_BASELINE,
  weather:    PAYLOAD_VERSION_BASELINE,
  space:      PAYLOAD_VERSION_BASELINE,
  // The one layer whose shape genuinely moved. See lib/feeds/news.js.
  news:       NEWS_PAYLOAD_VERSION,
};

// The version the CURRENT build writes, and the only version it will read back.
export function payloadVersionFor(feed) {
  return DECLARED_PAYLOAD_VERSIONS[feed] ?? PAYLOAD_VERSION_BASELINE;
}

// The single definition of "a frame that does not say what shape it is".
//
// Both storage backends call this: the file backend for a filename with no
// `.v<n>` segment, the Postgres backend for a NULL payload_version. Neither
// rewrites anything to record the answer — the absence IS the record, and it
// reads as the baseline every time it is loaded.
export function resolveStoredPayloadVersion(stored) {
  return stored == null ? PAYLOAD_VERSION_BASELINE : Number(stored);
}
