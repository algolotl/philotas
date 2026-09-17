// Aviation — live ADS-B state vectors.
// Region-aware: a bounded region queries a bbox; the world region has no
// spatial filter. OpenSky is bring-your-own-credentials and opt-in; adsb.fi is
// the keyless default for every region. No military filtering, by design.

const OPENSKY = 'https://opensky-network.org/api/states/all';
const OPENSKY_TOKEN_URL = 'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token';

const I = {
  icao24: 0, callsign: 1, origin_country: 2, longitude: 5, latitude: 6,
  baro_altitude: 7, on_ground: 8, velocity: 9, true_track: 10, vertical_rate: 11,
  geo_altitude: 13, squawk: 14,
};

// OpenSky moved to OAuth2 client-credentials. Cache the bearer token until it
// nears expiry so we don't mint one per request.
let tokenCache = null; // { token, expires }

async function openskyToken() {
  const id = process.env.OPENSKY_CLIENT_ID;
  const secret = process.env.OPENSKY_CLIENT_SECRET;
  if (!id || !secret) return null;
  if (tokenCache && Date.now() < tokenCache.expires) return tokenCache.token;

  const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: id, client_secret: secret });
  const res = await fetch(OPENSKY_TOKEN_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body,
  });
  if (!res.ok) throw new Error(`OpenSky auth ${res.status}`);
  const data = await res.json();
  tokenCache = { token: data.access_token, expires: Date.now() + (data.expires_in - 30) * 1000 };
  return tokenCache.token;
}

// What this region's ADS-B coverage was measured to be, said out loud, whatever
// this particular poll returned.
//
// adsb.fi is a volunteer feeder network and its coverage, not the sky, is the
// ceiling. Two runs on 2026-08-16 at 150 nm agreed that five regions read zero —
// vladivostok, jeddah, kuwait, babelmandeb and guam — and disagreed about a
// sixth: run 1 read Ningbo at 0 aircraft, run 2 at 1. So "blind" and
// "unmeasured" are different findings and are reported as different findings.
// A region flagged on one sample and not another is not sparse; it is unproven,
// and saying otherwise is publishing a claim about a working port.
//
// The readings are quoted rather than summarised, because the verdict cannot
// settle every case. Shanghai read 5 and 5 across both runs and classifies as
// covered, and five aircraft within 150 nm of that port is plainly feeder
// scarcity — but the two runs contain no gap wide enough to place a threshold
// (the widest below 55 aircraft is 7, from 17 to 24), so the numbers are shown
// and the reader draws the line the data cannot.
function withCoverageNotice(featureCollection, region) {
  const coverage = region?.params?.aviation?.coverage;
  if (!coverage || coverage.state === 'covered') return featureCollection;

  const measurements = coverage.readings
    .map((reading) => `${reading.aircraft} on ${reading.probedAt} (${reading.run})`)
    .join(', ');
  const finding = coverage.state === 'blind'
    ? 'No volunteer ADS-B feeder is in range: every probe run read zero here'
    : 'ADS-B feeder coverage here is not established — the probe runs disagree';

  return {
    ...featureCollection,
    notice: `${finding}. Measured: ${measurements}. A low count reflects volunteer feeder density, not the traffic overhead.`,
  };
}

// Bring-your-own OpenSky. OpenSky's terms restrict use to non-profit research
// and education and require a written licence for integration into a live
// product, so it is opt-in: both client credentials AND the explicit
// OPENSKY_ENABLE=1 flag. Absent that, adsb.fi — which carries no such
// restriction — is the source for every region, including the world view.
export function openskyEnabled(env = process.env) {
  return Boolean(env.OPENSKY_CLIENT_ID && env.OPENSKY_CLIENT_SECRET && String(env.OPENSKY_ENABLE) === '1');
}

export function selectAviationSource(env = process.env) {
  return openskyEnabled(env) ? 'OpenSky' : 'adsb.fi';
}

const OPEN_SKY_BYO = 'OpenSky requires bring your own credentials (OPENSKY_CLIENT_ID and OPENSKY_CLIENT_SECRET) plus OPENSKY_ENABLE=1, and its non-commercial terms apply.';

