// lib/teams.js
//
// A team is a group of users inside ONE client instance. Philotas ships as a
// per-client deployment, so there is no cross-client boundary here to get wrong —
// what a client needs is sub-groups within their own instance, which is what this
// is.
//
// EVERY INSTANCE HAS THIS TEAM, and that is what lets teams be a data property
// rather than a configuration switch. A fresh or upgraded instance backfills
// every existing user and every existing workspace into it exactly once (see the
// one-shot backfill in lib/db.js), so `visibility='shared'` keeps its
// instance-wide meaning where there is one team, and narrows to team-wide the
// moment a second team exists. One predicate, one behaviour, no branch on a
// deployment flag — the alternative was two answers to one question about who can
// see what, and the weaker answer is the one some route eventually calls. That
// failure mode is the one lib/corpus/scope.js was written to avoid.
//
// A team confers MEMBERSHIP and never a ceiling. Clearance stays on the user row,
// where lib/corpus/scope.js reads it and app/api/corpus/search/route.js echoes it
// on the strength of it being a property of the requesting user and of nothing
// else. A team-derived or per-case effective clearance would break that echo's
// stated condition, so the invitation clearance carried in lib/db.js is a value
// used at ACCOUNT CREATION time — the same kind of decision as createUser's
// first-user policy — and never a read-time ceiling.
//
// A user in NO team is a real state — a record written by an onboarding script
// before it joined anyone to anything — and it FAILS CLOSED: an empty team list
// matches no shared workspace, so such a user sees only what they own or what was
// allocated to them by name. Same posture as the zero clearance default in
// lib/auth.js: a fallback's job is to be the least dangerous value.
export const DEFAULT_TEAM_ID = 'team-default';
export const DEFAULT_TEAM_NAME = 'Default';
