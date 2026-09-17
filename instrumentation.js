// instrumentation.js
//
// Next.js calls register() once per server start, before the first request is
// served. This is the startup path the semantic schema needed and did not have —
// see lib/schema/startup.js for why nothing was applying it.
//
// TWO THINGS ABOUT THIS FILE'S SHAPE ARE LOAD-BEARING.
//
// First, the runtime test EXCLUDES edge rather than requiring nodejs, and it is
// a positive branch around a DYNAMIC import.
//
// The exclusion direction is the important half. An unset NEXT_RUNTIME must
// apply the schema, not skip it: this hook exists so a fresh install provisions
// itself with nobody running a migration, and any process that imports it
// without Next having set the variable — a container entrypoint, a warm-up
// script, a future worker — would otherwise come up with no tables, no error and
// a reassuring log line. `=== 'nodejs'` fails closed in exactly the case that
// matters most and reads as though it were the careful choice. This fails open:
// only the one runtime that provably cannot do the work is excluded.
//
// The dynamic-import half is what keeps the edge bundle clean. This file is
// compiled for every runtime the app has, edge included — `.next/server/edge/`
// holds an edge build of it on the current tree, so this is live, not
// hypothetical — and the edge runtime has no net/tls/dns and therefore no
// Postgres driver. Next substitutes NEXT_RUNTIME with a per-runtime literal, so
// in the edge build the condition below is statically false and the import
// inside it is never added to that bundle. Measured 2026-08-17, cold builds:
// this shape gives 4 warnings (all pre-existing, in lib/frames.js) and a ~640-byte
// edge chunk with the branch folded away. A static top-level import with an early
// return gives 11 warnings — process.cwd plus Node's filesystem, crypto and
// promise-filesystem builtins, all reported unsupported in the Edge Runtime — a
// 6,582-byte edge chunk plus a new 81,404-byte chunk, and the file backend's JSON
// datastore path pulled into the edge tree. Same intent, opposite outcome.
//
// Those module names are deliberately spelled out in prose rather than quoted
// verbatim: source maps carry this comment's text into the edge tree, so writing
// them literally makes `grep -rl <builtin> .next/server/edge/` match this comment
// and report a dependency that is not there. Measured 2026-08-17 — it matched the
// .js.map only, never the chunk. Do not put the literal specifiers back; they are
// the check that this branch was dropped.
//
// Second, it declines OUT LOUD. A hook that silently does nothing is
// indistinguishable from a hook that ran and worked, and the symptom either way
// is retrieval quietly returning no results weeks later.

export async function register() {
  if (process.env.NEXT_RUNTIME !== 'edge') {
    try {
      const { ensureSemanticSchema } = await import('./lib/schema/startup.js');
      const result = await ensureSemanticSchema();
      if (result.applied) console.log('[schema] semantic schema applied');
      // Every other outcome has already logged itself, by name, in
      // lib/schema/startup.js — including the benign ones.

      // Detection workflows evaluate on a timer so they fire even when nobody
      // has the page open. Same containment rule as the schema above: a broken
      // engine must never take the map down with it.
      try {
        const { startWorkflowEngine } = await import('./lib/workflows.js');
        startWorkflowEngine();
      } catch (engineErr) {
        console.error('[workflow] engine failed to start: ' + String(engineErr?.message || engineErr));
      }
    } catch (err) {
      // A live guard, not a formality, and not unreachable. ensureSemanticSchema()
      // is written not to throw and the tests hold it to that, but the `await
      // import` above rejects if anything in that subtree fails to EVALUATE, which
      // is a separate hazard: lib/db.js selects its file-backend factory at
      // module scope, and that factory reads the working directory, which throws
      // ENOENT if the directory was removed under the process. Any future import
      // or syntax
      // error under lib/schema/ arrives the same way. Module evaluation is exactly
      // what a boot hook must not propagate. Not covered by a test: removing a
      // live process's own cwd is not something a test can do on Windows, so this
      // branch is deliberately unkilled and named rather than assumed impossible.
      console.error(`[schema] the startup hook itself failed, and retrieval is unavailable: ${String(err?.message || err)}`);
    }
    return;
  }
  console.log(`[schema] startup hook skipped: NEXT_RUNTIME is ${process.env.NEXT_RUNTIME}, which has no Postgres driver, so the semantic schema is applied by the node runtime instead`);
}
