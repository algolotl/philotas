// Corpus source registry — add a source by writing one file that exports
// `{ id, sourceLabel, search(entity) -> rawDoc[] }` and listing it here. Same
// one-file-per-source shape as lib/connectors/registry.js, for the same
// reason: adding a source should never require touching the orchestration
// code in lib/corpus/retrieve.js.

import { id as gdeltId, sourceLabel as gdeltLabel, search as gdeltSearch } from './gdelt.js';
import { id as nswHealthId, sourceLabel as nswHealthLabel, search as nswHealthSearch } from './nswhealth.js';
import { id as amsaId, sourceLabel as amsaLabel, search as amsaSearch } from './amsa.js';

export const SOURCES = [
  { id: gdeltId, label: gdeltLabel, search: gdeltSearch },           // api — GDELT DOC 2.0, keyless, already 429ing under load
  { id: nswHealthId, label: nswHealthLabel, search: nswHealthSearch }, // api — real RSS, client-side filtered (no query param upstream)
  { id: amsaId, label: amsaLabel, search: amsaSearch },              // stub — no real endpoint found; always []
];
