// Audit trail helper — records security-relevant events (auth, actions, rule and
// workspace changes, role changes) to the datastore.
import crypto from 'node:crypto';
import { addAudit } from './db.js';

export function audit(user, event, detail) {
  return addAudit({ id: crypto.randomUUID(), ts: Date.now(), user: user || 'anonymous', event, detail: detail || '' });
}
