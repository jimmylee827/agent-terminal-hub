#!/usr/bin/env node
//
// May this change be called done? Answered from evidence, not from belief.
//
//   node scripts/done-check.js                 the verdict for HEAD
//   node scripts/done-check.js --note TARGET "what was checked, where"
//                                              record a live check for this tree
//   node scripts/done-check.js --selftest      prove the verdicts on fake records
//
// Written after a working session in which "fixed" was said, more than once, on
// a stale MCP server, on a run the Mac slept through, or before the hardest
// host was tried. So it refuses unless:
//
// - the working tree is committed: a verdict speaks for a commit, nothing else;
// - every target in scripts/test-matrix.json has a gate record for EXACTLY this
//   tree (scripts/verify.sh writes them to .verify/runs/) with every one of its
//   sections VALID and green, built fresh, and the tree unchanged during the
//   run. A target that may be a gap (Windows 10 runs only on production hosts)
//   can instead carry a live-check note, which is reported as such.
//
// Exit 0 = done. 4 = done except declared gaps, which must then be said. 1 = not
// done, with the reasons. Stale MCP servers are reported (they are other editor
// windows, so they cannot block), because testing through one tests old code.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');

function git(root, ...args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

/** The working state's tree, committed or not (as verify.sh computes it). */
function workingTree(root) {
  const gitDir = path.resolve(root, git(root, 'rev-parse', '--git-dir'));
  const idx = path.join(os.tmpdir(), `done-check-${process.pid}-${Date.now()}`);
  try {
    fs.copyFileSync(path.join(gitDir, 'index'), idx);
    const env = { ...process.env, GIT_INDEX_FILE: idx };
    execFileSync('git', ['-C', root, 'add', '-A'], { env, stdio: 'ignore' });
    return execFileSync('git', ['-C', root, 'write-tree'], { env, encoding: 'utf8' }).trim();
  } finally {
    fs.rmSync(idx, { force: true });
  }
}

function readRecords(root) {
  const dir = path.join(root, '.verify', 'runs');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.tsv')).map((f) => {
    const rec = { file: f, sections: [] };
    for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
      const [key, ...rest] = line.split('\t');
      if (key === 'section') rec.sections.push({ label: rest[0] ?? '', host: rest[1] ?? '-', verdict: rest[2] ?? '' });
      else if (key) rec[key] = rest.join('\t');
    }
    return rec;
  });
}

function readNotes(root, tree) {
  const file = path.join(root, '.verify', 'notes', `${tree}.tsv`);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => {
    const [target, when, ...note] = l.split('\t');
    return { target, when, note: note.join('\t') };
  });
}

/** Which target a section counts toward: local sections by name, remote ones by their host. */
function targetOf(section, hosts, matrix) {
  if (section.host === '-' || !section.host) {
    for (const [t, spec] of Object.entries(matrix.targets)) {
      if (spec.sections.includes(section.label)) return t;
    }
    return undefined;
  }
  return hosts[section.host];
}

/** Section kind as test-matrix.json names it: "REMOTE jpc-wsl" -> REMOTE, "WINDOWS x (light)" -> WINDOWS. */
function kindOf(label) {
  return label.split(' ')[0];
}

/** For one tree: each target's state, from every usable record. */
function verdictFor(root, tree, matrix, hosts) {
  const records = readRecords(root);
  const usable = records.filter((r) => r.tree === tree && r.build_fresh === 'yes' && r.tree_unchanged === 'yes');
  const skipped = records.filter((r) => r.tree === tree && !usable.includes(r));
  const notes = readNotes(root, tree);
  const targets = {};
  for (const [t, spec] of Object.entries(matrix.targets)) {
    const okKinds = new Set();
    const bad = [];
    for (const r of usable) {
      for (const s of r.sections) {
        if (targetOf(s, hosts, matrix) !== t) continue;
        if (s.verdict === 'ok') okKinds.add(kindOf(s.label));
        else bad.push(`${s.label}: ${s.verdict}`);
      }
    }
    const missing = spec.sections.filter((k) => !okKinds.has(k));
    const note = notes.filter((n) => n.target === t);
    let state;
    if (missing.length === 0) state = 'verified';
    else if (spec.mayBeGap && note.length) state = 'live-check';
    else if (spec.mayBeGap) state = 'gap';
    else state = 'missing';
    targets[t] = { state, missing, bad, note };
  }
  return { targets, skipped };
}

