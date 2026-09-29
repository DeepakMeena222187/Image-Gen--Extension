// End-to-end: real extension + fake chatgpt.com served via request interception.
// Runs the same 4-page HTML episode in both send modes.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_PATH || 'playwright');

const here = path.dirname(new URL(import.meta.url).pathname);
const extDir = path.resolve(here, '../extension');
const mock = fs.readFileSync(path.join(here, 'mock-chatgpt.html'), 'utf8');
const dl = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-dl-'));
const png = fs.readFileSync(path.join(here, 'sheet.png')).toString('base64');

const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'ma-prof-')), {
  channel: 'chromium',
  headless: true,
  acceptDownloads: true,
  downloadsPath: dl,
  args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
});
await ctx.route('https://chatgpt.com/**', r => r.fulfill({ contentType: 'text/html', body: mock }));
let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent('serviceworker');
const extId = new URL(sw.url()).host;

let failed = false;
// Playwright stores downloads under random ids, so count every file.
const countFiles = dir => fs.readdirSync(dir).length;

async function run(mode) {
  console.log(`\n===== ${mode} mode =====`);
  const errs = [];
  const fail = m => errs.push(m);

  const chat = await ctx.newPage();
  await chat.goto('https://chatgpt.com/');
  const panel = await ctx.newPage();
  await panel.goto(`chrome-extension://${extId}/sidepanel.html`);

  // Sheets + settings go straight into storage; the script goes through the real
  // file picker so the HTML import path is exercised.
  await panel.evaluate(async ({ png, mode }) => {
    const dataUrl = 'data:image/png;base64,' + png;
    await chrome.storage.local.clear();
    await chrome.storage.local.set({
      sheets: [
        { id: 'a', name: 'MC', fileName: 'mc.png', mime: 'image/png', dataUrl },
        { id: 'b', name: 'Frillrunner LV6', fileName: 'fr6.png', mime: 'image/png', dataUrl },
      ],
      settings: { ...MA.DEFAULT_SETTINGS, sendMode: mode, delayMin: 1, delayMax: 2, refreshEvery: 3, genTimeout: 90, quietSec: 15, downloadFolder: `e2e-${mode}` },
    });
  }, { png, mode });
  await panel.reload();
  await panel.setInputFiles('#scriptFile', path.join(here, 'sample-script.html'));
  await panel.waitForFunction(() => document.querySelectorAll('#plan .page').length === 4);
  const project = await panel.evaluate(async () => (await chrome.storage.local.get('project')).project);
  const before = countFiles(dl);
  await chat.bringToFront();
  await panel.click('#btnStart');

  const t0 = Date.now();
  let st;
  for (;;) {
    st = await panel.evaluate(() => chrome.storage.local.get(['control', 'progress', 'log']));
    if (['done', 'paused'].includes(st.control?.status) || Date.now() - t0 > 180000) break;
    await new Promise(r => setTimeout(r, 1000));
  }
  const sent = await chat.evaluate(() => window.__sent);
  const retried = await chat.evaluate(() => !!window.__retried);
  console.log('status:', st.control.status, st.control.reason || '');
  for (const l of st.log) console.log('  log:', l.level, l.msg);
  for (const s of sent) console.log('  sent:', JSON.stringify(s.files), s.text.split('\n')[0].slice(0, 110));
  const files = countFiles(dl) - before;

  if (st.control.status !== 'done') fail('run did not finish');
  if (project.pages.length !== 4) fail('HTML import should give 4 pages');
  if (!/HP LEDGER/.test(project.brief || '')) fail('brief should hold the HTML notes');
  if (project.pages.some(p => /VO \(Hinglish\)/.test(p.body))) fail('VO should not be imported');
  if (!/^EPISODE BRIEF/.test(sent[0]?.text) || sent[0].files.length) fail('brief goes first, alone, no files');

  if (mode === 'page') {
    // brief, p1, p2 (slow read), p3 (error → Retry click, no resend), p4, p4 re-ask
    if (sent.length !== 6) fail(`expected 6 sends, got ${sent.length}`);
    else {
      if (sent[1].files.join() !== 'mc.png,fr6.png') fail('page 1 should attach both sheets');
      if (!/^Generate exactly ONE image: page 01 only/.test(sent[1].text)) fail('page 1 should start with the one-image guard');
      if (!/Scene context: PART ONE — THE DOOR/.test(sent[1].text)) fail('page 1 should carry the part beat');
      if (sent[2].files.length) fail('page 2 should reuse from memory');
      if (!/attached earlier in this chat/.test(sent[2].text)) fail('page 2 should carry the reuse note');
      if (!/SLOWREAD/.test(sent[2].text)) fail('3rd send should be page 2');
      if (!/ERRORONCE/.test(sent[3].text) || sent[3].files.length) fail('4th send should be page 3, no files');
      if (sent[4].files.join() !== 'mc.png') fail('page 4 should re-attach MC (refreshEvery=3)');
      if (!/generate the image for page 04 now/i.test(sent[5].text)) fail('expected a re-ask after the text-only reply');
    }
    if (!retried) fail("should have clicked ChatGPT's Retry button after the error");
  } else {
    // brief, BLOCK 1-2, create 01, create 02, BLOCK 3-4, create 03, create 04
    const heads = sent.map(s => s.text.split('\n')[0]);
    const want = [/^EPISODE BRIEF/, /^BLOCK: 2 page cards, IMG01 to IMG02 \(PART ONE/, /^Now create IMG01 — The Door Is Open\./, /^Now create IMG02 — Walk Away\./, /^BLOCK: 2 page cards, IMG03 to IMG04 \(PART TWO/, /^Now create IMG03 — Dark\./, /^Now create IMG04 — Again\./];
    if (sent.length !== want.length) fail(`expected ${want.length} sends, got ${sent.length}`);
    want.forEach((re, k) => heads[k] && !re.test(heads[k]) && fail(`send ${k + 1} should match ${re}, got "${heads[k]}"`));
    if (sent[1]?.files.join() !== 'mc.png,fr6.png') fail('block 1 should carry both sheets');
    if (sent[2]?.files.length || sent[3]?.files.length) fail('page commands in block 1 should not re-send sheets');
    if (!/SLOWREAD/.test(sent[1]?.text) || !/Two stacked panels/.test(sent[1]?.text)) fail('block 1 should hold both full cards');
    if (sent[4]?.files.length) fail('block 2: MC still fresh, nothing attached');
    if (!/Window text — render EXACTLY: HP 5 \/ 25/.test(sent[5]?.text)) fail('IMG03 command should repeat its window text');
    if (sent[6]?.files.join() !== 'mc.png') fail('IMG04 should re-attach MC (refreshEvery=3)');
  }
  if (Object.values(st.progress.results).filter(r => r.status === 'done' && r.file).length !== 4) fail('expected 4 downloaded results');
  if (files !== 4) fail(`expected 4 files downloaded, got ${files}`);

  for (const e of errs) console.error('FAIL:', e);
  console.log(errs.length ? `${mode}: FAILED` : `${mode}: PASSED`);
  if (errs.length) failed = true;
  await panel.close();
  await chat.close();
}

await run('page');
await run('block');
await ctx.close();
console.log(failed ? '\nE2E FAILED' : '\nE2E PASSED');
process.exitCode = failed ? 1 : 0;
