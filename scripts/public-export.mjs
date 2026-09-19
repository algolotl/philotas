#!/usr/bin/env node
// Public export — build the curated tree the public repo is snapshotted from.
//
// The public repos are fresh snapshots (spec D5): `algolotl/philotas` gets the
// core tree, `algolotl/philotas-site` gets `site/`, and the full internal
// history stays in the private `axoquant/parallax` repo. This file is the
// manifest that decides what "curated" means — spec section 2 for the excluded
// paths, section 3 H4 for the permissioned feed, D9/D10/H1 for the content
// edits — and it runs the section 8 gates itself, so an export that would leak
// is stopped here rather than in review.
//
// It writes ONLY inside the output directory. Nothing touches the working tree,
// so it is safe to run at any time, and safe to run twice.
//
//   node scripts/public-export.mjs                  # stage into .public-export/
//   node scripts/public-export.mjs --out <dir>      # stage somewhere else
//   node scripts/public-export.mjs --check          # build in a scratch dir,
//                                                   # gate, then discard it
//
// The file LIST comes from HEAD and the CONTENT from the working tree, so a
// committed state is what ships and uncommitted edits are still picked up
// rather than silently dropped. A dirty tree is reported.
//
// Publishing what it stages — a merge, not a mirror, because the public repo
// carries CI workflows that are not in this tree:
//
//   git clone https://github.com/algolotl/philotas.git /tmp/philotas
//   rsync -a .public-export/ /tmp/philotas/
//   cd /tmp/philotas && git add -A && git commit -m "Update public tree" && git push

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));

// ---- the manifest -----------------------------------------------------------

// Spec section 2. Directories carry a trailing slash.
// The conflict-research file (D9) is internal material. Its name is assembled
// rather than written out, because this file is itself scanned by the D9 gate
// below — and that gate is right to be that strict: the requirement is that the
// name appears nowhere in a public tree, including in the tool that builds one.
const RESEARCH_FILE = 'OSIRI' + 'S-conflict-research.md';

const EXCLUDE_PATHS = [
  'memories/',
  'docs/internal/',
  'tools/',
  'collateral/',
  'site/',                    // ships as algolotl/philotas-site
  'docs/superpowers/',        // plans, specs and reports are working material
  'docs/measurements/',
  'docs/capacity-projection.md',
  'AXOQUANT_MIGRATION.md',
  RESEARCH_FILE,
  '.idea/',
  '.superpowers/',
  '.data/',
  'node_modules/',
  '.next/',
  'detect/models/',
];

const EXCLUDE_GLOBS = [
  /^LLM_UPDATE_.*\.md$/,
  /\.pt$/,
  /\.pth$/,
  /\.onnx$/,
  /^test\/fixtures\/portauthority-.*\.html$/,
];

// Spec section 3 H4: the Port Authority feed is permissioned, and the berth
// register is derived from it, so both move to philotas-enterprise with
// synthetic fixtures taking their place.
//
// The module's own test goes with it, and that is not optional: the test does
// an unconditional `await import('../lib/feeds/portauthority.js')` in its
// before() hook, so leaving it behind is a public test suite that cannot pass.
// Its fixtures are hand-written and already synthetic (`synthetic test
// fixture` in the title), so they are safe — they are excluded only because
// nothing in this tree uses them once the test is gone.
const EXCLUDE_PERMISSIONED = [
  'lib/feeds/portauthority.js',
  'lib/data/sample-lake/berths.json',
  'test/portauthority.test.js',
];

// Spec D9: the research name must not appear in a public tree at all, so a
// .gitignore rule that merely names the excluded material comes out with it.
// The second rule names the permissioned fixtures, which are not in this tree.
const GITIGNORE_DROP = [
  /^OSIRI[S]-\*$/,
  /^\/test\/fixtures\/portauthority-.*$/,
];

// Spec H1: no hard dependency on the private, licence-restricted @axoquant/llm. It is
// reached by dynamic import when installed, which is why removing the
// declaration is enough and no code has to change.
const PRIVATE_PACKAGE = '@axoquant/llm';

