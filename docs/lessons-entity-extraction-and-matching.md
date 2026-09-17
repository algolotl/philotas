# Lessons: entity extraction and matching

Written 2026-08-15, from measurements taken while replacing the LLM link
adjudication path. Each lesson names the measurement that produced it, because a
lesson without its evidence decays into a slogan and gets argued with later.

---

## 1. Model size buys a better guess, not an answer

Asked to type the entity `COLLAROY`, three models disagreed:

| model | answer |
|---|---|
| Qwen2.5-Coder-7B, constrained decoding | `Facility` |
| Qwen2.5-Coder-7B, loose prompt | `Organization` |
| Qwen3-Next-80B | `Vessel` |

None of them knew. All three inferred a type from sentence context. Parallax
already held the answer: COLLAROY is in the live Transport for NSW feed with a
type, an operator and a berth history.

Escalating model size on a question the system can answer from its own data is
paying compute to approximate your own database, and it produces a confident
answer that happens to be wrong 2 times in 3.

**Rule.** Resolve against authoritative data first, a reference set second, and
a model only for what neither owns.

---

## 2. Split models by task shape, not by apparent difficulty

Extraction and adjudication read as the same class of problem. Measured, they
are opposites.

| task | shape | measured |
|---|---|---|
| pull entities out of prose | generation | 7B: 88% span recall, 100% grounded |
| decide whether a headline refers to an entity | discrimination | 80B: 17,585 ms for 40 pairs; cross-encoder: 145 ms |

A cross-encoder is trained for the second task and beats an 80B generative model
by two orders of magnitude in latency at it. A generative model is the right
tool for the first and a small one suffices.

**Rule.** Ask what shape the decision is before choosing what makes it.
Generation to a generator, discrimination to a discriminator, lookup to a
database.

---

## 3. Groundedness is a check, not a hope

Requiring that every extracted span appear verbatim in its source turns "do we
trust this model" into a string comparison. Measured, both the 7B and the 80B
returned 100% verbatim spans, so the check costs nothing on the common path and
converts hallucination from a risk into a filter that runs at write time.

**Rule.** Store an extraction only if it is verifiable without the model that
produced it.

---

## 4. Constrained decoding is mandatory for small models

Given a prompt that described the desired JSON but did not declare a schema, the
7B invented its own:

```json
{"vessel": "COLLAROY", "location": "Balmain"}
```

With `response_format: {type: 'json_schema'}` it conformed on every call. The
first recall measurement in this project returned 0% purely because of this, and
that 0% was a harness failure being read as a model failure.

**Rule.** Declare the schema at the API. An undeclared schema means you are
measuring your parser.

---

## 5. The scoring function is a hypothesis, and it can be the thing that is wrong

Extraction recall was first reported as 71% and a design was nearly written
around it. Scored properly it is 88%.

The first method compared label strings. That counted `St Vincent's Hospital,
Darlinghurst` as a miss because the baseline emitted it as two entities, and
credited the baseline for `NSW` (extracted from "NSW Health") and for
`IMO 9776171` typed as a Vessel. Neither difference is a recall failure and one
of them is the baseline being worse.

Character-overlap scoring across three documents: 88% (22 of 25), 100% grounded.
At n=25 that is not distinguishable from a 90% threshold in either direction.

**Rule.** When a result is disappointing, suspect the ruler before the thing
being measured. State n, and state the interval.

---

## 6. Untyped is a legitimate answer

A span that resolves to no known entity keeps its offsets and its embedding, so
it stays searchable and linkable. What it does not do is claim a type nobody can
defend.

The resolution order is authoritative, then gazetteer, then nearest-profile
marked as inferred, then untyped. Only the third is probabilistic and it is
labelled as such wherever it appears.

**Rule.** A gap an operator can fill beats a confident invention. Never let a
model's guess enter the store wearing the same clothes as a fact.

---

## 7. Silent caps and silent timeouts destroy quality with no error anywhere

Two lines did this in the same function:

- `candidates.slice(0, 40)` dropped everything past the fortieth with no log.
- `AbortSignal.timeout(20_000)` with `catch { return null }` fell back to
  heuristics whenever a batch ran long.

Measured, a 40-candidate batch took 17,585 ms against that 20,000 ms abort and
1,851 tokens against a 2,048 ceiling: 12% and 10% of margin, both failing
silently. Under contention an independent review measured roughly 3x those
latencies, at which point the fallback fires every time and the system reports
`heuristic` — which the code's own comment notes "reads as 'the model is down'
to an operator".

This is the same shape as three unrelated defects found in this codebase on the
same day: a NOT LIVE banner over a working layer, a frame-cadence race that
wrote five frames in eighteen milliseconds, and an unchanged-frame optimisation
that never fired once in production.

**Rule.** Every cap logs what it dropped. Every fallback says it fell back. A
degraded state that looks identical to a healthy one will be found by a customer.

---

## 8. The index you assume you need may be the wrong one

The design specified HNSW with pgvector's iterative index scans for scope-
filtered retrieval. Measured on 100,000 `vector(1024)` rows across 500 cases,
asking for the top 10 within one case:

| approach | latency | rows returned of 10 |
|---|---|---|
| unfiltered ANN | 0.8 ms | 10 |
| pre-filtered in SQL | 1.9 ms | 10, exact |
| post-filter top 1,000 | 4.0 ms | **1** |
| exact scan, no index | 11.5 ms | 10 |

Postgres does not use the HNSW index at all once a scope predicate is present.
It bitmap-scans the btree, retrieves the 200 matching rows and sorts them by
exact distance — perfect recall by construction, nothing to tune, and the
`hnsw.iterative_scan` setting made no difference to the plan. The index would
have cost 777 MB per 100,000 rows to be ignored.

**Rule.** Approximate search is for scopes too large to scan. Measure the scope
before buying an index for it.

---

## 9. Post-filtering a vector search is a correctness bug

The same measurement: fetching the global top 1,000 and then filtering to one
case returned **one** result where ten were asked for. The security argument
against post-filtering was already sound, since an embedding is a lossy copy of
its source. The correctness argument is stronger and easier to demonstrate.

**Rule.** Filter in the query, not after it.

---

## 10. Two disagreeing measurements are data, not a contradiction

An independent review measured 18.1 s and 66 s where this project measured 6.2 s
and 17.6 s for the same batches. Neither was wrong: one fleet was idle and one
was contended. The 3x gap between them is what made the case for capping the
batch, because it is the difference between comfortably inside a timeout and
reliably outside it.

**Rule.** When two measurements disagree, find the variable rather than picking
a winner. The variable is usually the finding.

---

## 11. Measurement perturbs the system

An investigation into capacity browsed every region in the region selector.
Per `lib/cache.js`, requesting a region starts a background poller that then runs
for the life of the process, so all eleven regions began polling and the `world`
region — the only one without a bounding box, and so the only one reaching
OpenSky at 4 credits per call — consumed an estimated 2,880 of a 4,000/day quota
for a region nobody was watching.

The investigation also then counted those regions and reported them as a
property of the deployment.

**Rule.** Before measuring a live system, ask what the measurement starts.
Prefer a disposable copy: the vector experiments above ran in their own database
for exactly this reason.

---

## Inherited from `algolotl-mono`, and still true here

- Store `embed_model` on every embedded row. Re-embedding with a different model
  otherwise leaves two incompatible vector spaces in one index and cosine
  distance quietly stops meaning anything.
- Count tokens with the serving model's tokenizer at chunk time, not with a
  character estimate.
- No bare `catch {}`. That pattern contaminated months of evidence there, and
  produced the silent heuristic fallback here.
