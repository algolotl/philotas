// Datastore with two interchangeable backends behind one async repository:
//   - Postgres  when DATABASE_URL is set (production)
//   - a local JSON file otherwise (.data/philotas-db.json — zero-config dev)
// The repository interface (below) is identical either way, so nothing upstream
// changes when you point DATABASE_URL at a real database.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { DEFAULT_TEAM_ID, DEFAULT_TEAM_NAME } from './teams.js';

const impl = process.env.DATABASE_URL ? pgBackend() : fileBackend();

export const findUserByUsername = (u) => impl.findUserByUsername(u);
export const insertUser = (user) => impl.insertUser(user);
export const insertSession = (s) => impl.insertSession(s);
export const deleteSession = (t) => impl.deleteSession(t);
export const findUserByToken = (t) => impl.findUserByToken(t);
// `user`, not `userId`: every implementation below reads user.id, user.clearance
// and user.username, so the old name described neither the argument nor what the
// clearance gate does with it.
export const listWorkspaces = (user) => impl.listWorkspaces(user);
export const getWorkspace = (id) => impl.getWorkspace(id);
export const upsertWorkspace = (ws) => impl.upsertWorkspace(ws);
export const deleteWorkspace = (id, ownerId) => impl.deleteWorkspace(id, ownerId);
export const addAction = (a) => impl.addAction(a);
export const listActions = (region, n) => impl.listActions(region, n);
export const addRule = (r) => impl.addRule(r);
export const listRules = () => impl.listRules();
export const deleteRule = (id) => impl.deleteRule(id);
export const countUsers = () => impl.countUsers();
export const listUsers = () => impl.listUsers();
export const setUserRole = (id, role, clearance) => impl.setUserRole(id, role, clearance);
export const addAudit = (e) => impl.addAudit(e);
export const listAudit = (n) => impl.listAudit(n);

// --- vision: detections + workflows ---
// Written by the /api/detection/* routes, read by the VISION panel and the
// workflow engine. Both backends implement all of these - unlike the maritime
// and corpus blocks below, this traffic is bounded (one row per detection) and
// the file backend can absorb it.
export const addDetections = (rows) => impl.addDetections(rows);
export const listDetections = (opts) => impl.listDetections(opts);
export const addWorkflow = (w) => impl.addWorkflow(w);
export const listWorkflows = () => impl.listWorkflows();
export const deleteWorkflow = (id) => impl.deleteWorkflow(id);
export const updateWorkflow = (id, fields) => impl.updateWorkflow(id, fields);
export const addWorkflowRun = (r) => impl.addWorkflowRun(r);
export const listWorkflowRuns = (opts) => impl.listWorkflowRuns(opts);
export const latestWorkflowRun = (workflowId) => impl.latestWorkflowRun(workflowId);
// Demo seeding (scripts/seed-demo.mjs): remove previously seeded rows and tag
// a fired run as part of the seeded example, so the UI can label it honestly.
export const clearDemoData = () => impl.clearDemoData();
export const updateWorkflowRun = (id, detail) => impl.updateWorkflowRun(id, detail);

// --- teams and invitations ---
// Membership only. Nothing reads these to widen a scope yet — the workspace
// lister gains its team term in a separate change, so a mistake in the schema
// cannot become a disclosure here. See lib/teams.js for why every instance has
// exactly one team, and why a team confers membership and never a ceiling.
export const teamIdsForUser = (userId) => impl.teamIdsForUser(userId);
export const addTeamMember = (teamId, userId, joinedMs) => impl.addTeamMember(teamId, userId, joinedMs);
export const removeTeamMember = (teamId, userId) => impl.removeTeamMember(teamId, userId);
export const insertInvitation = (row) => impl.insertInvitation(row);
export const claimInvitation = (tokenHash, nowMs, userId) => impl.claimInvitation(tokenHash, nowMs, userId);
export const listInvitations = (teamIds) => impl.listInvitations(teamIds);
// Test-only: re-runs the boot-time backfill, which is what a restart does. Named
// for what it is rather than `_reapply`, so nobody mistakes it for a migration.
export const applyBaseSchemaTwice = () => impl.applyBaseSchemaTwice();

// --- maritime: written by philotas-ingest, read-only from the app ---
// The file backend does not implement these. Vessel state is high-frequency
// write traffic and the file backend rewrites the whole database on every
// mutation; pointing ingest at it would corrupt the file within minutes.
// Returning empty makes the vessels feed fall back to its labelled sample,
// which is the correct behaviour for a zero-configuration dev run.
export const listVessels = (bbox) => impl.listVessels(bbox);
export const listEvents = (region, n) => impl.listEvents(region, n);
export const listCaseFiles = (region, n) => impl.listCaseFiles(region, n);
export const getCaseFile = (id) => impl.getCaseFile(id);

// --- corpus: OSINT enrichment storage, written by lib/corpus/*, read by the
// corpus/connections UI. Same file-backend exception as the maritime block
// above and for the same reason: this is background write traffic (a ~250
// entity sweep against rate-limited sources) that the file backend's
// rewrite-the-whole-file-on-every-mutation model cannot survive. Returning
// empty here just means a zero-config dev run has no corpus panel, which is
// the correct degraded behaviour rather than a corrupted .data file.
export const upsertCorpusDocuments = (rows) => impl.upsertCorpusDocuments(rows);
export const recordEntityMentions = (rows) => impl.recordEntityMentions(rows);
export const documentsForEntity = (entityKey, limit) => impl.documentsForEntity(entityKey, limit);
export const entitiesSharingDocuments = (entityKey, limit) => impl.entitiesSharingDocuments(entityKey, limit);
export const documentsById = (ids) => impl.documentsById(ids);
export const dueForEnrichment = (limit) => impl.dueForEnrichment(limit);
export const markEnrichmentState = (entityKey, fields) => impl.markEnrichmentState(entityKey, fields);
export const enrichmentStateKeys = () => impl.enrichmentStateKeys();

// --- semantic layer: documents / chunks / entity_profiles / entity_links ---
// This one hands out the pool itself rather than adding row accessors, and that
// is deliberate: lib/corpus/search.js is pgvector distance ordering and tsvector
// ranking fused in SQL, not something the repository interface above can express
// without becoming a query builder. Handing out THIS pool rather than opening a
// second one keeps one connection pool per process.
//
// The file backend has no semantic layer at all, so it answers null and every
// caller degrades by name. The Postgres backend REJECTS if the database cannot
// be reached, which is the third case a caller has to handle — see
// lib/schema/startup.js, which is the only caller that runs at boot.
export const semanticPool = () => impl.semanticPool();

