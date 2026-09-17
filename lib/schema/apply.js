// lib/schema/apply.js
//
// Applies the semantic schema once per process. Idempotent by construction:
// every statement in semantic.sql is IF NOT EXISTS, and the in-process guard
// only saves the round trip.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SQL_PATH = fileURLToPath(new URL('./semantic.sql', import.meta.url));

let applied = false;

export async function applySemanticSchema(pool) {
  if (!process.env.DATABASE_URL) return { applied: false, reason: 'no-database' };
  if (applied) return { applied: false, reason: 'already-applied' };
  if (!pool) return { applied: false, reason: 'no-pool' };

  const sql = await fs.readFile(SQL_PATH, 'utf8');
  await pool.query(sql);
  applied = true;
  return { applied: true };
}

// Exported for tests only.
export function _resetApplied() { applied = false; }
