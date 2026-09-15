#!/usr/bin/env node
//
// The drop-two ancestor rule must be ONE function, and it must still be right.
//
// The outermost ancestors are shared by everything and prove nothing: two
// concurrent agents both descend from the same editor host. Matching on any
// shared pid classified a stranger's sessions as mine — their chain was
// 20620,20488,20129,67739 and mine 29623,29621,54680,54436,67739, intersecting
// only at that last entry — so the filter written to stop offering other
// people's sessions would have gone on offering them. Only visible with two
// agents running at once.
//
// It was a private helper in the MCP file. The exit-code caveat then needed the
// same "which agent run is this" answer, which was one edit away from a second
// implementation — the project's most common defect shape by more than double.
// It now lives in core and both callers use it.
//
// Asserted by CALLING the real function. The suite used to re-implement the
// rule inline in a `node -e`, which tested a copy of the logic rather than the
// logic, and separately grepped for `pids.length - 2` — pinning a location
// instead of a property, so it broke the moment the property moved and said
// nothing about whether the rule still held.
//
// A file rather than a `node -e`: the nested-quoting sandwich that needs has
// now been written wrong SIX times in scripts/verify.sh, including once while
// making this very change.
const path = require('node:path');

const core = require(path.join(__dirname, '..', 'packages', 'core', 'dist', 'index.js'));

const out = [];

// The real chains from the incident.
const mineChain = [29623, 29621, 54680, 54436, 67739];
const theirs = [20620, 20488, 20129, 67739];
const ours = [22892, 22890, 54680, 54436, 67739];

const mine = new Set(core.identifyingPids(mineChain));
const classify = (chain) => (chain.some((p) => mine.has(p)) ? 'MINE' : 'THEIRS');

out.push(classify(theirs) === 'THEIRS' ? 'strangerNotMine' : 'STRANGERCLAIMED');
out.push(classify(ours) === 'MINE' ? 'siblingIsMine' : 'SIBLINGDISOWNED');
out.push(core.identifyingPids([1, 2, 3, 4]).join(',') === '1,2' ? 'dropsTwo' : 'DROPWRONG');
// Never return an empty set: a chain of one or two is all we have, and an empty
// identity would make every comparison vacuously false.
out.push(core.identifyingPids([7]).length === 1 ? 'keepsShortChain' : 'SHORTCHAINEMPTY');
out.push(core.identifyingPids([]).length === 0 ? 'emptyStaysEmpty' : 'EMPTYINVENTED');

process.stdout.write(out.join(' '));
