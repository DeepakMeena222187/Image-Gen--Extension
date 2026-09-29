const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const MA = require('../extension/lib/core.js');

const script = fs.readFileSync(path.join(__dirname, 'sample-script.txt'), 'utf8');
const pages = MA.parseScript(script);
const sheets = [
  { id: 'mc', name: 'MC' },
  { id: 'fr6', name: 'Frillrunner LV6' },
  { id: 'still', name: 'The Still' },
];

test('splits pages on === headers and ignores preamble', () => {
  assert.equal(pages.length, 6);
  assert.equal(pages[0].num, 1);
  assert.equal(pages[5].num, 6);
  assert.match(pages[0].body, /^=== SPECIMEN 21/);
  assert.ok(!pages[0].body.includes('Episode notes'));
  assert.match(pages[0].fileStem, /^01_specimen-21-episode-7/);
});

test('parses the Attach line, including inline LOCKED descriptions', () => {
  const names = pages[0].characters.map(c => c.name);
  assert.deepEqual(names, ['MC', 'FRILLRUNNER LV 6', 'THE STILL']);
  assert.equal(pages[0].characters[2].locked, true);
  assert.deepEqual(pages[3].characters, []);
  assert.deepEqual(pages[4].characters.map(c => c.name), ['MC', 'THE STILL']);
});

test('matches sheets by normalized name (LV 6 == Level 6 == LV6)', () => {
  const m = MA.matchSheet(pages[5].characters[1], sheets);
  assert.equal(m.sheet.id, 'fr6');
  assert.equal(m.fuzzy, false);
  assert.equal(MA.matchSheet({ key: MA.normKey('Frillrunner LV 7') }, sheets), null);
});

test('fuzzy match flags partial names', () => {
  const m = MA.matchSheet({ key: MA.normKey('FRILLRUNNER LV 6') }, [{ id: 'f', name: 'Frillrunner' }]);
  assert.equal(m.fuzzy, true);
});

test('smart mode attaches on first appearance, then reuses until refresh', () => {
  const plan = MA.planAll(pages, sheets, { refreshEvery: 5 });
  const ids = d => d.attach.map(a => a.sheetId);
  assert.deepEqual(ids(plan[0]), ['mc', 'fr6', 'still']);
  assert.deepEqual(ids(plan[1]), []);
  assert.deepEqual(plan[1].reuse.map(r => r.sheetId), ['mc', 'fr6']);
  assert.deepEqual(ids(plan[2]), []);
  assert.deepEqual(ids(plan[4]), []); // still attached at gen 0, now gen 4
  assert.deepEqual(ids(plan[5]), ['mc', 'fr6']); // gen 5 - 0 >= 5
});

test('refreshEvery=2 re-attaches sooner', () => {
  const plan = MA.planAll(pages, sheets, { refreshEvery: 2 });
  assert.deepEqual(plan[2].attach.map(a => a.sheetId), ['mc']);
});

test('always / never / overrides', () => {
  assert.equal(MA.planAll(pages, sheets, { attachMode: 'always' })[1].attach.length, 2);
  assert.equal(MA.planAll(pages, sheets, { attachMode: 'never' })[0].attach.length, 0);
  const plan = MA.planAll(pages, sheets, {}, { 1: 'force', 2: 'skip' });
  assert.equal(plan[1].attach.length, 2);
  assert.equal(plan[2].skip, true);
});

test('new chat every N pages resets memory and re-attaches', () => {
  const plan = MA.planAll(pages, sheets, { newChatEvery: 2 });
  assert.equal(plan[2].newChatBefore, true);
  assert.deepEqual(plan[2].attach.map(a => a.sheetId), ['mc']);
  assert.equal(plan[3].newChatBefore, false);
  assert.equal(plan[4].newChatBefore, true);
});

test('missing sheets are reported, not attached', () => {
  const plan = MA.planAll(pages, [{ id: 'mc', name: 'MC' }], {});
  assert.deepEqual(plan[0].missing.map(m => m.name), ['FRILLRUNNER LV 6', 'THE STILL']);
});

test('buildMessage annotates reused sheets under the Attach line', () => {
  const plan = MA.planAll(pages, sheets, {});
  const msg = MA.buildMessage(pages[1], plan[1], {});
  assert.match(msg, /Attach: MC sheet \+ FRILLRUNNER LV 6 sheet\n\(Reference sheets for MC, FRILLRUNNER LV 6 were attached earlier/);
  assert.equal(MA.buildMessage(pages[0], plan[0], {}), pages[0].body);
  assert.equal(MA.buildMessage(pages[1], plan[1], { annotateReuse: false }), pages[1].body);
});

test('script without headers becomes one page', () => {
  const p = MA.parseScript('Attach: MC sheet\nPrompt: hi');
  assert.equal(p.length, 1);
  assert.equal(p[0].characters[0].name, 'MC');
});
