// Which field identifies ONE vehicle across polls.
//
// A trail is built by appending each poll's position for a key and drawing the
// result as a line. So the key is the whole correctness argument: get it wrong
// and the line is not a path, it is a chord between two different vehicles.
//
// Extracted from components/MapView.jsx so it can be tested. MapView is a
// client component that touches `window` at import, so nothing in it is
// reachable under bare `node --test` — which is why the defect below shipped
// with a green suite. Same reason lib/feed-health.js exists.
//
// Measured against the live Sydney transport feed on 2026-08-17, 3,302 vehicles:
//
//   trip    present on 3,301   3,301 distinct   unique per vehicle
//   label   present on 3,276   3,075 distinct   201 collisions
//   route   present on 3,294   1,092 distinct   shared by design
//
// The original order was `label || trip || route`. A bus's `label` is its route
// number — "4973", "2800" — so every bus on that route shared one trail and the
// line jumped between them: 395 of 3,316 vehicles shared a key, and the worst
// cases were three buses on one route spread 156 km apart, drawn as a single
// straight line across the network. Ferries and trains mostly escaped it,
// because their labels are timetabled services and those are unique; buses are
// 90% of the layer, so the layer as a whole did not.
//
// `trip` is the scheduled service id — CI0745-WD-IN.170826.31.0819 — and stays
// with one vehicle for one run, which is exactly the span a trail should cover.

export function trailKey(layerId, properties) {
  if (!properties) return null;
  if (layerId === 'aviation') return properties.id || null;
  if (layerId === 'transport') {
    return properties.trip || properties.label || properties.route || null;
  }
  return null;
}