/** The last commit whose tree verified this target, for reporting a gap. */
function lastVerified(root, target, matrix, hosts) {
  let log = [];
  try {
    log = git(root, 'log', '--format=%H %T', '-200').split('\n').map((l) => l.split(' '));
  } catch {}
  for (const [commit, tree] of log) {
    const v = verdictFor(root, tree, matrix, hosts).targets[target];
    if (v && (v.state === 'verified' || v.state === 'live-check')) return commit.slice(0, 7);
  }
  return undefined;
}

function check(root, { quiet = false } = {}) {
  const matrix = JSON.parse(fs.readFileSync(path.join(root, 'scripts', 'test-matrix.json'), 'utf8'));
  const hostsFile = path.join(root, '.verify', 'targets.json');
  const hosts = fs.existsSync(hostsFile) ? JSON.parse(fs.readFileSync(hostsFile, 'utf8')) : {};
  delete hosts.note;
  const reasons = [];
  const gaps = [];
  const head = git(root, 'rev-parse', 'HEAD');
  const headTree = git(root, 'rev-parse', 'HEAD^{tree}');
  const tree = workingTree(root);
  if (tree !== headTree) reasons.push('the working tree has uncommitted changes: commit them, then verify that commit');
  if (!fs.existsSync(hostsFile)) reasons.push('no .verify/targets.json: remote hosts cannot be credited to a target (see scripts/verify-targets.example.json)');
  const { targets, skipped } = verdictFor(root, headTree, matrix, hosts);
  const out = [];
  out.push(`done-check for ${head.slice(0, 7)} (tree ${headTree.slice(0, 7)})`);
  for (const [t, v] of Object.entries(targets)) {
    const how = matrix.targets[t].how;
    if (v.state === 'verified') out.push(`  verified    ${t}`);
    else if (v.state === 'live-check') out.push(`  live check  ${t}: ${v.note.map((n) => n.note).join('; ')}`);
    else if (v.state === 'gap') {
      const last = lastVerified(root, t, matrix, hosts);
      out.push(`  GAP         ${t}: not verified on this commit${last ? ` (last verified at ${last})` : ' (never verified)'}`);
      gaps.push(t);
    } else {
      out.push(`  MISSING     ${t}: needs ${v.missing.join(', ')} VALID and green on this tree — ${how}`);
      reasons.push(`${t} not verified on this tree`);
    }
    for (const b of v.bad) out.push(`              (a record shows ${b})`);
  }
  for (const r of skipped) {
    out.push(`  ignored     ${r.file}: ${r.build_fresh !== 'yes' ? 'stale build' : 'tree changed during the run'}`);
  }
  out.push('  scenarios:');
  for (const sc of matrix.scenarios) {
    const cells = sc.targets.map((t) => `${t}=${{ verified: 'ok', 'live-check': 'live', gap: 'GAP', missing: 'NO' }[targets[t].state]}`);
    out.push(`    ${sc.id.padEnd(38)} ${cells.join('  ')}`);
  }
  let code;
  if (reasons.length) {
    out.push(`NOT DONE: ${reasons.join('; ')}`);
    code = 1;
  } else if (gaps.length) {
    out.push(`DONE EXCEPT DECLARED GAPS: ${gaps.join(', ')} — say so when reporting`);
    code = 4;
  } else {
    out.push('DONE: every target verified on this exact commit');
    code = 0;
  }
  if (!quiet) console.log(out.join('\n'));
  return { code, out: out.join('\n') };
}

async function staleNote() {
  try {
    const core = require(path.join(ROOT, 'packages', 'core', 'dist', 'index.js'));
    const s = await core.staleServers();
    if (s.length) console.log(`note: ${s.length} hub MCP server(s) run older code; testing through one tests old code (reload those editor windows)`);
  } catch {}
}

function note(root, target, text, quiet = false) {
  const matrix = JSON.parse(fs.readFileSync(path.join(root, 'scripts', 'test-matrix.json'), 'utf8'));
  if (!matrix.targets[target]) throw new Error(`unknown target ${target}; known: ${Object.keys(matrix.targets).join(', ')}`);
  if (!matrix.targets[target].mayBeGap) throw new Error(`${target} must be verified by the gate, not by a note`);
  const tree = workingTree(root);
  if (tree !== git(root, 'rev-parse', 'HEAD^{tree}')) throw new Error('commit first: a note speaks for a commit');
  const dir = path.join(root, '.verify', 'notes');
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, `${tree}.tsv`), `${target}\t${new Date().toISOString()}\t${text.replace(/[\t\n]/g, ' ')}\n`);
  if (!quiet) console.log(`noted for tree ${tree.slice(0, 7)}: ${target}`);
}

