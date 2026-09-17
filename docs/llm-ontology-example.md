# Local LLM (local Qwen) — worked example

How the local Qwen on **the reference deployment** enhances the ontology pass. The heuristic resolver
generates *candidate* cross-source links from keyword/spatial cues; Qwen
adjudicates the ambiguous ones, keeping the correct links and rejecting the
plausible-but-wrong ones — each with a confidence and a one-line rationale.

The request/response below is the exact wire shape (`/v1/chat/completions`,
`PHILOTAS_LLM_URL=http://localhost:8000/v1/chat/completions`,
`ONTOLOGY_MODEL=qwen2.5-instruct`).

## The situation (Worldwide view)

Live at the time of this example:

- **Seismic** (USGS, last 24h): many quakes, including
  `M5.1 South Sandwich Islands`, `M4.9 127 km SSE of Itoman, Japan`,
  `M6.6 133 km ESE of Petropavlovsk, Russia`.
- **News** (GDELT): among others —
  `"Strong M6.6 quake rattles Russia's Kamchatka coast near Petropavlovsk"`.

## 1. Heuristic candidates (before)

The keyword cue ("quake") in that headline matches **every** recent earthquake
entity — so the heuristic proposes the article is linked to the three largest,
all at the same flat confidence:

```
news:"Strong M6.6 quake … Petropavlovsk"  —mentions→  M6.6 Petropavlovsk   0.55  heuristic
news:"Strong M6.6 quake … Petropavlovsk"  —mentions→  M5.1 South Sandwich  0.55  heuristic
news:"Strong M6.6 quake … Petropavlovsk"  —mentions→  M4.9 Itoman, Japan   0.55  heuristic
```

Two of those three are **wrong** — the article is about Kamchatka, not the South
Sandwich Islands or Japan. Keyword matching can't tell them apart.

## 2. Request sent to Qwen on the reference deployment

```json
POST http://localhost:8000/v1/chat/completions
{
  "model": "qwen2.5-instruct",
  "temperature": 0,
  "response_format": { "type": "json_object" },
  "messages": [
    { "role": "system", "content": "You are an entity-resolution adjudicator … decide whether the headline genuinely refers to that specific entity — not merely the same category … Return ONLY a JSON object {\"verdicts\":[{\"i\",\"keep\",\"confidence\",\"why\"}]}." },
    { "role": "user", "content": "Adjudicate these candidate links:\n[
      {\"i\":0,\"headline\":\"Strong M6.6 quake rattles Russia's Kamchatka coast near Petropavlovsk\",\"entity\":\"Earthquake: M6.6 133 km ESE of Petropavlovsk, Russia\"},
      {\"i\":1,\"headline\":\"Strong M6.6 quake rattles Russia's Kamchatka coast near Petropavlovsk\",\"entity\":\"Earthquake: M5.1 South Sandwich Islands region\"},
      {\"i\":2,\"headline\":\"Strong M6.6 quake rattles Russia's Kamchatka coast near Petropavlovsk\",\"entity\":\"Earthquake: M4.9 127 km SSE of Itoman, Japan\"}
    ]" }
  ]
}
```

## 3. Qwen output

```json
{
  "verdicts": [
    { "i": 0, "keep": true,  "confidence": 0.97, "why": "headline names Petropavlovsk and M6.6 — exact match" },
    { "i": 1, "keep": false, "confidence": 0.02, "why": "South Sandwich is the opposite hemisphere" },
    { "i": 2, "keep": false, "confidence": 0.04, "why": "Japan quake, headline is Kamchatka" }
  ]
}
```

## 4. Resolved links (after)

The pipeline keeps only kept verdicts above threshold, stamped `llm` with the
model's rationale as provenance:

```
news:"Strong M6.6 quake … Petropavlovsk"  —mentions→  M6.6 Petropavlovsk   0.97  llm
        why: "headline names Petropavlovsk and M6.6 — exact match"
```

In the dashboard the `AI ONTOLOGY` badge flips to **LLM**, the link shows a green
`llm` method tag, and the rationale renders under each link.

## How it enhanced the output — before vs after

| | Heuristic only | With local Qwen |
|---|---|---|
| Links from this headline | 3 | 1 |
| Correct | 1 of 3 | 1 of 1 |
| Confidence | flat 0.55 | calibrated (0.97 vs ~0.03) |
| Rationale / audit | "keyword cue" | a specific, human-readable reason |
| Wrong links surfaced | 2 | 0 |

Net effect: **precision goes from 33% to 100%** on this headline, confidences
become meaningful, and every kept link carries an auditable reason. The structural
links (DSN dish *tracks* spacecraft, etc.) are unaffected — they were already
deterministic and high-confidence; Qwen only adjudicates the soft "mentions"
links where category-level keyword matching is ambiguous.

> If the endpoint is unreachable, the pass falls back to the heuristic resolver and the
> badge stays `heuristic` — same audit trail, just without the adjudication step.
