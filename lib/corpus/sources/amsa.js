// AMSA (Australian Maritime Safety Authority) marine notices.
//
// NO REAL MACHINE-READABLE ENDPOINT FOUND. Checked directly (curl, not
// assumed from documentation) on 2026-08-14 before writing this stub:
//
//   - https://www.amsa.gov.au/rss.xml returns HTTP 200 with a genuine
//     application/rss+xml content-type, but an EMPTY <channel> — no <item>
//     elements. It's the site's generic Drupal front-page aggregator feed,
//     not a marine-notices feed, and it has nothing in it.
//   - The marine notices index
//     (amsa.gov.au/about/regulations-and-standards/index-marine-notices) is a
//     Drupal 10 view with no <link rel="alternate" type="application/rss+xml">
//     in its <head> — Drupal views normally advertise their own feed display
//     there when one exists, and this one doesn't.
//   - Guessed conventional paths (/index-marine-notices/feed,
//     /news-community/rss, /news-community/newsletters/rss) all 404.
//   - No Drupal JSON:API (/jsonapi -> 404) and the marine-notices view
//     doesn't support ?_format=json (-> 406 Not Acceptable).
//   - AMSA's own subscription mechanism for new marine notices is an EMAIL
//     alert (see the index page), not a feed of any kind.
//
// Per the house rule for this file: no real endpoint means an honest empty
// stub, not an invented one. If AMSA ever ships a real feed, wire it here —
// don't work around the absence with scraping the HTML index, which would
// be a maintenance trap disguised as a data source.

export const id = 'amsa';
export const sourceLabel = 'AMSA';

export async function search() {
  return [];
}