// ---------------------------------------------------------------- file backend
function fileBackend() {
  const DIR = path.join(process.cwd(), '.data');
  const FILE = path.join(DIR, 'philotas-db.json');
  let db = null;

  // The same one-shot guards as the Postgres DDL, and for the same reason: this
  // runs on every load, so an unguarded backfill would re-add a member an
  // administrator had removed, on the next start, silently. See the comment on
  // the SQL in BASE_SCHEMA_STATEMENTS.
  //
  // Returns whether it changed anything, so a load that had nothing to do does
  // not rewrite the file.
  const backfillDefaultTeam = (d) => {
    let changed = false;
    if (!d.teams.some((team) => team.id === DEFAULT_TEAM_ID)) {
      d.teams.push({ id: DEFAULT_TEAM_ID, name: DEFAULT_TEAM_NAME, created_ms: Date.now() });
      changed = true;
    }
    if (d.teamMembers.length === 0) {
      for (const user of d.users) d.teamMembers.push({ teamId: DEFAULT_TEAM_ID, userId: user.id, joinedMs: Date.now() });
      changed ||= d.users.length > 0;
    }
    if (!d.workspaces.some((workspace) => workspace.teamId != null)) {
      for (const workspace of d.workspaces) workspace.teamId = DEFAULT_TEAM_ID;
      changed ||= d.workspaces.length > 0;
    }
    return changed;
  };

  const load = () => {
    if (db) return db;
    try { db = JSON.parse(fs.readFileSync(FILE, 'utf8')); }
    catch { db = {}; }
    db.users ??= []; db.sessions ??= []; db.workspaces ??= []; db.actions ??= []; db.rules ??= []; db.audit ??= [];
    db.detections ??= []; db.workflows ??= []; db.workflowRuns ??= [];
    // Invitations are stored in the Postgres column names rather than this
    // backend's usual camelCase, because listInvitations hands its rows straight
    // to a caller on both backends and the two answers have to be the same shape.
    // Team membership is not observable that way — teamIdsForUser returns ids —
    // so it keeps the local convention.
    db.teams ??= []; db.teamMembers ??= []; db.invitations ??= [];
    // In memory, and deliberately WITHOUT writing the file. load() is on every
    // read path, and a read that writes turns a read-only working directory into
    // a datastore that throws on every call. Nothing is lost by waiting: the next
    // mutation saves the whole database including this, and a process that never
    // mutates re-derives the same backfill from the same file next time.
    backfillDefaultTeam(db);
    return db;
  };
  const save = () => { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(db, null, 2)); };
  const ownerName = (d, id) => d.users.find((u) => u.id === id)?.username || 'unknown';

  return {
    async findUserByUsername(u) { return load().users.find((x) => x.username === u) || null; },
    async insertUser(user) { load().users.push(user); save(); },
    async insertSession(s) { load().sessions.push(s); save(); },
    async deleteSession(token) { const d = load(); d.sessions = d.sessions.filter((s) => s.token !== token); save(); },
    async findUserByToken(token) {
      const d = load();
      const s = d.sessions.find((x) => x.token === token);
      if (!s) return null;
      const user = d.users.find((u) => u.id === s.userId);
      // The session's own age rides back with the user so auth can expire it.
      // Without this the cookie Max-Age is the only limit, and that is a client
      // hint a client can simply ignore.
      return user ? { ...user, session_created_ms: s.created } : null;
    },
    async listWorkspaces(user) {
      const d = load();
      const clr = user?.clearance ?? 0;
      const vis = (w) => {
        if (user && w.ownerId === user.id) return true;
        if ((w.classification ?? 0) > clr) return false; // above clearance
        if (w.visibility === 'shared') return true;
        return (w.sharedWith || []).includes(user?.username);
      };
      return d.workspaces
        .filter(vis)
        .map((w) => ({ id: w.id, name: w.name, visibility: w.visibility, classification: w.classification ?? 0, owner: ownerName(d, w.ownerId), mine: !!user && w.ownerId === user.id, sharedWith: w.sharedWith || [], updated: w.updated }))
        .sort((a, b) => b.updated - a.updated);
    },
    async getWorkspace(id) { return load().workspaces.find((w) => w.id === id) || null; },
    async upsertWorkspace({ id, ownerId, name, data, visibility, classification, sharedWith }) {
      const d = load();
      const fields = { name, data, visibility, classification: classification ?? 0, sharedWith: sharedWith || [], updated: Date.now() };
      const existing = id && d.workspaces.find((w) => w.id === id && w.ownerId === ownerId);
      if (existing) { Object.assign(existing, fields); save(); return existing; }
      const ws = { id: crypto.randomUUID(), ownerId, ...fields };
      d.workspaces.push(ws); save(); return ws;
    },
    async deleteWorkspace(id, ownerId) {
      const d = load();
      const before = d.workspaces.length;
      d.workspaces = d.workspaces.filter((w) => !(w.id === id && w.ownerId === ownerId));
      save(); return d.workspaces.length < before;
    },
    async addAction(a) { const d = load(); d.actions.unshift(a); d.actions = d.actions.slice(0, 500); save(); return a; },
    async listActions(region, n = 50) {
      const d = load();
      return d.actions.filter((a) => !region || a.region === region).slice(0, n);
    },
    async addRule(r) { const d = load(); d.rules.push(r); save(); return r; },
    async listRules() { return load().rules; },
    async deleteRule(id) { const d = load(); const before = d.rules.length; d.rules = d.rules.filter((r) => r.id !== id); save(); return d.rules.length < before; },
    async countUsers() { return load().users.length; },
    async listUsers() { return load().users.map((u) => ({ id: u.id, username: u.username, role: u.role, clearance: u.clearance })); },
    async setUserRole(id, role, clearance) { const d = load(); const u = d.users.find((x) => x.id === id); if (u) { u.role = role; u.clearance = clearance; save(); } return !!u; },
    async addAudit(e) { const d = load(); d.audit.unshift(e); d.audit = d.audit.slice(0, 1000); save(); return e; },
    async listAudit(n = 100) { return load().audit.slice(0, n); },
    async addDetections(rows) {
      const d = load();
      d.detections.unshift(...rows);
      // Rolling cap: the panel reads the newest few dozen; history beyond that
      // belongs to the workflow runs, which carry their own record.
      d.detections = d.detections.slice(0, 2000);
      save();
      return rows;
    },
    async listDetections({ region, limit = 50, sinceMs, classes } = {}) {
      const cls = classes && classes.length ? new Set(classes) : null;
      return load().detections
        .filter((x) => (!region || x.region === region)
          && (sinceMs == null || x.detected_at_ms >= sinceMs)
          && (!cls || cls.has(x.class)))
        .sort((a, b) => b.detected_at_ms - a.detected_at_ms)
        .slice(0, limit);
    },
    async addWorkflow(w) { const d = load(); d.workflows.push(w); save(); return w; },
    async listWorkflows() { return load().workflows; },
    async deleteWorkflow(id) { const d = load(); const before = d.workflows.length; d.workflows = d.workflows.filter((w) => w.id !== id); save(); return d.workflows.length < before; },
    async updateWorkflow(id, fields) {
      const d = load();
      const w = d.workflows.find((x) => x.id === id);
      if (!w) return null;
      Object.assign(w, fields);
      save();
      return w;
    },
    async addWorkflowRun(r) { const d = load(); d.workflowRuns.unshift(r); d.workflowRuns = d.workflowRuns.slice(0, 500); save(); return r; },
    async listWorkflowRuns({ workflowId, region, limit = 50 } = {}) {
      return load().workflowRuns
        .filter((r) => (!workflowId || r.workflowId === workflowId) && (!region || r.region === region))
        .sort((a, b) => b.firedAt - a.firedAt)
        .slice(0, limit);
    },
    async latestWorkflowRun(workflowId) {
      return load().workflowRuns
        .filter((r) => r.workflowId === workflowId)
        .sort((a, b) => b.firedAt - a.firedAt)[0] || null;
    },
    async clearDemoData() {
      const d = load();
      const before = d.detections.length + d.workflowRuns.length;
      d.detections = d.detections.filter((x) => x.source !== 'demo');
      d.workflowRuns = d.workflowRuns.filter((r) => !(r.detail && r.detail.demo));
      if (d.detections.length + d.workflowRuns.length !== before) save();
    },
    async updateWorkflowRun(id, detail) {
      const d = load();
      const r = d.workflowRuns.find((x) => x.id === id);
      if (!r) return null;
      r.detail = detail;
      save();
      return r;
    },

    // --- teams and invitations ---
    // An empty answer is the fail-closed one here (lib/teams.js), so an absent id
    // returns nothing rather than everything.
    async teamIdsForUser(userId) {
      if (!userId) return [];
      return load().teamMembers
        .filter((member) => member.userId === userId)
        .sort((a, b) => a.joinedMs - b.joinedMs)
        .map((member) => member.teamId);
    },
    async addTeamMember(teamId, userId, joinedMs = Date.now()) {
      const d = load();
      // The file-backend equivalent of the Postgres primary key on
      // (team_id, user_id): joining twice is not two memberships.
      if (d.teamMembers.some((member) => member.teamId === teamId && member.userId === userId)) return;
      d.teamMembers.push({ teamId, userId, joinedMs });
      save();
    },
    async removeTeamMember(teamId, userId) {
      const d = load();
      d.teamMembers = d.teamMembers.filter((member) => !(member.teamId === teamId && member.userId === userId));
      save();
    },
    async insertInvitation(row) {
      const d = load();
      d.invitations.push({
        token_hash: row.tokenHash, team_id: row.teamId, role: row.role,
        clearance: row.clearance ?? 0, issued_by: row.issuedBy,
        issued_ms: row.issuedMs, expires_ms: row.expiresMs,
        accepted_ms: null, accepted_user_id: null,
      });
      save();
    },
    // The same three conditions the Postgres UPDATE carries, in the same order:
    // the hash matches, it is unclaimed, and it has not expired. There is no race
    // to lose here — one process, one file — but the refusals have to be
    // indistinguishable on both backends, so used, expired and never-existed all
    // answer null.
    async claimInvitation(tokenHash, nowMs, userId) {
      const d = load();
      const row = d.invitations.find(
        (invitation) => invitation.token_hash === tokenHash
          && invitation.accepted_ms == null
          && invitation.expires_ms > nowMs
      );
      if (!row) return null;
      row.accepted_ms = nowMs;
      row.accepted_user_id = userId;
      save();
      // See the note on the Postgres claimInvitation: a new clearance reader,
      // defaulting to 0.
      return { team_id: row.team_id, role: row.role, clearance: row.clearance ?? 0 };
    },
    async listInvitations(teamIds) {
      if (!teamIds || !teamIds.length) return [];
      return load().invitations
        .filter((invitation) => teamIds.includes(invitation.team_id))
        .sort((a, b) => b.issued_ms - a.issued_ms)
        .map(mapInvitation);
    },
    // What a restart does to this backend: re-run the backfill over the state
    // that is already there. The guards inside it are what make it inert.
    async applyBaseSchemaTwice() {
      if (backfillDefaultTeam(load())) save();
    },

    // See the note beside the maritime exports: the file backend deliberately
    // holds no vessel state, so these return empty and the feed falls back to
    // its labelled sample.
    async listVessels() { return []; },
    async listEvents() { return []; },
    async listCaseFiles() { return []; },
    async getCaseFile() { return null; },

    // No semantic layer on the file backend: pgvector and tsvector have no file
    // equivalent, and a rewrite-the-whole-file store could not carry a corpus
    // anyway. Callers degrade rather than guess.
    async semanticPool() { return null; },

    // See the note beside the corpus exports: no file-backend corpus store.
    async upsertCorpusDocuments() { return 0; },
    async recordEntityMentions() { return 0; },
    async documentsForEntity() { return []; },
    async entitiesSharingDocuments() { return []; },
    async documentsById() { return []; },
    async dueForEnrichment() { return []; },
    async markEnrichmentState() {},
    async enrichmentStateKeys() { return []; },
  };
}

