// End-to-end: real extension + fake chatgpt.com served via request interception.
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

const chat = await ctx.newPage();
await chat.goto('https://chatgpt.com/');
const panel = await ctx.newPage();
await panel.goto(`chrome-extension://${extId}/sidepanel.html`);

const script = [
  '=== EP7 — IMG01 — One ===\nAttach: MC sheet + FRILLRUNNER LV 6 sheet\nPrompt: first page',
  '=== EP7 — IMG02 — Two ===\nAttach: MC sheet + FRILLRUNNER LV 6 sheet\nPrompt: second page NOIMAGE',
  '=== EP7 — IMG03 — Three ===\nAttach: none\nPrompt: third page',
  '=== EP7 — IMG04 — Four ===\nAttach: MC sheet\nPrompt: fourth page',
].join('\n\n');
await panel.evaluate(async ({ script, png }) => {
  const dataUrl = 'data:image/png;base64,' + png;
  await chrome.storage.local.set({
    project: { scriptText: script, pages: MA.parseScript(script), overrides: {} },
    sheets: [
      { id: 'a', name: 'MC', fileName: 'mc.png', mime: 'image/png', dataUrl },
      { id: 'b', name: 'Frillrunner LV6', fileName: 'fr6.png', mime: 'image/png', dataUrl },
    ],
    settings: { ...MA.DEFAULT_SETTINGS, delayMin: 1, delayMax: 2, refreshEvery: 3, genTimeout: 60, downloadFolder: 'e2e' },
  });
}, { script, png });
await panel.reload();
await chat.bringToFront();
await panel.click('#btnStart');

const t0 = Date.now();
let st;
for (;;) {
  st = await panel.evaluate(() => chrome.storage.local.get(['control', 'progress', 'log']));
  if (['done', 'paused'].includes(st.control?.status) || Date.now() - t0 > 120000) break;
  await new Promise(r => setTimeout(r, 1000));
}
const sent = await chat.evaluate(() => window.__sent);
console.log('status:', st.control.status, st.control.reason || '');
for (const l of st.log) console.log('  log:', l.level, l.msg);
console.log('sent:', JSON.stringify(sent.map(s => ({ files: s.files, head: s.text.split('\n').slice(0, 3).join(' | ').slice(0, 160) })), null, 1));
console.log('results:', JSON.stringify(st.progress.results));
const files = fs.readdirSync(dl);
console.log('downloads:', files.length);

const fail = m => { console.error('FAIL:', m); process.exitCode = 1; };
if (st.control.status !== 'done') fail('run did not finish');
if (sent.length !== 5) fail(`expected 5 sends (4 pages + 1 nudge), got ${sent.length}`);
else {
  if (sent[0].files.join() !== 'mc.png,fr6.png') fail('page 1 should attach both sheets');
  if (sent[1].files.length) fail('page 2 should reuse from memory');
  if (!/attached earlier in this chat/.test(sent[1].text)) fail('page 2 should carry the reuse note');
  if (!/generate the image now/i.test(sent[2].text)) fail('expected a nudge after the no-image reply');
  if (sent[3].files.length) fail('page 3 attaches nothing');
  if (sent[4].files.join() !== 'mc.png') fail('page 4 should re-attach MC (refreshEvery=3)');
}
if (Object.values(st.progress.results).filter(r => r.status === 'done' && r.file).length !== 4) fail('expected 4 downloaded results');
if (files.length !== 4) fail(`expected 4 files downloaded, got ${files.length}`);
await ctx.close();
console.log(process.exitCode ? 'E2E FAILED' : 'E2E PASSED');