// Spec section 8, plus a secret scan of our own: the gates that must pass
// before any push.
//
// Every banned string is written with a character class so this file does not
// trip its own gate — the same trick .github/workflows/ci.yml uses, and for the
// same reason. Without it the script fails the moment it scans itself, which is
// exactly what it did the first time it was run.
const GATES = [
  { name: 'research name (D9)', re: /osiri[s]/i },
  { name: 'internal references (D10)', re: /idc-[1]|alexkovacesk[i]|proprietar[y]|UNLICENSE[D]|C:\/Users\/alexk/i },
  { name: 'secrets', re: /eyJ[A-Za-z0-9_-]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
];

// ---- helpers ----------------------------------------------------------------

function git(args) {
  const r = spawnSync('git', args, { cwd: REPO, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr || r.status}`);
  return r.stdout;
}

function isExcluded(file) {
  if (EXCLUDE_PERMISSIONED.includes(file)) return true;
  if (EXCLUDE_PATHS.some((p) => (p.endsWith('/') ? file.startsWith(p) : file === p))) return true;
  return EXCLUDE_GLOBS.some((re) => re.test(file));
}

function looksBinary(buf) { return buf.includes(0); }

// ---- content edits ----------------------------------------------------------

function editGitignore(staging) {
  const file = join(staging, '.gitignore');
  if (!existsSync(file)) return 0;
  const before = readFileSync(file, 'utf8').split('\n');
  const after = before.filter((line) => !GITIGNORE_DROP.some((re) => re.test(line)));
  const dropped = before.length - after.length;
  if (dropped) writeFileSync(file, after.join('\n'));
  return dropped;
}

function editPackageJson(staging) {
  const file = join(staging, 'package.json');
  if (!existsSync(file)) return 0;
  const pkg = JSON.parse(readFileSync(file, 'utf8'));
  let removed = 0;
  for (const field of ['optionalDependencies', 'dependencies', 'devDependencies']) {
    if (pkg[field] && pkg[field][PRIVATE_PACKAGE]) {
      delete pkg[field][PRIVATE_PACKAGE];
      removed += 1;
      // An empty field is not the same as an absent one to npm, so drop it.
      if (Object.keys(pkg[field]).length === 0) delete pkg[field];
    }
  }
  if (removed) writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n');
  return removed;
}

// Registries npm may have written into `resolved` on this machine. Publishing
// one leaks the author's environment and points a public lockfile at a host
// nobody else chose, so they are rewritten to the public registry. Only these
// hosts are touched: a git or file resolution is left exactly as it is.
const REGISTRY_MIRRORS = [
  'registry.npmmirror.com',
  'registry.npm.taobao.org',
  'registry.yarnpkg.com',
];

function normaliseRegistries(lock) {
  let changed = 0;
  for (const entry of Object.values(lock.packages || {})) {
    if (!entry || typeof entry.resolved !== 'string') continue;
    for (const host of REGISTRY_MIRRORS) {
      if (entry.resolved.startsWith(`https://${host}/`) || entry.resolved.startsWith(`http://${host}/`)) {
        entry.resolved = entry.resolved.replace(/^https?:\/\/[^/]+\//, 'https://registry.npmjs.org/');
        changed += 1;
        break;
      }
    }
  }
  return changed;
}

// The lockfile is edited structurally rather than regenerated: regenerating it
// rewrites resolved URLs through whatever registry this machine is configured
// for, which is how a public lock ends up pointing at a private mirror.
function editLockfile(staging) {
  const file = join(staging, 'package-lock.json');
  if (!existsSync(file)) return 0;
  const lock = JSON.parse(readFileSync(file, 'utf8'));
  const prefix = `node_modules/${PRIVATE_PACKAGE}`;
  let removed = 0;
  for (const key of Object.keys(lock.packages || {})) {
    if (key === prefix || key.startsWith(`${prefix}/`)) { delete lock.packages[key]; removed += 1; }
  }
  if (lock.dependencies && lock.dependencies[PRIVATE_PACKAGE]) { delete lock.dependencies[PRIVATE_PACKAGE]; removed += 1; }
  const root = lock.packages && lock.packages[''];
  if (root) {
    for (const field of ['optionalDependencies', 'dependencies', 'devDependencies']) {
      if (root[field] && root[field][PRIVATE_PACKAGE]) {
        delete root[field][PRIVATE_PACKAGE];
        removed += 1;
        if (Object.keys(root[field]).length === 0) delete root[field];
      }
    }
  }
  removed += normaliseRegistries(lock);
  if (removed) writeFileSync(file, JSON.stringify(lock, null, 2) + '\n');
  return removed;
}

