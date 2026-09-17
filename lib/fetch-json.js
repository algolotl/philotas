// Fetch JSON, or throw.
//
// Every read route requires a session, and a denied request still returns a
// well-formed JSON body: {"error":"authentication required"}. Code that did
// `.then((r) => r.json()).then(setState)` therefore stored that error object as
// though it were data, and the next render dereferenced a field that was not
// there. In MiniGraph that was `graph.nodes.map(...)`, which threw during
// render and tore down the whole React tree — the map went blank and the page
// sometimes failed to load outright.
//
// Throwing here means the existing `.catch(() => {})` at each call site leaves
// the component on its safe initial state instead.

export async function getJson(url, options) {
  const res = await fetch(url, options);
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
}
