// NSW Health — media releases, including public health alerts (measles
// exposure sites, blood-borne virus notices and the like).
//
// REAL FEED, verified 2026-08-14 by fetching it directly (curl, not guessed
// from documentation): NSW Health's site is SharePoint, and the human-facing
// page at health.nsw.gov.au/news/Pages/rss-nsw-health.aspx is HTML that
// EXPLAINS the RSS feed — it is not the feed itself (its content-type is
// text/html). The actual feed is SharePoint's generic list-feed endpoint,
// scoped to the /news list via the `web`/`page`/`wp`/`pageurl` query params
// below; it 302-redirects once and then serves real RSS 2.0
// (content-type text/xml) with current items, e.g. "Measles alert for Potts
// Point, Darlinghurst and Sydney CBD" and "Bloodborne virus risk for
// patients of dental practice in Strathfield". FEED_URL is copied verbatim
// from that redirect chain; treat the querystring as opaque, not something
// to "clean up".
//
// There is no query parameter on this endpoint — SharePoint serves one fixed
// recent-items list, not a search API — so search() fetches that list and
// filters client-side for the entity's label. That's an honest description
// of what NSW Health actually offers: this will only surface an alert that
// happens to name the entity (a suburb a Berth sits in, a facility name),
// never a general "everything about X" search.

import { XMLParser } from 'fast-xml-parser';
import { corpusRequest } from '../limit.js';

const FEED_URL = 'https://www.health.nsw.gov.au/_layouts/15/feed.aspx?xsl=1&web=%2Fnews' +
  '&page=4ac47e14-04a9-4016-b501-65a23280e841&wp=baabf81e-a904-44f1-8d59-5f6d56519965' +
  '&pageurl=%2Fnews%2FPages%2Frss-nsw-health.aspx';

const parser = new XMLParser({ ignoreAttributes: true });

// SharePoint's <item> shape doesn't vary and fast-xml-parser only collapses
// to a single object (not a one-element array) when there's exactly one
// item — same ambiguity lib/feeds/space.js works around for DSN's XML.
function asArray(x) { return x == null ? [] : Array.isArray(x) ? x : [x]; }

export const id = 'nswhealth';
export const sourceLabel = 'NSW Health';

// pubDate here is e.g. "Monday, 22 Jun 2026" — a full weekday name and no
// time/timezone, not RFC 822. V8's loose Date parser accepts it; exported so
// a source-format regression (NSW Health changes their date rendering) shows
// up as a specific failing assertion instead of a silent null everywhere.
export function parsePubDate(pubDate) {
  if (!pubDate) return null;
  const ms = Date.parse(pubDate);
  return Number.isFinite(ms) ? ms : null;
}

// items -> raw docs matching entityLabel by substring across title +
// description. Exported for testing only (pure, no network).
export function filterItems(items, entityLabel) {
  const needle = String(entityLabel || '').trim().toLowerCase();
  if (!needle) return [];
  return items
    .filter((item) => item?.link)
    .filter((item) => `${item.title || ''} ${item.metadata_description || ''}`.toLowerCase().includes(needle))
    .map((item) => ({
      url: item.link,
      title: item.title || null,
      source: 'nswhealth',
      published_ms: parsePubDate(item.pubDate),
      snippet: item.metadata_description || null,
      language: 'en',
    }));
}

export async function search(entity) {
  if (!entity?.entity_label) return [];

  const text = await corpusRequest(id, async () => {
    const res = await fetch(FEED_URL, { headers: { 'User-Agent': 'parallax-corpus/0.1' } });
    if (res.status === 429) {
      const err = new Error('NSW Health 429');
      err.status = 429;
      throw err;
    }
    if (!res.ok) throw new Error(`NSW Health ${res.status}`);
    return res.text();
  });

  const doc = parser.parse(text);
  const items = asArray(doc?.rss?.channel?.item);
  return filterItems(items, entity.entity_label);
}
