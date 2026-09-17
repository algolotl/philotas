// AI-driven ontology pass over the live feeds.
//
// Pipeline:
//   1. INDUCE   — map heterogeneous feeds to object types (the semantic model).
//   2. RESOLVE  — find cross-feed links (entity resolution). Structural links are
//                 deterministic; ambiguous "news mentions X" links are scored by a
//                 cross-encoder reranker, with no link asserted when the score
//                 falls in the undecided band or the reranker is unreachable.
//   3. EMIT     — a versioned artifact: object types, link types, resolved links,
//                 each link carrying confidence + provenance + method (the harness).
//
// The point this demonstrates: the ontology is *induced and resolved*, not hand-
// built by engineers — and every edge is auditable, not magic.

import { llmAvailable } from './llm.js';
import { scoreCandidates } from './score.js';
import { haversineMetres } from '../geo.js';

// Feed -> object type in the induced model.
const TYPE_OF = {
  aviation: 'Aircraft', satellites: 'Satellite', transport: 'TransportVehicle', cameras: 'Camera',
  space: 'GroundStation', fires: 'FireIncident', seismic: 'Earthquake',
  weather: 'WeatherStation', news: 'NewsArticle',
  vessels: 'Vessel', berths: 'Berth', facilities: 'Facility', hotspots: 'Hotspot',
};

const LINK_TYPES = [
  { id: 'tracks',   label: 'tracks',   description: 'A ground station actively downlinking from a spacecraft' },
  { id: 'same_as',  label: 'same as',  description: 'Two sources describe the same physical object' },
  { id: 'mentions', label: 'mentions', description: 'A news article refers to a live entity' },
  { id: 'context',  label: 'context',  description: 'An incident sits within a sensor’s observation region' },
  { id: 'berthed_at', label: 'berthed at', description: 'A vessel is alongside a berth or terminal' },
  { id: 'coincides_with', label: 'coincides with', description: 'Two things overlap in time and place. CORRELATION, not causation — the interface says so in those words' },
];

// A vessel counts as alongside when it is inside the berth radius AND not
// making way. Both conditions matter: a ferry passing a wharf at 12 knots is
// not berthed at it.
const BERTHED_MAX_SPEED_KNOTS = 0.8;
// How close a transport vehicle must be to a berth to count toward the load
// around it. Circular Quay's wharves, station and bus stands sit within this.
const TRANSPORT_NEAR_BERTH_METRES = 400;
// Below this many vehicles, "load" is just the normal timetable.
const TRANSPORT_LOAD_THRESHOLD = 3;
// How far a surface weather observation is treated as representative. Chosen to
// be defensible rather than convenient: beyond this the station tells you very
// little about conditions at the incident.
const WEATHER_OBSERVATION_RADIUS_KM = 75;

// How many candidate links go to the adjudicator in one batch.
//
// This was 40, which sat too close to two ceilings that both fail silently.
// Measured on the reference deployment against a local 80B model on 2026-08-15, an idle fleet:
//
//     n=10   6,185 ms   451 completion tokens
//     n=20   8,305 ms   626
//     n=40  17,585 ms  1,851
//
// lib/ontology/llm.js aborts at 20,000 ms and asks for at most 2,048 tokens, so
// n=40 leaves 12% of the time budget and 10% of the token budget. An
// independent review of this same code on contended hardware measured roughly
// three times those latencies; apply that factor and n=40 takes 53 s, exceeds
// the abort, and falls back to heuristics without an error, while n=10 still
// lands. The gap between the two measurements is the reason for the cap rather
// than an argument about which one is right.
//
// Link scoring has since moved to the cross-encoder (lib/ontology/score.js),
// where the equivalent batch measured 145 ms and this ceiling stopped being
// the binding constraint. The cap is left at 10 pending a decision on whether
// to raise it — that figure above was never remeasured against the new path.
const ADJUDICATION_BATCH_CAP = 10;

