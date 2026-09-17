// Which error messages may be sent to a caller.
//
// The problem this solves. A route handler catching an exception cannot tell,
// from the exception alone, whether the message is an answer the caller is
// entitled to or a fact about our infrastructure. Both arrive as a bare
// `new Error(...)`, so `catch (err) { return { error: err.message } }` — which is
// what app/api/auth/register/route.js did on a FULLY UNAUTHENTICATED POST —
// forwards both. When the datastore is unreachable the message Node produces is
// `connect ECONNREFUSED <host>:<port>`, the host and port of DATABASE_URL; when
// an INSERT is refused it names a constraint, which is the schema.
//
// The rule: a message is disclosable only if the code that raised it SAID SO at
// the throw site. Nothing that escapes from a driver, the filesystem or the
// network can say so, so nothing that escapes is disclosable, and no allow-list
// of message patterns has to be kept in step with a dependency's wording.
//
// This is not "return a generic error". "username already taken" is not a leak,
// it is the answer, and a registration route that cannot say it is unusable.
// That message is raised deliberately, so it is marked, so it goes out.
//
// The brand is an own property rather than only an instanceof check. Route
// modules are bundled per-route by Next, and a class identity that is duplicated
// across bundles would make `instanceof` answer false for an error raised by the
// same source file — failing in the direction of hiding "username already taken"
// from every caller, silently. A boolean property survives that.

export class DisclosableError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'DisclosableError';
    this.disclosable = true;
  }
}

// Strict on both sides: `err?.` so a `throw null` is refused rather than
// crashing the handler that is trying to be careful, and `=== true` so an
// unrelated truthy field named `disclosable` on a driver error cannot open the
// gate.
export function isDisclosable(err) {
  return err?.disclosable === true;
}