export async function fetchAviation(region) {
  if (openskyEnabled()) {
    // Opted-in OpenSky. Bounded regions keep adsb.fi primary with OpenSky as
    // the fallback; the world view has no global adsb.fi equivalent and reads
    // OpenSky's global feed.
    if (region?.bbox) {
      // withCoverageNotice runs OUTSIDE this try. It used to run inside the
      // adsb.fi attempt, so a throw from it (e.g. a malformed coverage record)
      // was caught as if adsb.fi itself had failed: the operator was told a
      // working upstream was down, and the catch block burned a real OpenSky
      // call — against the same tight daily quota described above — chasing a
      // fault that had nothing to do with either aviation source.
      let featureCollection;
      try {
        featureCollection = await fetchAdsbFi(
          region.bbox,
          region?.params?.aviation?.cap,
          region?.params?.aviation?.radiusNm
        );
      } catch (adsbError) {
        try {
          featureCollection = await fetchOpenSky(region);
        } catch (openSkyError) {
          // Both named. The previous form was `catch { throw err; }`, which threw
          // the adsb.fi error and discarded the OpenSky one entirely — so an
          // outage in the fallback was invisible in the logs and the operator saw
          // a message about a source that might not have been the problem.
          throw new Error(`aviation unavailable: adsb.fi — ${adsbError.message}; OpenSky — ${openSkyError.message}`);
        }
      }
      return withCoverageNotice(featureCollection, region);
    }
    return withCoverageNotice(await fetchOpenSky(region), region);
  }

  // adsb.fi is the source.
  if (region?.bbox) {
    try {
      return withCoverageNotice(
        await fetchAdsbFi(region.bbox, region?.params?.aviation?.cap, region?.params?.aviation?.radiusNm),
        region,
      );
    } catch (adsbError) {
      // OpenSky is named even though it was not attempted, so the operator can
      // see the opt-in that would provide a fallback rather than reading a
      // source that might not have been the problem.
      throw new Error(`aviation unavailable: adsb.fi — ${adsbError.message}; OpenSky — not configured (${OPEN_SKY_BYO})`);
    }
  }

  // world: no bbox, so no adsb.fi radius query, and OpenSky is opt-in. Report
  // the empty layer and why, rather than silently dropping or scraping OpenSky
  // keylessly. Matches the "layers report empty and say why" pattern.
  return {
    type: 'FeatureCollection',
    features: [],
    generated: Date.now(),
    source: 'adsb.fi',
    notice: `Aviation unavailable worldwide — ${OPEN_SKY_BYO}`,
  };
}

async function fetchOpenSky(region) {
  const bbox = region?.bbox;
  const url = bbox
    ? `${OPENSKY}?lamin=${bbox.south}&lomin=${bbox.west}&lamax=${bbox.north}&lomax=${bbox.east}`
    : OPENSKY;

  // A (free) OpenSky account raises the rate limit dramatically. Preferred:
  // OAuth2 client credentials (OPENSKY_CLIENT_ID / OPENSKY_CLIENT_SECRET).
  const headers = { 'User-Agent': 'parallax-demo/0.1' };
  const token = await openskyToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  else if (process.env.OPENSKY_USER && process.env.OPENSKY_PASS) {
    headers.Authorization = 'Basic ' + Buffer.from(`${process.env.OPENSKY_USER}:${process.env.OPENSKY_PASS}`).toString('base64');
  }

  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`OpenSky ${res.status}`);
  const data = await res.json();

  const cap = region?.params?.aviation?.cap;
  let states = (data.states || []).filter((s) => s[I.longitude] != null && s[I.latitude] != null);
  if (cap && states.length > cap) states = states.slice(0, cap);

  const features = states.map((s) => {
    const callsign = (s[I.callsign] || '').trim() || null;
    return {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [s[I.longitude], s[I.latitude]] },
      properties: {
        layer: 'aviation', id: s[I.icao24], callsign, country: s[I.origin_country],
        altitude_m: s[I.baro_altitude] ?? s[I.geo_altitude] ?? null,
        velocity_ms: s[I.velocity], heading: s[I.true_track] ?? 0,
        vertical_rate: s[I.vertical_rate], squawk: s[I.squawk],
        on_ground: !!s[I.on_ground], title: callsign || s[I.icao24], source: 'OpenSky',
      },
    };
  });
  return { type: 'FeatureCollection', features, generated: data.time ? data.time * 1000 : Date.now() };
}

// Keyless community ADS-B (adsb.fi) — radius query around the region centre.
async function fetchAdsbFi(bbox, cap, radiusNm) {
  const lat = (bbox.south + bbox.north) / 2;
  const lon = (bbox.west + bbox.east) / 2;
  const latNm = (bbox.north - bbox.south) * 60;
  const lonNm = (bbox.east - bbox.west) * 60 * Math.cos((lat * Math.PI) / 180);
  // A region may set its own catchment. Deriving the radius from the map
  // bounding box ties how much traffic we see to how far the map is zoomed
  // out, which is the wrong coupling: measured over London the bbox-derived
  // 37 nm returned 22 aircraft where 150 nm returns roughly three times as
  // many, from the same volunteer network.
  const derived = Math.ceil(Math.sqrt((latNm / 2) ** 2 + (lonNm / 2) ** 2)) || 50;
  const dist = Math.min(250, radiusNm || derived);

  const res = await fetch(`https://opendata.adsb.fi/api/v2/lat/${lat.toFixed(4)}/lon/${lon.toFixed(4)}/dist/${dist}`,
    { headers: { 'User-Agent': 'parallax-demo/0.1' } });
  if (!res.ok) throw new Error(`adsb.fi ${res.status}`);
  const data = await res.json();

  let craft = (data.aircraft || data.ac || []).filter((a) => a.lat != null && a.lon != null);
  if (cap && craft.length > cap) craft = craft.slice(0, cap);

  const features = craft.map((a) => {
    const callsign = (a.flight || '').trim() || null;
    return {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [a.lon, a.lat] },
      properties: {
        layer: 'aviation', id: a.hex, callsign, country: a.r || null,
        altitude_m: typeof a.alt_baro === 'number' ? Math.round(a.alt_baro * 0.3048) : null,
        velocity_ms: a.gs != null ? a.gs * 0.514444 : null,
        heading: a.track ?? 0, squawk: a.squawk, on_ground: a.alt_baro === 'ground',
        title: callsign || a.hex, source: 'adsb.fi',
      },
    };
  });
  return { type: 'FeatureCollection', features, generated: Date.now() };
}
