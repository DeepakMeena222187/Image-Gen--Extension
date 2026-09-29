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
  assert.deepEqual(plan[0].missing.map(m => m.name), ['FRILLRUNNER LV 6']);
  assert.deepEqual(plan[0].described.map(m => m.name), ['THE STILL']);
});

test('buildMessage annotates reused sheets under the Attach line', () => {
  const plan = MA.planAll(pages, sheets, {});
  const msg = MA.buildMessage(pages[1], plan[1], {});
  assert.match(msg, /Attach: MC sheet \+ FRILLRUNNER LV 6 sheet\n\(Reference sheets for MC, FRILLRUNNER LV 6 were attached earlier/);
  const bare = { oneImageGuard: false };
  assert.equal(MA.buildMessage(pages[0], plan[0], bare), pages[0].body);
  assert.equal(MA.buildMessage(pages[1], plan[1], { ...bare, annotateReuse: false }), pages[1].body);
});

test('every message asks for exactly one image for its own page', () => {
  const plan = MA.planAll(pages, sheets, {});
  const msg = MA.buildMessage(pages[2], plan[2], {});
  assert.match(msg.split('\n')[0], /exactly ONE image: page 03 only/);
});

test('script without headers becomes one page', () => {
  const p = MA.parseScript('Attach: MC sheet\nPrompt: hi');
  assert.equal(p.length, 1);
  assert.equal(p[0].characters[0].name, 'MC');
});

test('several Attach blocks with no headers split into pages', () => {
  const p = MA.parseScript('Attach: MC sheet\nPrompt: one\n\nAttach: none\nPrompt: two');
  assert.equal(p.length, 2);
  assert.match(p[1].body, /Prompt: two/);
});

// ---- text copied straight off the episode page ("COPY THIS WHOLE PART") ----
const partText = fs.readFileSync(path.join(__dirname, 'sample-part-format.txt'), 'utf8');
const partPages = MA.parseScript(partText);

test('copied parts split into one page per IMG card', () => {
  assert.deepEqual(partPages.map(p => p.num), [10, 11, 14, 15, 18]);
  for (const p of partPages) assert.deepEqual(p.warnings, [], `page ${p.num}: ${p.warnings}`);
});

test('page UI junk is not part of any page', () => {
  for (const p of partPages) {
    assert.doesNotMatch(p.body, /COPY PAGE|COPY THIS WHOLE PART|^\+VO$|^PART |He waits for one thing/m);
  }
  assert.match(partPages[2].body, /^VO \(Hinglish\): Pachchees/m); // kept in the body…
  const plan = MA.planAll(partPages, [], {});
  assert.doesNotMatch(MA.buildMessage(partPages[2], plan[2], {}), /VO \(Hinglish\)/); // …but not sent
  assert.match(MA.buildMessage(partPages[2], plan[2], { stripVO: false }), /VO \(Hinglish\)/);
});

test('layout tag and LOAD-BEARING attach to the page below them', () => {
  assert.deepEqual(partPages[0].tags, ['L1 full bleed', 'LOAD-BEARING']);
  assert.deepEqual(partPages[1].tags, ['L3 three stacked']);
  assert.deepEqual(partPages[3].tags, ['L3 three stacked', 'LOAD-BEARING']);
  assert.match(partPages[0].body, /^IMG10 — Gods Above, Dust Below\nLayout: L1 full bleed · LOAD-BEARING\n/);
});

test('parts and their story beats are tracked', () => {
  assert.match(partPages[0].part.title, /^PART THREE/);
  assert.match(partPages[0].part.beat, /^Titans in the top of the frame/);
  assert.match(partPages[3].part.title, /^PART FOUR/);
  const plan = MA.planAll(partPages, [], {});
  assert.equal(plan[0].sceneNote, true);
  assert.equal(plan[1].sceneNote, false);
  assert.equal(plan[3].sceneNote, true);
  assert.match(MA.buildMessage(partPages[3], plan[3], {}), /\nScene context: PART FOUR — IT RUNS .* — He waits for one thing/);
});

test('attach lists with a LOCKED description in the middle still split', () => {
  assert.deepEqual(partPages[4].characters.map(c => c.name), ['MC', 'THE PIECE', 'FRILLRUNNER LV 6']);
  assert.deepEqual(partPages[0].characters.map(c => c.name), ['MC', 'DUSTMOTE', 'FRILLRUNNER LV 6', 'THE STILL']);
});

test('episode brief is planned once per chat', () => {
  const opts = { hasBrief: true };
  let plan = MA.planAll(partPages, [], {}, {}, 0, MA.freshCtx(), opts);
  assert.deepEqual(plan.map(d => d.sendBrief), [true, false, false, false, false]);
  plan = MA.planAll(partPages, [], { newChatEvery: 2 }, {}, 0, MA.freshCtx(), opts);
  assert.deepEqual(plan.map(d => d.sendBrief), [true, false, true, false, true]);
  plan = MA.planAll(partPages, [], { sendBrief: false }, {}, 0, MA.freshCtx(), opts);
  assert.ok(plan.every(d => !d.sendBrief));
  assert.match(MA.briefMessage('HP rules'), /Do NOT generate any image[\s\S]*HP rules$/);
});

test('LOCKED characters described in text are not reported missing', () => {
  const plan = MA.planAll(partPages, [{ id: 'mc', name: 'MC' }], {});
  assert.deepEqual(plan[0].described.map(m => m.name), ['THE STILL']);
  assert.deepEqual(plan[0].missing.map(m => m.name), ['DUSTMOTE', 'FRILLRUNNER LV 6']);
  assert.deepEqual(plan[2].described.map(m => m.name), ['THE PIECE']);
});

test('merged pages are flagged', () => {
  const p = MA.parseScript('=== IMG01 — A ===\nAttach: MC sheet\nPrompt: a\nAttach: MC sheet\nPrompt: b');
  assert.match(p[0].warnings[0], /merged/);
});
