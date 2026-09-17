// Which contacts are being drawn from a live feed and which are not, decided
// from the same fields the header chips and the not-live banner already use.
//
// A notice is information, not a fault. A feed says two separate things about
// itself: whether it has anything to report, and whether what it is showing is
// current. Conflating those is the recurring defect in this interface, and it
// has now shipped in five different places in a week:
//
//   * `st.source !== 'ais'` flagged every layer once AIS was dropped, because a
//     live TfNSW feed reporting 'tfnsw+portauthority' is not 'ais'.
//   * `live: features.length > 0` flagged a working news layer that simply had
//     nothing to report.
//   * `st.live === false || !!st.from_archive_ms` flagged twelve working layers
//     for the ten seconds after every restart, telling the operator "upstream
//     has not answered since" while the upstream was mid-poll.
//   * Inferring `live` from the presence of a notice put a NOT LIVE banner over
//     a satellite layer that was serving live objects from its fallback.
//   * And the footer counters, which read `b.notice ? 0 : b.count` — so a layer
//     with anything at all to say about itself had its ENTIRE contact count
//     moved into the "not live" column, while the chip beside it read green
//     because the chip class never looks at `notice`.
//
// Measured on the trial, 2026-08-17: the satellites layer reports count 91,
// live true, no error, and a notice reading "Live fetch failed: CelesTrak GP
// (HTTP 403)" because its fallback source is serving correctly. Ninety-one
// working positions were sitting in the not-live column beside a green chip.
//
//   * And the sixth, which is what this file now exists to prevent rather than
//     to commit: `live === false || error` in the footer, against
//     `live === false || (error && !(count > 0))` in the phone summary. One
//     failed poll over a warm cache — adsb.fi 503s while 120 aircraft are still
//     in the cache — produces `{ error: 'adsb.fi 503', stale: true, live: true,
//     from_archive_ms: null }` at lib/cache.js's refreshFeed catch, because
//     `live` there is `archivedAt == null || <last known good within the TTL>`.
//     The footer filed all 120 of those contacts as not live while the summary
//     beside it called the same feed live and no banner appeared.
//
//   * And once more in lib/feeds/satellites.js, where the payload's own `live`
//     ended `&& out.length > 0` under a comment saying only an unreachable
//     source could make it false. An observer region keeps what is above its
//     horizon at that instant, a filter applied after the fetch, so an empty
//     sky is an ordinary outcome of a fetch that worked — and it declared
//     itself not live. Same shape as the news layer's `features.length > 0`,
//     two entries up, in another file.
//
// So the rule: a layer's data is degraded when the layer says its data is not
// current (`live === false`). Having something to say about itself is not that,
// and neither is one failed poll over data the cache has already judged current
// — the aircraft on the screen are real aircraft. The error does not disappear:
// it still drives the header chip, and a feed erroring with nothing to show is
// still down. What it must not do is silently reclassify good data.
//
// `stale` is deliberately NOT part of this rule, even though the header chip
// turns amber on it. lib/cache.js:290-302 serves a cold-start archive frame
// with `stale: true, error: null, live: true`, which is the state of every
// layer for the first seconds after a restart. Counting those as degraded would
// reinstate the third defect above in a new place.
//
// Consumed by app/page.jsx for the footer totals AND for the phone header's
// per-feed summary. Both, from here, because those are the two consumers that
// had drifted apart — the rule now has one implementation and they call it. It
// lives here rather than inline in the component so that it is testable at all:
// the component is a client-side JSX module that bare `node --test` cannot
// import, which is why this defect survived a suite that already had four tests
// about notices.

/**
 * What one feed's status says about itself: 'pending', 'live' or 'down'.
 *
 * Three states, not two, because a feed that has not answered yet is neither
 * working nor broken and counting it as broken is the same defect one more
 * time. `error` only decides anything when the feed has nothing to show for
 * itself: an error over a live payload is a failed poll, and a failed poll over
 * current data is a working layer.
 */
export function feedLiveness(feedStatus) {
  if (!feedStatus) return 'pending';
  if (feedStatus.live === false) return 'down';
  if (feedStatus.error && !(feedStatus.count > 0)) return 'down';
  return 'live';
}

/**
 * The `live` an API route reports for one feed, from what getFeed() returned.
 *
 * Two separate claims, and both have to hold. The feed itself can declare its
 * payload not current — lib/feeds/satellites.js does exactly that when every
 * source is unreachable and it is propagating from the element set on disk.
 * Independently, lib/cache.js can declare an archived payload too old to still
 * be the picture. Reporting either one alone loses half the answer.
 *
 * Saying nothing means live. Most payloads never mention the field, and a feed
 * that does not comment on its own currency has not thereby declared itself
 * degraded — inferring otherwise is the defect catalogued at the top of this
 * file, every entry on that list.
 *
 * `feedResult` is required, and deliberately not defended against. Written
 * `feedResult?.payload?.live !== false` this would answer `true` for a feed
 * that is not there at all, and a wholly-absent feed reported as live is the
 * failure this module exists to stop. Both routes always have an entry to pass;
 * if that ever stops being true, a TypeError is the honest outcome.
 */
export function feedResultIsLive(feedResult) {
  return feedResult.payload.live !== false && feedResult.live !== false;
}

export function splitContactCounts(statusById) {
  let liveContacts = 0;
  let degradedContacts = 0;
  for (const feedStatus of Object.values(statusById || {})) {
    // A feed that has not reported yet has nothing to attribute to either
    // column. `count` is null or absent while a layer is still loading, and
    // `pending` layers arrive here at zero.
    const count = feedStatus?.count || 0;
    if (!count) continue;
    // Same function the phone summary calls, so the two cannot answer
    // differently about the same feed. With `count > 0` established above,
    // `feedLiveness`'s error clause cannot fire here — which is the point: the
    // footer and the summary reach the same verdict for every feed that has
    // contacts to file, by construction rather than by two rules kept in step
    // by hand.
    if (feedLiveness(feedStatus) === 'down') degradedContacts += count;
    else liveContacts += count;
  }
  return { liveContacts, degradedContacts };
}