// ------------------------------------------------------------- base schema
// The DDL the Postgres backend applies at boot, as data rather than as a literal
// buried inside init(), so a test can run the same text a deployment runs instead
// of a paraphrase of it. Same reason lib/frames.js exports
// FRAMES_SCHEMA_STATEMENTS.
//
// EVERY ELEMENT CARRIES ITS OWN TERMINATING SEMICOLON, which frames' array does
// not. That is so `BASE_SCHEMA_STATEMENTS.join('\n')` is valid SQL wherever it is
// written — a caller that joined a semicolon-less array with a newline would send
// one long malformed statement, and the only place that would show up is against
// a live database.
//
// It runs on EVERY process start, which is what makes the two backfill guards
// below load-bearing rather than tidy.
export const BASE_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, salt TEXT NOT NULL, hash TEXT NOT NULL, created BIGINT);`,
  `CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id TEXT NOT NULL, created BIGINT);`,
  `CREATE TABLE IF NOT EXISTS workspaces (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, name TEXT NOT NULL, data JSONB, visibility TEXT NOT NULL, updated BIGINT);`,
  `CREATE TABLE IF NOT EXISTS actions (id TEXT PRIMARY KEY, ts BIGINT, "user" TEXT, type TEXT, region TEXT, entity_type TEXT, entity_label TEXT, note TEXT, coord JSONB);`,
  `CREATE TABLE IF NOT EXISTS rules (id TEXT PRIMARY KEY, data JSONB);`,
  `CREATE TABLE IF NOT EXISTS audit (id TEXT PRIMARY KEY, ts BIGINT, "user" TEXT, event TEXT, detail TEXT);`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT;`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS clearance INT;`,
  `ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS classification INT DEFAULT 0;`,
  `ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS shared_with JSONB DEFAULT '[]';`,

  // Maritime. Written by philotas-ingest, read by the app.
  `CREATE TABLE IF NOT EXISTS vessels (
     mmsi TEXT PRIMARY KEY, name TEXT, ship_type TEXT, destination TEXT,
     lon DOUBLE PRECISION, lat DOUBLE PRECISION,
     speed_over_ground_knots DOUBLE PRECISION, course_over_ground_degrees DOUBLE PRECISION,
     first_seen_ms BIGINT, last_report_ms BIGINT);`,
  `CREATE INDEX IF NOT EXISTS vessels_position ON vessels (lon, lat);`,
  `CREATE INDEX IF NOT EXISTS vessels_last_report ON vessels (last_report_ms DESC);`,

  `CREATE TABLE IF NOT EXISTS vessel_positions (
     id BIGSERIAL PRIMARY KEY, mmsi TEXT NOT NULL, timestamp_ms BIGINT NOT NULL,
     lon DOUBLE PRECISION, lat DOUBLE PRECISION,
     speed_over_ground_knots DOUBLE PRECISION, course_over_ground_degrees DOUBLE PRECISION);`,
  `CREATE INDEX IF NOT EXISTS vessel_positions_mmsi_time ON vessel_positions (mmsi, timestamp_ms DESC);`,

  `CREATE TABLE IF NOT EXISTS events (
     id TEXT PRIMARY KEY, type TEXT NOT NULL, mmsi TEXT, region TEXT,
     detected_at_ms BIGINT NOT NULL, lon DOUBLE PRECISION, lat DOUBLE PRECISION,
     evidence TEXT, detail JSONB);`,
  `CREATE INDEX IF NOT EXISTS events_region_time ON events (region, detected_at_ms DESC);`,

  `CREATE TABLE IF NOT EXISTS case_files (
     id TEXT PRIMARY KEY, event_id TEXT, title TEXT, region TEXT,
     opened_at_ms BIGINT, frame_from_ms BIGINT, frame_to_ms BIGINT,
     assessment TEXT, assessment_method TEXT, detail JSONB);`,
  `CREATE INDEX IF NOT EXISTS case_files_region_time ON case_files (region, opened_at_ms DESC);`,

  // Corpus. OSINT enrichment: documents pulled from external sources
  // (GDELT, NSW Health, AMSA) for entities on the live map, plus which
  // entity each document was found for. Written by lib/corpus/*, read
  // by the corpus/connections UI. See lib/corpus/store.js for the
  // shaping layer on top of these tables (id hashing, defaults).
  `CREATE TABLE IF NOT EXISTS corpus_documents (
     id TEXT PRIMARY KEY,            -- sha1 of url
     url TEXT UNIQUE NOT NULL, title TEXT, source TEXT,
     published_ms BIGINT, snippet TEXT, retrieved_ms BIGINT, language TEXT);`,
  `CREATE INDEX IF NOT EXISTS corpus_documents_published ON corpus_documents (published_ms DESC);`,

  `CREATE TABLE IF NOT EXISTS entity_mentions (
     id BIGSERIAL PRIMARY KEY, document_id TEXT NOT NULL,
     entity_key TEXT NOT NULL,       -- stable: "Vessel:CORAL PRINCESS", "Berth:opt"
     entity_type TEXT, entity_label TEXT,
     method TEXT,                    -- 'exact' | 'alias' | 'reranked'
     confidence REAL, created_ms BIGINT);`,
  `CREATE UNIQUE INDEX IF NOT EXISTS entity_mentions_uniq ON entity_mentions (document_id, entity_key);`,
  `CREATE INDEX IF NOT EXISTS entity_mentions_entity ON entity_mentions (entity_key);`,

  `CREATE TABLE IF NOT EXISTS enrichment_state (
     entity_key TEXT PRIMARY KEY, entity_type TEXT, entity_label TEXT,
     last_searched_ms BIGINT, document_count INT DEFAULT 0, next_due_ms BIGINT);`,
  `CREATE INDEX IF NOT EXISTS enrichment_due ON enrichment_state (next_due_ms);`,

  // Teams: sub-groups inside one client instance. See lib/teams.js for why
  // every instance has exactly one by default.
  `CREATE TABLE IF NOT EXISTS teams (
     id TEXT PRIMARY KEY, name TEXT NOT NULL, created_ms BIGINT NOT NULL);`,
  `CREATE TABLE IF NOT EXISTS team_members (
     team_id TEXT NOT NULL, user_id TEXT NOT NULL, joined_ms BIGINT NOT NULL,
     PRIMARY KEY (team_id, user_id));`,
  `CREATE INDEX IF NOT EXISTS team_members_user ON team_members (user_id);`,

  // Invitations. token_hash is a sha256 hex digest and the token itself is
  // never stored: a read of this table must not let anyone mint an account.
  // expires_ms and accepted_ms are what make a token single-use and
  // time-bounded, and the claim is one atomic UPDATE (see claimInvitation).
  `CREATE TABLE IF NOT EXISTS invitations (
     token_hash TEXT PRIMARY KEY,
     team_id TEXT NOT NULL,
     role TEXT NOT NULL,
     clearance INT NOT NULL DEFAULT 0,
     issued_by TEXT NOT NULL,
     issued_ms BIGINT NOT NULL,
     expires_ms BIGINT NOT NULL,
     accepted_ms BIGINT,
     accepted_user_id TEXT);`,
  `CREATE INDEX IF NOT EXISTS invitations_team ON invitations (team_id);`,

  `ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS team_id TEXT;`,

  // Vision: object detections written by the detection routes, read by the
  // VISION panel and evaluated by the workflow engine. The column is spelled
  // class, which is a keyword but not a reserved word in PostgreSQL; rows are
  // read back JSON-serialised so nothing depends on the spelling.
  `CREATE TABLE IF NOT EXISTS detections (
     id TEXT PRIMARY KEY, region TEXT, source TEXT, source_id TEXT,
     class TEXT, score REAL, bbox JSONB,
     detected_at_ms BIGINT, coord JSONB, image TEXT);`,
  `CREATE INDEX IF NOT EXISTS detections_region_time ON detections (region, detected_at_ms DESC);`,

  // Workflows: detection-triggered alert pipelines. The definition rides as
  // JSONB (same pattern as rules) so trigger and action shapes can grow
  // without a migration; workflow_runs is the firing history the alert
  // surface reads.
  `CREATE TABLE IF NOT EXISTS workflows (id TEXT PRIMARY KEY, data JSONB);`,
  `CREATE TABLE IF NOT EXISTS workflow_runs (
     id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, region TEXT,
     fired_at_ms BIGINT NOT NULL, detail JSONB);`,
  `CREATE INDEX IF NOT EXISTS workflow_runs_time ON workflow_runs (fired_at_ms DESC);`,

  // The default team exists on every instance.
  `INSERT INTO teams (id, name, created_ms)
     SELECT 'team-default', 'Default', (EXTRACT(EPOCH FROM now()) * 1000)::BIGINT
     WHERE NOT EXISTS (SELECT 1 FROM teams WHERE id = 'team-default');`,

  // ONE-SHOT BACKFILLS, and the guards are the whole point. This DDL runs on
  // every process start. Without `WHERE NOT EXISTS (SELECT 1 FROM
  // team_members)` the statement below re-adds, on every restart, any user an
  // administrator had deliberately removed from the default team — a backfill
  // that is really a policy, and one whose symptom is a workspace becoming
  // visible again weeks later.
  `INSERT INTO team_members (team_id, user_id, joined_ms)
     SELECT 'team-default', id, (EXTRACT(EPOCH FROM now()) * 1000)::BIGINT FROM users
     WHERE NOT EXISTS (SELECT 1 FROM team_members)
     ON CONFLICT DO NOTHING;`,

  // The second guard is the same shape: once any workspace carries a team_id, a
  // NULL team_id is a bug rather than a pre-upgrade row, and moving it into the
  // default team would WIDEN what `visibility='shared'` exposes. Leaving it NULL
  // fails closed to owner-only, which is the direction a fallback must fail in.
  `UPDATE workspaces SET team_id = 'team-default'
     WHERE team_id IS NULL
       AND NOT EXISTS (SELECT 1 FROM workspaces WHERE team_id IS NOT NULL);`,
];

