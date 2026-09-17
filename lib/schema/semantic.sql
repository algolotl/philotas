-- lib/schema/semantic.sql
-- Semantic layer: documents, chunks, entity profiles, resolved links.
--
-- No HNSW index. Measured 2026-08-15 on 100,000 vector(1024) rows across 500
-- cases: with a scope predicate present the planner takes a bitmap scan on
-- (case_id, clearance) and sorts 200 rows by exact distance in 1.9 ms, ignoring
-- HNSW entirely. The index would have cost 777 MB per 100,000 rows to sit
-- unused. It is added later, only if a scope is measured above ~20,000 chunks.

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS documents (
  id               TEXT PRIMARY KEY,
  case_id          TEXT NOT NULL,
  filename         TEXT NOT NULL,
  mime             TEXT NOT NULL,
  sha256           TEXT NOT NULL,
  uploaded_by      TEXT NOT NULL,
  uploaded_ms      BIGINT NOT NULL,
  clearance        SMALLINT NOT NULL DEFAULT 0,
  extraction_state TEXT NOT NULL DEFAULT 'pending',
  UNIQUE (case_id, sha256)
);

CREATE TABLE IF NOT EXISTS chunks (
  id          TEXT PRIMARY KEY,
  doc_id      TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  case_id     TEXT NOT NULL,
  clearance   SMALLINT NOT NULL,
  ord         INT NOT NULL,
  content     TEXT NOT NULL,
  content_tsv TSVECTOR GENERATED ALWAYS AS (to_tsvector('english', coalesce(content,''))) STORED,
  embedding   VECTOR(1024),
  embed_model TEXT,
  token_count INT,
  created_ms  BIGINT NOT NULL
);

-- Load-bearing: this is the index the planner actually uses.
CREATE INDEX IF NOT EXISTS chunks_scope ON chunks (case_id, clearance);
CREATE INDEX IF NOT EXISTS chunks_tsv ON chunks USING gin (content_tsv);

CREATE TABLE IF NOT EXISTS entity_profiles (
  entity_key   TEXT PRIMARY KEY,
  entity_type  TEXT NOT NULL,
  label        TEXT NOT NULL,
  aliases      TEXT[] NOT NULL DEFAULT '{}',
  profile_text TEXT NOT NULL,
  embedding    VECTOR(1024),
  embed_model  TEXT,
  updated_ms   BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS entity_profiles_trgm ON entity_profiles USING gin (label gin_trgm_ops);
CREATE INDEX IF NOT EXISTS entity_profiles_type ON entity_profiles (entity_type);

CREATE TABLE IF NOT EXISTS entity_links (
  id            TEXT PRIMARY KEY,
  from_key      TEXT NOT NULL,
  to_key        TEXT NOT NULL,
  link_type     TEXT NOT NULL,
  confidence    REAL NOT NULL,
  method        TEXT NOT NULL,
  threshold_ver TEXT,
  provenance    TEXT NOT NULL,
  decided_ms    BIGINT NOT NULL,
  decided_by    TEXT,
  UNIQUE (from_key, to_key, link_type)
);