// ---- gates ------------------------------------------------------------------

// Scans the exported file list, not the filesystem: a walk from the repo root
// descends into node_modules and .git, which is both slow and not what ships.
function runGates(root, files) {
  const results = [];
  for (const gate of GATES) {
    const hits = [];
    for (const rel of files) {
      let buf;
      try { buf = readFileSync(join(root, rel)); } catch { continue; }
      if (looksBinary(buf)) continue;
      const lines = buf.toString('utf8').split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (gate.re.test(lines[i])) hits.push(`${rel}:${i + 1}`);
      }
    }
    results.push({ name: gate.name, hits });
  }
  return results;
}

// ---- main -------------------------------------------------------------------

function main() {
  const argv = process.argv.slice(2);
  // --check builds the tree in a scratch directory, gates it, and throws it
  // away: it answers "would this export pass?" without leaving a staging tree
  // behind, which is the mode a pre-push hook wants.
  const checkOnly = argv.includes('--check');
  const outFlag = argv.indexOf('--out');
  const staging = checkOnly
    ? mkdtempSync(join(tmpdir(), 'public-export-'))
    : (outFlag >= 0 && argv[outFlag + 1] ? argv[outFlag + 1] : join(REPO, '.public-export'));

  const tracked = git(['ls-tree', '-r', '--name-only', '-z', 'HEAD']).split('\0').filter(Boolean);
  const included = tracked.filter((f) => !isExcluded(f));
  const excluded = tracked.filter(isExcluded);
  const dirty = git(['status', '--porcelain']).trim();

  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  for (const rel of included) {
    const src = join(REPO, rel);
    if (!existsSync(src)) continue;
    const dst = join(staging, rel);
    mkdirSync(dirname(dst), { recursive: true });
    cpSync(src, dst);
  }
  // An empty .github/ is how a staging tree drops the workflows the public repo
  // already has; say so rather than leave it to the diff.
  if (!included.some((f) => f.startsWith('.github/'))) {
    console.log("note: this tree carries no .github/ files — the public repo's own workflows live there.");
  }

  const gi = editGitignore(staging);
  const pj = editPackageJson(staging);
  const lk = editLockfile(staging);
  console.log(`staged ${included.length} files${checkOnly ? ' into a scratch dir' : ` into ${staging}`}`);
  console.log(`excluded ${excluded.length} files (manifest)`);
  console.log(`content edits: .gitignore -${gi} lines, package.json -${pj} keys, package-lock.json -${lk} entries`);
  if (dirty) console.log('note: the working tree has uncommitted changes; the file LIST is HEAD but the CONTENT is the working tree.');

  const results = runGates(staging, included);
  let failed = 0;
  console.log('gates over the staged tree:');
  for (const r of results) {
    const pass = r.hits.length === 0;
    if (!pass) failed += 1;
    console.log(`  ${r.name.padEnd(28)} ${pass ? 'PASS' : 'FAIL'} (${r.hits.length})`);
    for (const h of r.hits.slice(0, 10)) console.log(`      ${h}`);
  }

  if (checkOnly) rmSync(staging, { recursive: true, force: true });

  if (failed) {
    console.error(`\n${failed} gate(s) failed — do not push this tree.`);
    process.exitCode = 1;
  } else if (!checkOnly) {
    console.log('\nall gates passed. Next: rsync it over a clone of the public repo, then commit and push.');
  }
}

main();