// ---------------------------------------------------------------- pg backend
function pgBackend() {
  let pool, ready;
  async function init() {
    if (ready) return ready;
    ready = (async () => {
      const pg = (await import('pg')).default;
      // connectionTimeoutMillis is set explicitly because pg has no default for
      // it: node_modules/pg-pool/index.js:206 only arms a timer `if
      // (this.options.connectionTimeoutMillis)`, so unset means a connect attempt
      // that waits forever. Against a refused port that costs nothing (measured
      // 2026-08-17: ECONNREFUSED in 7 ms), but against a host that drops packets
      // rather than refusing them — a firewall, a security group, a database that
      // moved — an unbounded attempt is now on the boot path AND retried per
      // request, since the rejection is no longer memoised. This bounds it.
      //
      // 10 seconds is **assumed**, not measured: it has to be long enough that it
      // never turns an ordinary wait into an error, and this same knob also bounds
      // waiting for a free client from a saturated pool, not just the TCP connect.
      // Boot is not held up by it — measured 2026-08-17 on `next start`, Next
      // printed `Ready in 414ms` BEFORE the [schema] line, so register() does not
      // gate readiness. Revisit with a measurement from the trial rather than by
      // taste.
      pool = new pg.Pool({
        connectionString: process.env.DATABASE_URL,
        connectionTimeoutMillis: 10_000,
      });
      // ONE multi-statement query, which is ONE implicit transaction in Postgres.
      // That is deliberate and is the same reason semantic.sql is applied
      // separately (see the note above semanticPool): a half-applied base schema
      // is worse than none. Joining the statements rather than looping them is
      // what preserves it.
      await pool.query(BASE_SCHEMA_STATEMENTS.join('\n'));
    })();
    // A REJECTED init must not be memoised. Measured 2026-08-17 with
    // `DATABASE_URL=postgres://unused:unused@127.0.0.1:1/philotas-must-not-connect
    // node --input-type=module -e "const {countUsers} = await import('./lib/db.js');
    // ... countUsers() twice"`: both calls came back with the IDENTICAL error
    // object, because `ready` held the rejected promise and every later q()
    // awaited that same one. So one refused connect failed every user, session,
    // workspace, vessel and event read for the life of the process.
    //
    // That was survivable while init() first ran on a request. It is not
    // survivable now that lib/schema/startup.js calls semanticPool() at boot: an
    // app that starts a second before its database would never recover without a
    // restart. Clearing `ready` lets the next caller attempt a fresh connection.
    // `pool` is deliberately left as it is — only `ready` gates the retry, so a
    // successful init cannot be disturbed by a concurrent failed one.
    //
    // This is retry-after-rejection, never reconnect-per-call, because `ready` is
    // nulled only from the rejection handler and only while it is still this
    // attempt. Both halves of that sentence are now pinned, and the waiver that
    // used to sit here is discharged. The seam it asked for has landed:
    // test/db-retry.test.js resolves `pg` through a node:module loader to an
    // in-repo stub, which lets init() SUCCEED without a database — the thing no
    // earlier test could do, and the reason two mutations here used to survive a
    // green suite. Measured 2026-08-17 against the whole suite at 629 tests:
    //
    //   deleting the two lines below, so a rejection is memoised again
    //     -> 3 failures, including 'a connection that fails once does not poison
    //        the datastore for the process'
    //   replacing them with `attempt.catch(() => {}).then(() => { ready = null; })`,
    //   which clears `ready` after SUCCESS too, so every q() builds a fresh
    //   pg.Pool, reconnects and re-runs the whole base DDL
    //     -> 1 failure, 'a connection that succeeded is reused, not rebuilt on
    //        every call'
    //
    // The same test also pins the "one connection pool per process" promise above
    // semanticPool(), by asserting semanticPool() hands back the pool the row
    // accessors are already using rather than a second one.
    //
    // STILL UNPINNED, and the one waiver that survives: connectionTimeoutMillis
    // above. Its deletion was confirmed on 2026-08-17 to leave the suite green,
    // and the stub cannot pin it — a stub that never opens a socket has no timeout
    // to observe. Only inspection covers that knob, so do not drop it.
    const attempt = ready;
    attempt.catch(() => { if (ready === attempt) ready = null; });
    return ready;
  }
  const q = async (text, params) => { await init(); return pool.query(text, params); };
  const mapUser = (r) => r && ({ id: r.id, username: r.username, salt: r.salt, hash: r.hash, created: Number(r.created), role: r.role, clearance: r.clearance });
  const mapWs = (r) => r && ({ id: r.id, ownerId: r.owner_id, name: r.name, data: r.data, visibility: r.visibility, classification: r.classification ?? 0, sharedWith: r.shared_with || [], updated: Number(r.updated) });

  return {
    async findUserByUsername(u) { return mapUser((await q('SELECT * FROM users WHERE username=$1', [u])).rows[0]); },
    async insertUser(user) { await q('INSERT INTO users(id,username,salt,hash,created,role,clearance) VALUES($1,$2,$3,$4,$5,$6,$7)', [user.id, user.username, user.salt, user.hash, user.created, user.role, user.clearance]); },
    async insertSession(s) { await q('INSERT INTO sessions(token,user_id,created) VALUES($1,$2,$3)', [s.token, s.userId, s.created]); },
    async deleteSession(token) { await q('DELETE FROM sessions WHERE token=$1', [token]); },
    async findUserByToken(token) {
      const r = await q(
        'SELECT u.*, s.created AS session_created FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=$1',
        [token]
      );
      const user = mapUser(r.rows[0]);
      if (!user) return null;
      // See the note in the file backend: auth needs the session's age to
      // expire it server side.
      user.session_created_ms = Number(r.rows[0].session_created);
      return user;
    },
    async listWorkspaces(user) {
      const r = await q(
        `SELECT w.*, u.username AS owner, (w.owner_id=$1) AS mine
         FROM workspaces w JOIN users u ON u.id=w.owner_id
         WHERE w.owner_id=$1
            OR (COALESCE(w.classification,0) <= $2 AND (w.visibility='shared' OR w.shared_with ? $3))
         ORDER BY w.updated DESC`,
        [user?.id || '', user?.clearance ?? 0, user?.username || '']
      );
      return r.rows.map((w) => ({ id: w.id, name: w.name, visibility: w.visibility, classification: w.classification ?? 0, owner: w.owner, mine: w.mine, sharedWith: w.shared_with || [], updated: Number(w.updated) }));
    },
    async getWorkspace(id) { return mapWs((await q('SELECT * FROM workspaces WHERE id=$1', [id])).rows[0]); },
    async upsertWorkspace({ id, ownerId, name, data, visibility, classification, sharedWith }) {
      const cls = classification ?? 0;
      const sw = JSON.stringify(sharedWith || []);
      if (id) {
        const r = await q('UPDATE workspaces SET name=$1,data=$2,visibility=$3,classification=$4,shared_with=$5,updated=$6 WHERE id=$7 AND owner_id=$8 RETURNING *',
          [name, JSON.stringify(data), visibility, cls, sw, Date.now(), id, ownerId]);
        if (r.rowCount) return mapWs(r.rows[0]);
      }
      const r = await q('INSERT INTO workspaces(id,owner_id,name,data,visibility,classification,shared_with,updated) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
        [crypto.randomUUID(), ownerId, name, JSON.stringify(data), visibility, cls, sw, Date.now()]);
      return mapWs(r.rows[0]);
    },
    async deleteWorkspace(id, ownerId) {
      const r = await q('DELETE FROM workspaces WHERE id=$1 AND owner_id=$2', [id, ownerId]);
      return r.rowCount > 0;
    },
    async addAction(a) {
      await q('INSERT INTO actions(id,ts,"user",type,region,entity_type,entity_label,note,coord) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [a.id, a.ts, a.user, a.type, a.region, a.entityType, a.entityLabel, a.note, JSON.stringify(a.coord || null)]);
      return a;
    },
    async listActions(region, n = 50) {
      const r = region
        ? await q('SELECT * FROM actions WHERE region=$1 ORDER BY ts DESC LIMIT $2', [region, n])
        : await q('SELECT * FROM actions ORDER BY ts DESC LIMIT $1', [n]);
      return r.rows.map((x) => ({ id: x.id, ts: Number(x.ts), user: x.user, type: x.type, region: x.region, entityType: x.entity_type, entityLabel: x.entity_label, note: x.note, coord: x.coord }));
    },
    async addRule(rule) { await q('INSERT INTO rules(id,data) VALUES($1,$2)', [rule.id, JSON.stringify(rule)]); return rule; },
    async listRules() { return (await q('SELECT data FROM rules')).rows.map((r) => r.data); },
    async deleteRule(id) { const r = await q('DELETE FROM rules WHERE id=$1', [id]); return r.rowCount > 0; },
    async addDetections(rows) {
      for (const d of rows) {
        await q(
          'INSERT INTO detections(id,region,source,source_id,class,score,bbox,detected_at_ms,coord,image) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (id) DO NOTHING',
          [d.id, d.region, d.source, d.sourceId || null, d.class, d.score, JSON.stringify(d.bbox || null), d.detected_at_ms, JSON.stringify(d.coord || null), d.image || null]
        );
      }
      return rows;
    },
    async listDetections({ region, limit = 50, sinceMs, classes } = {}) {
      const conds = [];
      const args = [];
      if (region) { args.push(region); conds.push('region=$' + args.length); }
      if (sinceMs != null) { args.push(sinceMs); conds.push('detected_at_ms>=$' + args.length); }
      if (classes && classes.length) {
        args.push(classes); conds.push('class = ANY($' + args.length + ')');
      }
      args.push(limit);
      const where = conds.length ? ' WHERE ' + conds.join(' AND ') : '';
      const r = await q('SELECT * FROM detections' + where + ' ORDER BY detected_at_ms DESC LIMIT $' + args.length, args);
      return r.rows.map((x) => ({
        id: x.id, region: x.region, source: x.source, sourceId: x.source_id,
        class: x.class, score: Number(x.score), bbox: x.bbox,
        detected_at_ms: Number(x.detected_at_ms), coord: x.coord, image: x.image,
      }));
    },
    async addWorkflow(w) { await q('INSERT INTO workflows(id,data) VALUES($1,$2)', [w.id, JSON.stringify(w)]); return w; },
    async listWorkflows() { return (await q('SELECT data FROM workflows')).rows.map((r) => r.data); },
    async deleteWorkflow(id) { const r = await q('DELETE FROM workflows WHERE id=$1', [id]); return r.rowCount > 0; },
    async updateWorkflow(id, fields) {
      const cur = (await q('SELECT data FROM workflows WHERE id=$1', [id])).rows[0];
      if (!cur) return null;
      const next = { ...cur.data, ...fields };
      await q('UPDATE workflows SET data=$1 WHERE id=$2', [JSON.stringify(next), id]);
      return next;
    },
    async addWorkflowRun(r) {
      await q('INSERT INTO workflow_runs(id,workflow_id,region,fired_at_ms,detail) VALUES($1,$2,$3,$4,$5)',
        [r.id, r.workflowId, r.region, r.firedAt, JSON.stringify(r.detail || {})]);
      return r;
    },
    async listWorkflowRuns({ workflowId, region, limit = 50 } = {}) {
      const conds = [];
      const args = [];
      if (workflowId) { args.push(workflowId); conds.push('workflow_id=$' + args.length); }
      if (region) { args.push(region); conds.push('region=$' + args.length); }
      args.push(limit);
      const where = conds.length ? ' WHERE ' + conds.join(' AND ') : '';
      const r = await q('SELECT * FROM workflow_runs' + where + ' ORDER BY fired_at_ms DESC LIMIT $' + args.length, args);
      return r.rows.map((x) => ({
        id: x.id, workflowId: x.workflow_id, region: x.region,
        firedAt: Number(x.fired_at_ms), detail: x.detail,
      }));
    },
    async latestWorkflowRun(workflowId) {
      const r = await q('SELECT * FROM workflow_runs WHERE workflow_id=$1 ORDER BY fired_at_ms DESC LIMIT 1', [workflowId]);
      const x = r.rows[0];
      return x ? { id: x.id, workflowId: x.workflow_id, region: x.region, firedAt: Number(x.fired_at_ms), detail: x.detail } : null;
    },
    async clearDemoData() {
      await q("DELETE FROM detections WHERE source='demo'");
      await q("DELETE FROM workflow_runs WHERE detail->>'demo' = 'true'");
    },
    async updateWorkflowRun(id, detail) {
      const r = await q('UPDATE workflow_runs SET detail=$1 WHERE id=$2 RETURNING *', [JSON.stringify(detail), id]);
      const x = r.rows[0];
      return x ? { id: x.id, workflowId: x.workflow_id, region: x.region, firedAt: Number(x.fired_at_ms), detail: x.detail } : null;
    },
    async countUsers() { return Number((await q('SELECT COUNT(*) AS n FROM users')).rows[0].n); },
    async listUsers() { return (await q('SELECT id,username,role,clearance FROM users ORDER BY created')).rows; },
    async setUserRole(id, role, clearance) { const r = await q('UPDATE users SET role=$1,clearance=$2 WHERE id=$3', [role, clearance, id]); return r.rowCount > 0; },
    async addAudit(e) { await q('INSERT INTO audit(id,ts,"user",event,detail) VALUES($1,$2,$3,$4,$5)', [e.id, e.ts, e.user, e.event, e.detail]); return e; },
    async listAudit(n = 100) {
      const r = await q('SELECT * FROM audit ORDER BY ts DESC LIMIT $1', [n]);
      return r.rows.map((x) => ({ id: x.id, ts: Number(x.ts), user: x.user, event: x.event, detail: x.detail }));
    },

    // --- teams and invitations ---
    async teamIdsForUser(userId) {
      // An absent id is not a wildcard. `WHERE user_id=$1` with an empty string
      // would return nothing anyway, but returning early says so out loud, and
      // this is a lister whose empty answer is the fail-closed one.
      if (!userId) return [];
      const r = await q('SELECT team_id FROM team_members WHERE user_id=$1 ORDER BY joined_ms ASC', [userId]);
      return r.rows.map((row) => row.team_id);
    },
    async addTeamMember(teamId, userId, joinedMs = Date.now()) {
      await q('INSERT INTO team_members(team_id,user_id,joined_ms) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [teamId, userId, joinedMs]);
    },
    async removeTeamMember(teamId, userId) {
      await q('DELETE FROM team_members WHERE team_id=$1 AND user_id=$2', [teamId, userId]);
    },
    async insertInvitation(row) {
      await q(
        `INSERT INTO invitations(token_hash,team_id,role,clearance,issued_by,issued_ms,expires_ms)
         VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [row.tokenHash, row.teamId, row.role, row.clearance ?? 0, row.issuedBy, row.issuedMs, row.expiresMs]
      );
    },
    // ONE atomic statement, and that is the point. Reading the row, checking it in
    // JavaScript and then updating it is a race in which one invitation creates two
    // accounts. `accepted_ms IS NULL AND expires_ms > $2` is the guard, and rowCount
    // 0 means "already used, expired, or never existed" — three refusals the caller
    // deliberately cannot tell apart, so a probe learns nothing from the response.
    async claimInvitation(tokenHash, nowMs, userId) {
      const r = await q(
        `UPDATE invitations SET accepted_ms=$2, accepted_user_id=$3
          WHERE token_hash=$1 AND accepted_ms IS NULL AND expires_ms > $2
          RETURNING team_id, role, clearance`,
        [tokenHash, nowMs, userId]
      );
      if (!r.rowCount) return null;
      const row = r.rows[0];
      // A new reader of clearance, so it defaults to 0 like the other nine and
      // unlike the `?? 1` in createUser, which is a creation-time policy rather
      // than a fallback. This value is used when an account is CREATED (see
      // lib/teams.js) and is never a read-time ceiling.
      return { team_id: row.team_id, role: row.role, clearance: row.clearance ?? 0 };
    },
    async listInvitations(teamIds) {
      if (!teamIds || !teamIds.length) return [];
      const r = await q('SELECT * FROM invitations WHERE team_id = ANY($1) ORDER BY issued_ms DESC', [teamIds]);
      return r.rows.map(mapInvitation);
    },
    // Re-applies the boot schema, which is what a second process start does. The
    // guards inside BASE_SCHEMA_STATEMENTS are what make that inert, and proving
    // it is the whole job of the gated test in test/teams.test.js. `await init()`
    // alone would NOT do this — init() memoises, so it would return the first
    // boot's promise and run no SQL at all.
    async applyBaseSchemaTwice() {
      await init();
      await pool.query(BASE_SCHEMA_STATEMENTS.join('\n'));
    },

    // --- maritime reads ---
    async listVessels(bbox) {
      const r = bbox
        ? await q(
            `SELECT * FROM vessels WHERE lon BETWEEN $1 AND $2 AND lat BETWEEN $3 AND $4`,
            [bbox.west, bbox.east, bbox.south, bbox.north]
          )
        : await q('SELECT * FROM vessels');
      return r.rows.map((x) => ({
        mmsi: x.mmsi,
        name: x.name,
        ship_type: x.ship_type,
        destination: x.destination,
        position: [x.lon, x.lat],
        speed_over_ground_knots: x.speed_over_ground_knots,
        course_over_ground_degrees: x.course_over_ground_degrees,
        first_seen_ms: x.first_seen_ms == null ? null : Number(x.first_seen_ms),
        last_report_ms: x.last_report_ms == null ? null : Number(x.last_report_ms),
      }));
    },
    async listEvents(region, n = 50) {
      const r = region
        ? await q('SELECT * FROM events WHERE region=$1 ORDER BY detected_at_ms DESC LIMIT $2', [region, n])
        : await q('SELECT * FROM events ORDER BY detected_at_ms DESC LIMIT $1', [n]);
      return r.rows.map(mapEvent);
    },
    async listCaseFiles(region, n = 20) {
      const r = region
        ? await q('SELECT * FROM case_files WHERE region=$1 ORDER BY opened_at_ms DESC LIMIT $2', [region, n])
        : await q('SELECT * FROM case_files ORDER BY opened_at_ms DESC LIMIT $1', [n]);
      return r.rows.map(mapCaseFile);
    },
    async getCaseFile(id) {
      const r = await q('SELECT * FROM case_files WHERE id=$1', [id]);
      return r.rows[0] ? mapCaseFile(r.rows[0]) : null;
    },

    // --- semantic layer ---
    // The init() DDL runs first, exactly as it does for every other call in this
    // backend, so the caller receives a pool whose base schema exists. The
    // semantic DDL is applied separately, by lib/schema/startup.js, and is
    // deliberately NOT folded in above: semantic.sql opens with CREATE EXTENSION
    // vector, and a multi-statement pool.query() is one implicit transaction in
    // Postgres, so on a database whose role cannot create extensions the failure
    // would roll back the app tables too and take every read down instead of
    // only retrieval.
    async semanticPool() { await init(); return pool; },

    // --- corpus ---
    // Rows arrive pre-shaped (id/retrieved_ms/created_ms already computed —
    // see lib/corpus/store.js). This layer's only job is the SQL and the
    // backend switch, same division as everything else in this file.
    async upsertCorpusDocuments(rows) {
      let inserted = 0;
      for (const d of rows) {
        const r = await q(
          `INSERT INTO corpus_documents (id, url, title, source, published_ms, snippet, retrieved_ms, language)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT (id) DO NOTHING`,
          [d.id, d.url, d.title ?? null, d.source ?? null, d.published_ms ?? null, d.snippet ?? null, d.retrieved_ms, d.language ?? null]
        );
        if (r.rowCount) inserted++;
      }
      return inserted;
    },
    async recordEntityMentions(rows) {
      // ON CONFLICT DO UPDATE, not DO NOTHING: a later pass can rediscover
      // the same (document, entity) pair via a better method (an 'exact'
      // name hit superseded by a 'reranked' adjudication, say), and that
      // should overwrite the classification. created_ms is deliberately left
      // out of the UPDATE SET, so it stays pinned to when the mention was
      // FIRST seen even as method/confidence/label keep refreshing.
      let written = 0;
      for (const m of rows) {
        const r = await q(
          `INSERT INTO entity_mentions (document_id, entity_key, entity_type, entity_label, method, confidence, created_ms)
           VALUES ($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT (document_id, entity_key) DO UPDATE SET
             entity_type = EXCLUDED.entity_type,
             entity_label = EXCLUDED.entity_label,
             method = EXCLUDED.method,
             confidence = EXCLUDED.confidence`,
          [m.document_id, m.entity_key, m.entity_type ?? null, m.entity_label ?? null, m.method ?? null, m.confidence ?? null, m.created_ms]
        );
        if (r.rowCount) written++;
      }
      return written;
    },
    async documentsForEntity(entityKey, limit = 20) {
      const r = await q(
        `SELECT d.* FROM corpus_documents d
         JOIN entity_mentions m ON m.document_id = d.id
         WHERE m.entity_key = $1
         ORDER BY d.published_ms DESC NULLS LAST
         LIMIT $2`,
        [entityKey, limit]
      );
      return r.rows.map(mapCorpusDocument);
    },
    // THE CORE QUERY of the corpus feature: every other entity that shares at
    // least one document with entityKey, ranked by how many documents they
    // share. Two CTEs would be clearer but one keeps the plan simple — find
    // entityKey's documents, then find every OTHER entity mentioned in any of
    // them, grouped and counted.
    //
    // entity_type/entity_label are taken from the most recently created
    // mention for that entity_key (array_agg ORDER BY ... LIMIT to element 0)
    // rather than an arbitrary GROUP BY pick, since two mentions of the same
    // entity_key are expected to agree but aren't guaranteed to.
    async entitiesSharingDocuments(entityKey, limit = 40) {
      const r = await q(
        `WITH target_docs AS (
           SELECT document_id FROM entity_mentions WHERE entity_key = $1
         )
         SELECT
           m.entity_key,
           (array_agg(m.entity_type ORDER BY m.created_ms DESC))[1] AS entity_type,
           (array_agg(m.entity_label ORDER BY m.created_ms DESC))[1] AS entity_label,
           COUNT(DISTINCT m.document_id) AS shared_documents,
           array_agg(DISTINCT m.document_id) AS document_ids
         FROM entity_mentions m
         JOIN target_docs t ON t.document_id = m.document_id
         WHERE m.entity_key <> $1
         GROUP BY m.entity_key
         ORDER BY shared_documents DESC, m.entity_key ASC
         LIMIT $2`,
        [entityKey, limit]
      );
      return r.rows.map(mapSharedEntity);
    },
    async documentsById(ids) {
      if (!ids || !ids.length) return [];
      const r = await q(
        `SELECT * FROM corpus_documents WHERE id = ANY($1::text[]) ORDER BY published_ms DESC NULLS LAST`,
        [ids]
      );
      return r.rows.map(mapCorpusDocument);
    },
    async dueForEnrichment(limit = 25) {
      // "next_due_ms absent" means never scheduled (NULL), not "no row" — a
      // row with no next_due_ms is due immediately, ordered first.
      const r = await q(
        `SELECT entity_key, entity_type, entity_label FROM enrichment_state
         WHERE next_due_ms IS NULL OR next_due_ms <= $1
         ORDER BY next_due_ms ASC NULLS FIRST
         LIMIT $2`,
        [Date.now(), limit]
      );
      return r.rows;
    },
    async markEnrichmentState(entityKey, fields) {
      const { entity_type = null, entity_label = null, last_searched_ms = null, document_count = 0, next_due_ms = null } = fields || {};
      // Upsert: this is how an entity_key first appears in enrichment_state
      // (no separate "register" call exists — the first enrichment pass
      // creates the row, later passes update it).
      await q(
        `INSERT INTO enrichment_state (entity_key, entity_type, entity_label, last_searched_ms, document_count, next_due_ms)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (entity_key) DO UPDATE SET
           entity_type = EXCLUDED.entity_type,
           entity_label = EXCLUDED.entity_label,
           last_searched_ms = EXCLUDED.last_searched_ms,
           document_count = EXCLUDED.document_count,
           next_due_ms = EXCLUDED.next_due_ms`,
        [entityKey, entity_type, entity_label, last_searched_ms, document_count, next_due_ms]
      );
    },
    async enrichmentStateKeys() {
      // Every entity_key the schedule has ever touched, regardless of whether it
      // is due now. Lets the background pass seed candidates it has not reached
      // yet instead of re-picking the first batch.
      const r = await q(
        `SELECT entity_key FROM enrichment_state
         ORDER BY last_searched_ms ASC`
      );
      return r.rows.map((row) => row.entity_key);
    },
  };
}

function mapEvent(row) {
  return {
    id: row.id,
    type: row.type,
    mmsi: row.mmsi,
    region: row.region,
    detected_at_ms: Number(row.detected_at_ms),
    position: row.lon == null ? null : [row.lon, row.lat],
    evidence: row.evidence,
    detail: row.detail || {},
  };
}

function mapCaseFile(row) {
  return {
    id: row.id,
    event_id: row.event_id,
    title: row.title,
    region: row.region,
    opened_at_ms: Number(row.opened_at_ms),
    frame_from_ms: row.frame_from_ms == null ? null : Number(row.frame_from_ms),
    frame_to_ms: row.frame_to_ms == null ? null : Number(row.frame_to_ms),
    assessment: row.assessment,
    // 'llm' or 'heuristic'. Surfaced in the UI: an operator must be able to see
    // whether a model wrote this or the fallback did.
    assessment_method: row.assessment_method,
    detail: row.detail || {},
  };
}

function mapCorpusDocument(row) {
  return {
    id: row.id,
    url: row.url,
    title: row.title,
    source: row.source,
    published_ms: row.published_ms == null ? null : Number(row.published_ms),
    snippet: row.snippet,
    retrieved_ms: row.retrieved_ms == null ? null : Number(row.retrieved_ms),
    language: row.language,
  };
}

// Both backends map through this, so an invitation reads the same either way.
// The BIGINT columns come back from pg as STRINGS, and a caller comparing
// `expires_ms > Date.now()` against a string gets a lexicographic answer that is
// right often enough to look fine — the same trap Number() guards elsewhere in
// this file. clearance defaults to 0 here as it does at every other reader.
function mapInvitation(row) {
  return {
    token_hash: row.token_hash,
    team_id: row.team_id,
    role: row.role,
    clearance: row.clearance ?? 0,
    issued_by: row.issued_by,
    issued_ms: Number(row.issued_ms),
    expires_ms: Number(row.expires_ms),
    accepted_ms: row.accepted_ms == null ? null : Number(row.accepted_ms),
    accepted_user_id: row.accepted_user_id ?? null,
  };
}

function mapSharedEntity(row) {
  return {
    entity_key: row.entity_key,
    entity_type: row.entity_type,
    entity_label: row.entity_label,
    shared_documents: Number(row.shared_documents),
    document_ids: row.document_ids || [],
  };
}