function norm(s) { return (s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }

function entityId(feed, p, i) {
  return `${feed}:${p.id || p.norad || p.label || p.trip || p.title || p.callsign || i}`;
}

// 1. INDUCE — object types from the feeds, with sampled property names + counts.
function induce(feeds) {
  const objectTypes = [];
  const entities = {}; // type -> [ {type, feed, id, label, coord, props} ]

  for (const [feed, fc] of Object.entries(feeds)) {
    const type = TYPE_OF[feed];
    if (!type) continue;
    const features = fc?.features || [];
    const mapped = features.map((f, i) => ({
      type, feed,
      id: entityId(feed, f.properties || {}, i),
      label: f.properties?.title || f.properties?.callsign || f.properties?.friendly || f.properties?.norad || `${type} ${i}`,
      coord: f.geometry?.coordinates || null,
      props: f.properties || {},
    }));
    // Multiple feeds can map to the same object type (e.g. news + cafenews).
    entities[type] = (entities[type] || []).concat(mapped);
    objectTypes.push({
      id: type, feed, count: features.length,
      properties: features[0] ? Object.keys(features[0].properties || {}).filter((k) => k !== 'layer').slice(0, 8) : [],
    });
  }
  return { objectTypes, entities };
}

// 2. RESOLVE — cross-feed links.
async function resolve(entities) {
  const links = [];

  // 2a. Spacecraft entities induced from DSN "tracking" fields, + tracks links.
  const spacecraft = new Map();
  for (const gs of entities.GroundStation || []) {
    const tracking = gs.props.tracking;
    if (!tracking) continue;
    for (const name of tracking.split(',').map((s) => s.trim()).filter(Boolean)) {
      const id = `spacecraft:${name}`;
      if (!spacecraft.has(id)) spacecraft.set(id, { type: 'Spacecraft', id, label: name, coord: null, props: { name } });
      links.push(mkLink('tracks', gs, spacecraft.get(id), 1, 'structural', `${gs.label} reports active downlink target "${name}"`));
    }
  }
  entities.Spacecraft = [...spacecraft.values()];

  // 2b. Satellite <-> Spacecraft: same physical object seen by two sources.
  for (const sat of entities.Satellite || [])
    for (const sc of entities.Spacecraft || [])
      if (norm(sat.label) === norm(sc.label))
        links.push(mkLink('same_as', sat, sc, 0.9, 'name-match', `TLE name matches tracked spacecraft "${sat.label}"`));

  // 2c. FireIncident -> WeatherStation: incident within the station's region.
  //
  // "Within the observation region" has to mean something. The first version
  // linked the first twelve incidents to the first station with no distance
  // test at all, which asserted that a Sydney station observes a fire 600km
  // away on the Queensland border -- a provenance string that was simply
  // false. A surface observation is broadly representative for tens of
  // kilometres, not hundreds, so the link now requires it and carries the
  // measured distance rather than a claim.
  const ws = (entities.WeatherStation || [])[0];
  if (ws?.coord) {
    for (const fire of entities.FireIncident || []) {
      if (!fire.coord) continue;
      const distanceKm = haversineMetres(fire.coord, ws.coord) / 1000;
      if (distanceKm > WEATHER_OBSERVATION_RADIUS_KM) continue;
      // Confidence falls off with distance rather than sitting flat: an
      // incident 5km from the station is far better characterised by it than
      // one at 70km.
      const confidence = Number((0.6 * (1 - distanceKm / WEATHER_OBSERVATION_RADIUS_KM) + 0.2).toFixed(2));
      links.push(mkLink('context', fire, ws, confidence, 'spatial',
        `${Math.round(distanceKm)}km from ${ws.label}, inside the ${WEATHER_OBSERVATION_RADIUS_KM}km radius treated as representative for surface observations`));
    }
  }

  // 2c-i. Vessel -> Berth: which ship is alongside which wharf. Structural and
  // deterministic — geometry and speed, no model involved.
  const berthed = new Map(); // berth entity id -> [vessel entities]
  for (const vessel of entities.Vessel || []) {
    if (!vessel.coord) continue;
    const speedKnots = vessel.props.speed_knots;
    if (speedKnots == null || speedKnots > BERTHED_MAX_SPEED_KNOTS) continue;

    for (const berth of entities.Berth || []) {
      if (!berth.coord) continue;
      const radius = berth.props.radius_metres ?? 250;
      const distance = haversineMetres(vessel.coord, berth.coord);
      if (distance > radius) continue;

      links.push(
        mkLink('berthed_at', vessel, berth, 0.95, 'spatial',
          `${Math.round(distance)}m from ${berth.label} at ${speedKnots.toFixed(1)}kn — inside the ${radius}m berth radius and not making way`)
      );
      if (!berthed.has(berth.id)) berthed.set(berth.id, []);
      berthed.get(berth.id).push(vessel);
      break; // a hull is alongside one berth
    }
  }

  // 2c-ii. The convergence link — where the sea meets the city.
  //
  // A vessel is alongside a berth, and an unusual number of transport vehicles
  // are around that berth at the same moment. This is the link that makes
  // Circular Quay legible: a ship arrives and you watch the city absorb it.
  //
  // It is CORRELATION and it is labelled as such, here and in the UI. A ferry
  // terminal is busy on a timetable regardless of what berthed next to it, and
  // a product that quietly implied causation would not deserve the audit trail
  // it advertises.
  for (const [berthId, vessels] of berthed) {
    const berth = (entities.Berth || []).find((b) => b.id === berthId);
    if (!berth?.coord) continue;

    const nearby = (entities.TransportVehicle || []).filter(
      (vehicle) => vehicle.coord && haversineMetres(vehicle.coord, berth.coord) <= TRANSPORT_NEAR_BERTH_METRES
    );
    if (nearby.length < TRANSPORT_LOAD_THRESHOLD) continue;

    const modes = [...new Set(nearby.map((vehicle) => vehicle.props.mode).filter(Boolean))];
    for (const vessel of vessels) {
      links.push(
        mkLink('coincides_with', vessel, berth, 0.5, 'spatial-temporal',
          `${vessel.label} alongside ${berth.label} while ${nearby.length} transport vehicles ` +
          `(${modes.join(', ') || 'mixed'}) are within ${TRANSPORT_NEAR_BERTH_METRES}m. ` +
          `Co-occurrence only — no causal claim.`)
      );
    }
  }

  // 2d. NewsArticle -> live entity. Candidate generation by callsign/keyword,
  //     then adjudicated by the LLM (if available) or heuristics.
  const KEYWORDS = [
    { type: 'FireIncident', re: /\b(bushfire|wildfire|grassfire|fire|blaze|ember|rfs)\b/i, base: 0.5 },
    { type: 'Earthquake',   re: /\b(earthquake|quake|magnitude|seismic|tremor)\b/i,        base: 0.55 },
    { type: 'Satellite',    re: /\b(satellite|orbit|rocket|launch|spacecraft|space)\b/i,   base: 0.5 },
    { type: 'Aircraft',     re: /\b(flight|raaf|jet|aircraft|airport|aviation)\b/i,        base: 0.45 },
    { type: 'Vessel',       re: /\b(ship|vessel|cargo|container|tanker|cruise|port|wharf|berth|freight|shipping)\b/i, base: 0.4 },
    { type: 'Berth',        re: /\b(port botany|circular quay|white bay|terminal|wharf|stevedor)\b/i, base: 0.5 },
  ];
  const candidates = [];
  for (const art of entities.NewsArticle || []) {
    const title = art.props.title || '';
    const upper = title.toUpperCase();
    for (const ac of entities.Aircraft || []) {
      const cs = (ac.props.callsign || '').trim();
      if (cs.length >= 4 && upper.includes(cs)) candidates.push({ art, target: ac, base: 0.8, why: `callsign ${cs} in headline` });
    }
    for (const k of KEYWORDS) {
      if (!k.re.test(title)) continue;
      for (const t of (entities[k.type] || []).slice(0, 3)) candidates.push({ art, target: t, base: k.base, why: `keyword cue for ${k.type}` });
    }
    // A headline naming a specific ship. This is the strongest news link in the
    // maritime picture and the one the LLM most earns its place on: "Ever Given"
    // in a headline is unambiguous, but plenty of vessel names are ordinary
    // English words, so the model has to decide whether the headline is about
    // the hull or about the phrase.
    const lower = title.toLowerCase();
    for (const vessel of entities.Vessel || []) {
      const name = (vessel.label || '').toLowerCase();
      if (name.length > 4 && lower.includes(name)) {
        candidates.push({ art, target: vessel, base: 0.7, why: `vessel name "${vessel.label}" in headline` });
      }
    }
    // A headline naming a specific berth or terminal.
    for (const berth of entities.Berth || []) {
      const name = (berth.label || '').toLowerCase();
      if (name.length > 6 && lower.includes(name)) {
        candidates.push({ art, target: berth, base: 0.7, why: `berth "${berth.label}" in headline` });
      }
    }
  }
  const capped = candidates.slice(0, ADJUDICATION_BATCH_CAP);
  if (candidates.length > capped.length) {
    // A cap that drops work silently reads as "there was nothing more to link".
    console.warn(
      `[ontology] adjudication cap: ${candidates.length - capped.length} candidate(s) dropped ` +
      `(${candidates.length} generated, cap ${ADJUDICATION_BATCH_CAP})`
    );
  }

  // Three distinct outcomes, not two. Reporting "heuristic" when the model was
  // never called reads as "the model is down" to an operator, which is exactly
  // the wrong inference when the truth is that nothing needed adjudicating.
  // Ambiguous links only arise from news, so an empty or rate-limited news feed
  // produces no candidates at all.
  let adjudication = 'none-required';
  let verdicts = null;
  let banded = 0;
  let degraded = null;
  if (capped.length > 0) {
    const result = await scoreCandidates(
      capped.map((c) => ({ headline: c.art.label, entity: `${c.target.type}: ${c.target.label}`, hint: c.why }))
    );
    verdicts = result.verdicts;
    banded = result.banded;
    degraded = result.degraded;
    adjudication = degraded ? 'degraded' : 'cross-encoder';
  }
  const usedLlm = false;

  capped.forEach((c, i) => {
    const v = verdicts?.find((x) => x.i === i);
    if (!v || !v.keep) return;                 // rejected, banded, or unscored
    links.push(mkLink('mentions', c.art, c.target, v.confidence, v.method, v.why));
  });

  return { links, usedLlm, adjudication, candidateCount: capped.length, banded, degraded };
}

function mkLink(type, from, to, confidence, method, provenance) {
  return {
    id: `${type}:${from.id}->${to.id}`,
    type,
    fromType: from.type, fromLabel: from.label, fromCoord: from.coord,
    toType: to.type, toLabel: to.label, toCoord: to.coord,
    confidence: Number(confidence.toFixed(2)), method, provenance,
  };
}

// The induced entity set, flattened, for callers that need the entities rather
// than the artifact — the profile refresh in service.js is the only one today.
// Kept OUT of the artifact deliberately: /api/ontology spreads that object
// straight into Response.json, so a field added there is served to every client.
//
// Flat rather than the type -> entities map induce() builds internally, because
// that map is not iterable and a consumer handing it to something expecting
// entities gets "is not iterable" on the first line — a failure that looks, from
// outside, exactly like a deployment with nothing configured.
//
// Spacecraft are absent: they are induced inside resolve() from the DSN tracking
// field rather than from a feed, and they carry no attributes a profile would
// describe beyond the name that is already the label.
export function induceEntities(feeds) {
  return Object.values(induce(feeds).entities).flat();
}

export async function buildOntology(feeds) {
  const { objectTypes, entities } = induce(feeds);
  const { links, usedLlm, adjudication, candidateCount, banded, degraded } = await resolve(entities);

  const entityCount = Object.values(entities).reduce((a, b) => a + b.length, 0);
  const byType = {};
  for (const l of links) byType[l.type] = (byType[l.type] || 0) + 1;

  return {
    version: 1,
    generatedAt: Date.now(),
    // 'cross-encoder'  — the reranker scored the ambiguous links
    // 'degraded'       — the reranker was unreachable; no links were asserted
    // 'none-required'  — no ambiguous links existed, so nothing needed scoring
    method: adjudication,
    // Retained for consumers that only care whether a model produced the edges.
    // Always false now: link scoring no longer calls a generative model.
    usedLlm,
    candidatesAdjudicated: candidateCount,
    candidatesBanded: banded,
    scoringDegraded: degraded,
    llmConfigured: llmAvailable(),
    objectTypes: objectTypes.concat(
      entities.Spacecraft?.length ? [{ id: 'Spacecraft', feed: 'derived', count: entities.Spacecraft.length, properties: ['name'] }] : []
    ),
    linkTypes: LINK_TYPES,
    links: links.sort((a, b) => b.confidence - a.confidence),
    stats: { entities: entityCount, links: links.length, byType },
  };
}