// Every verdict, on a throwaway repository with fake records.
function selftest() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'done-check-'));
  const results = [];
  const say = (ok, name) => results.push(ok ? name : name.toUpperCase() + '-FAILED');
  try {
    const sh = (...a) => execFileSync('git', ['-C', dir, ...a], { stdio: 'ignore' });
    sh('init', '-q');
    sh('config', 'user.email', 't@t');
    sh('config', 'user.name', 't');
    fs.mkdirSync(path.join(dir, 'scripts'));
    fs.copyFileSync(path.join(ROOT, 'scripts', 'test-matrix.json'), path.join(dir, 'scripts', 'test-matrix.json'));
    fs.writeFileSync(path.join(dir, '.gitignore'), '.verify/\n');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
    sh('add', '-A');
    sh('commit', '-qm', 'one');
    fs.mkdirSync(path.join(dir, '.verify', 'runs'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.verify', 'targets.json'), JSON.stringify({ lin: 'linux-remote', w11: 'windows-11', w10: 'windows-10' }));
    const tree = git(dir, 'rev-parse', 'HEAD^{tree}');
    let n = 0;
    const record = (sections, extra = {}) => {
      const lines = [`tree\t${extra.tree ?? tree}`, `build_fresh\t${extra.fresh ?? 'yes'}`, `tree_unchanged\t${extra.unchanged ?? 'yes'}`];
      for (const s of sections) lines.push(`section\t${s}`);
      fs.writeFileSync(path.join(dir, '.verify', 'runs', `r${n++}.tsv`), lines.join('\n') + '\n');
    };
    const clear = () => fs.rmSync(path.join(dir, '.verify', 'runs'), { recursive: true, force: true }) || fs.mkdirSync(path.join(dir, '.verify', 'runs'));
    const local = ['NESTING\t-\tok', 'CONTRACT\t-\tok', 'REGRESSION\t-\tok', 'LOCAL\t-\tok'];
    const code = () => check(dir, { quiet: true }).code;

    record([...local, 'REMOTE lin\tlin\tok', 'WINDOWS w11\tw11\tok', 'WINDOWS w10 (light)\tw10\tok']);
    say(code() === 0, 'allVerifiedIsDone');
    clear();
    record([...local, 'REMOTE lin\tlin\tok', 'WINDOWS w11\tw11\tok']);
    say(code() === 4, 'windows10GapDeclared');
    note(dir, 'windows-10', 'live checks on a Windows 10 host', true);
    say(code() === 0, 'liveCheckFillsGap');
    fs.rmSync(path.join(dir, '.verify', 'notes'), { recursive: true, force: true });
    clear();
    record([...local, 'REMOTE lin\tlin\tok', 'WINDOWS w11\tw11\tINVALID']);
    say(code() === 1, 'invalidIsNotGreen');
    clear();
    record([...local, 'REMOTE lin\tlin\tok', 'WINDOWS w11\tw11\tok'], { fresh: 'no' });
    say(code() === 1, 'staleBuildIgnored');
    clear();
    record([...local, 'REMOTE lin\tlin\tok', 'WINDOWS w11\tw11\tok'], { unchanged: 'no' });
    say(code() === 1, 'changedTreeIgnored');
    clear();
    record([...local, 'REMOTE lin\tlin\tok', 'WINDOWS w11\tw11\tok'], { tree: 'f'.repeat(40) });
    say(code() === 1, 'otherTreeIgnored');
    clear();
    record([...local, 'REMOTE lin\tlin\tok', 'WINDOWS w11\tw11\tok']);
    fs.writeFileSync(path.join(dir, 'a.txt'), 'two\n');
    say(code() === 1, 'uncommittedIsNotDone');
    // Clean again, so a refusal below can only come from the rule it tests.
    sh('checkout', '--', 'a.txt');
    let refused = false;
    try {
      note(dir, 'windows-11', 'x', true);
    } catch (e) {
      refused = /verified by the gate/.test(e.message);
    }
    say(refused, 'noteCannotReplaceGate');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log(results.join(' '));
  process.exit(results.some((r) => r.endsWith('-FAILED')) ? 1 : 0);
}

const argv = process.argv.slice(2);
if (argv[0] === '--selftest') selftest();
else if (argv[0] === '--note') {
  try {
    note(ROOT, argv[1], argv.slice(2).join(' '));
  } catch (e) {
    console.error(`done-check: ${e.message}`);
    process.exit(2);
  }
} else {
  staleNote().then(() => process.exit(check(ROOT).code));
}
