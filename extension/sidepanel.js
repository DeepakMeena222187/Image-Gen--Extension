'use strict';
const MA = globalThis.MA;
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

let S = {}; // mirror of chrome.storage.local
let targetTab = null;

const store = {
  get: keys => chrome.storage.local.get(keys),
  set: obj => chrome.storage.local.set(obj),
};

function freshProgress(index = 0) {
  return { index, ctx: MA.freshCtx(), results: {}, pending: null, phase: 'idle' };
}

async function load() {
  S = await store.get(null);
  S.settings = { ...MA.DEFAULT_SETTINGS, ...(S.settings || {}) };
  S.project = S.project || { scriptText: '', pages: [], overrides: {} };
  S.sheets = S.sheets || [];
  S.control = S.control || { status: 'idle' };
  S.progress = S.progress || freshProgress();
  S.log = S.log || [];
}

// ---------- ChatGPT tab ----------
async function findTab() {
  const tabs = await chrome.tabs.query({ url: ['https://chatgpt.com/*', 'https://chat.openai.com/*'] });
  if (S.control.status === 'running' || S.control.status === 'paused') {
    const owned = tabs.find(t => t.id === S.control.tabId);
    if (owned) return owned;
  }
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tabs.find(t => t.id === active?.id) || tabs[0] || null;
}

async function refreshTab() {
  targetTab = await findTab();
  const el = $('tabStatus');
  if (!targetTab) {
    el.textContent = 'No ChatGPT tab open. Open chatgpt.com in a tab.';
    return;
  }
  let ping = null;
  try {
    ping = await chrome.tabs.sendMessage(targetTab.id, { type: 'ping' });
  } catch {
    /* content script not injected yet */
  }
  el.textContent = ping
    ? `ChatGPT tab ready${ping.composer ? '' : ' (open a chat)'}: ${targetTab.title || targetTab.url}`
    : 'ChatGPT tab found but the extension is not loaded there. Reload that tab.';
}

// ---------- rendering ----------
function sheetUses() {
  const uses = {};
  for (const p of S.project.pages) {
    for (const ch of p.characters) {
      const hit = MA.matchSheet(ch, S.sheets);
      if (hit) uses[hit.sheet.id] = (uses[hit.sheet.id] || 0) + 1;
    }
  }
  return uses;
}

function renderSheets() {
  const uses = sheetUses();
  $('sheetCount').textContent = S.sheets.length ? `(${S.sheets.length})` : '';
  $('sheets').innerHTML = S.sheets
    .map(
      s => `<div class="sheet" data-id="${s.id}">
        <img src="${s.dataUrl}" alt="" />
        <div>
          <input data-f="name" value="${esc(s.name)}" placeholder="Name as in Attach: line" />
          <input data-f="aliases" value="${esc(s.aliases || '')}" placeholder="Aliases, comma separated" />
          <div class="uses">${uses[s.id] ? `used on ${uses[s.id]} page(s)` : 'not referenced by any page'}</div>
        </div>
        <button data-del="${s.id}" class="danger" title="Remove">✕</button>
      </div>`,
    )
    .join('');
}

function renderStartAt() {
  const sel = $('startAt');
  const keep = sel.value;
  sel.innerHTML = S.project.pages
    .map((p, i) => `<option value="${i}">${p.num} · ${esc(p.title.slice(-40))}</option>`)
    .join('');
  if (keep && +keep < S.project.pages.length) sel.value = keep;
}

function renderPlan() {
  const pages = S.project.pages;
  $('scriptCount').textContent = pages.length ? `(${pages.length} pages)` : '';
  const warned = pages.filter(p => p.warnings?.length);
  $('scriptWarn').hidden = !warned.length;
  $('scriptWarn').textContent = warned.length
    ? `⚠ ${warned.length} page(s) look wrong. Check the ⚠ lines in the plan: ${warned.slice(0, 3).map(p => `page ${p.num}: ${p.warnings[0]}`).join(' ')}`
    : '';
  $('briefState').textContent = S.project.brief?.trim() ? `(${S.project.brief.trim().length} chars)` : '(empty)';
  if (!pages.length) {
    $('plan').innerHTML = '<p class="muted">Paste a script to see the plan.</p>';
    return;
  }
  const active = S.control.status === 'running' || S.control.status === 'paused';
  const from = active ? S.progress.index : +($('startAt').value || 0);
  const ctx = active ? S.progress.ctx : MA.freshCtx();
  const opts = { hasBrief: !!S.project.brief?.trim() };
  const plan = MA.planAll(pages, S.sheets, S.settings, S.project.overrides, from, ctx, opts);
  const results = S.progress.results || {};

  $('plan').innerHTML = pages
    .map((p, i) => {
      const d = plan[i];
      const r = results[i];
      const ov = S.project.overrides[i] || 'auto';
      let chips = '';
      if (d) {
        if (d.newChatBefore) chips += '<span class="chip newchat">new chat</span>';
        if (d.sendBrief) chips += '<span class="chip newchat">brief first</span>';
        if (d.block) {
          const nums = d.block.idx.map(k => pages[k].num);
          chips += `<span class="chip newchat" title="Sent before this page, no image">block ${nums[0]}–${nums[nums.length - 1]} first${d.block.attach.length ? ` · 📎 ${esc(d.block.attach.map(a => a.charName).join(', '))}` : ''}</span>`;
        }
        chips += d.attach.map(a => `<span class="chip attach">📎 ${esc(a.charName)}${a.fuzzy ? ` ⚠→${esc(a.name)}` : ''}</span>`).join('');
        chips += d.reuse.map(a => `<span class="chip">${esc(a.charName)}${a.fuzzy ? ` ⚠→${esc(a.name)}` : ''}</span>`).join('');
        chips += d.missing.map(m => `<span class="chip missing">${esc(m.name)}: no sheet</span>`).join('');
        chips += d.described.map(m => `<span class="chip" title="No sheet uploaded; the Attach line describes it in words">📝 ${esc(m.name)}</span>`).join('');
        if (d.skip) chips = '<span class="chip">skipped</span>';
      } else {
        chips = p.characters.map(c => `<span class="chip">${esc(c.name)}</span>`).join('');
      }
      const status = r ? `<span class="status ${r.status}" title="${esc(r.error || r.file || '')}">${r.status}</span>` : '';
      let msg = d ? MA.buildMessage(p, d, S.settings) : p.body;
      if (d?.block) msg = `[block message, sent first, no image]\n${MA.blockMessage(pages, d, S.settings)}\n\n[then this page]\n${msg}`;
      if (d?.sendBrief) msg = `[episode brief, sent first of all]\n${MA.briefMessage(S.project.brief)}\n\n${msg}`;
      const tags = (p.tags || []).map(t => `<span class="chip">${esc(t)}</span>`).join('');
      const warn = (p.warnings || []).map(w => `<div class="reason">⚠ ${esc(w)}</div>`).join('');
      return `<div class="page ${active && i === S.progress.index ? 'current' : ''}">
        <div class="head">
          <span class="num">${p.num}</span>
          <span class="title" title="${esc(p.title)}">${esc(p.title)}</span>
          ${status}
          <select data-ov="${i}" title="Attachment override for this page">
            ${['auto', 'force', 'none', 'skip']
              .map(v => `<option value="${v}" ${v === ov ? 'selected' : ''}>${{ auto: 'auto', force: 'attach all', none: 'attach none', skip: 'skip page' }[v]}</option>`)
              .join('')}
          </select>
        </div>
        <div class="chips">${chips || '<span class="muted">no Attach: line</span>'}${tags}</div>
        ${warn}
        <details><summary class="muted">message that will be sent</summary><pre>${esc(msg)}</pre></details>
      </div>`;
    })
    .join('');
}

function renderRun() {
  const { status, reason } = S.control;
  const total = S.project.pages.length;
  const idx = Math.min(S.progress.index, total);
  const done = Object.values(S.progress.results || {}).filter(r => r.status === 'done').length;
  $('runBadge').textContent = status;
  $('runBadge').className = `badge ${status}`;
  $('progressFill').style.width = total ? `${(idx / total) * 100}%` : '0';
  $('progressText').textContent = total
    ? `${idx} / ${total} processed · ${done} image(s) done${status === 'running' && idx < total ? ` · working on page ${S.project.pages[idx].num}` : ''}`
    : 'No script loaded';
  $('reason').hidden = !(status === 'paused' && reason);
  $('reason').textContent = reason || '';
  const active = status === 'running' || status === 'paused';
  $('btnStart').disabled = !total || status === 'running';
  $('btnStart').textContent = active ? 'Restart from page' : 'Start';
  $('btnResume').disabled = status !== 'paused';
  $('btnPause').disabled = status !== 'running';
  $('btnSkip').disabled = status !== 'paused';
  $('startAt').disabled = status === 'running';
}

function renderLog() {
  $('log').innerHTML = S.log
    .slice(-200)
    .reverse()
    .map(l => `<div class="${l.level}">${new Date(l.t).toLocaleTimeString()} ${esc(l.msg)}</div>`)
    .join('');
}

function renderSettings() {
  const f = $('settings');
  for (const [k, v] of Object.entries(S.settings)) {
    const el = f.elements[k];
    if (!el) continue;
    if (el.type === 'checkbox') el.checked = !!v;
    else el.value = v;
  }
}

function renderAll() {
  renderStartAt();
  renderSheets();
  renderPlan();
  renderRun();
  renderLog();
}

// ---------- actions ----------
const looksLikeHtml = t => /^\s*(<!doctype html|<html[\s>])/i.test(t) || /<div class="card/.test(t);

// Episode HTML → plain page text + brief. Updates both text boxes.
function importHtml(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const { text, brief, pages } = MA.htmlToProject(doc);
  if (!pages) {
    alert('No IMG cards found in that HTML file.');
    return null;
  }
  $('script').value = text;
  $('brief').value = brief;
  if (brief) $('briefBox').open = true;
  return { text, brief };
}

async function saveScript(text, brief = S.project.brief || '') {
  if (looksLikeHtml(text)) {
    const got = importHtml(text);
    if (!got) return;
    ({ text, brief } = got);
  }
  const pages = MA.parseScript(text);
  const same = pages.length === S.project.pages.length;
  S.project = { scriptText: text, brief, pages, overrides: same ? S.project.overrides : {} };
  await store.set({ project: S.project });
}

const readAsDataUrl = file =>
  new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = rej;
    r.readAsDataURL(file);
  });

async function addSheets(files) {
  for (const f of files) {
    if (!f.type.startsWith('image/')) continue;
    const name = f.name.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').trim();
    const existing = S.sheets.find(s => MA.normKey(s.name) === MA.normKey(name));
    const entry = { id: existing?.id || crypto.randomUUID(), name: existing?.name || name, aliases: existing?.aliases || '', fileName: f.name, mime: f.type, dataUrl: await readAsDataUrl(f) };
    S.sheets = existing ? S.sheets.map(s => (s.id === existing.id ? entry : s)) : [...S.sheets, entry];
  }
  await store.set({ sheets: S.sheets });
}

async function command(kind) {
  await refreshTab();
  if ((kind === 'start' || kind === 'resume') && !targetTab) {
    alert('Open chatgpt.com (a new or existing chat) in a tab first.');
    return;
  }
  if (kind === 'start') {
    const from = +($('startAt').value || 0);
    const pending = S.project.pages.slice(from);
    const missing = new Set();
    MA.planAll(S.project.pages, S.sheets, S.settings, S.project.overrides, from).forEach(d => {
      d?.missing.forEach(m => missing.add(m.name));
      d?.block?.missing.forEach(m => missing.add(m.name));
    });
    if (missing.size && !confirm(`No sheet uploaded for: ${[...missing].join(', ')}.\nThose pages will be sent with only the text description. Continue?`)) return;
    const merged = pending.filter(p => p.warnings?.some(w => /merged/.test(w)));
    if (merged.length && !confirm(`${merged.length} page(s) look like several pages stuck together (page ${merged.map(p => p.num).join(', ')}). ChatGPT would draw several images for them. Start anyway?`)) return;
    if (!pending.length) return;
    await store.set({ progress: freshProgress(from), log: [] });
    await store.set({ control: { status: 'running', tabId: targetTab.id, startedAt: Date.now() } });
    chrome.tabs.update(targetTab.id, { active: true });
  } else if (kind === 'resume') {
    await store.set({ control: { ...S.control, status: 'running', tabId: S.control.tabId ?? targetTab.id, reason: null } });
  } else if (kind === 'pause') {
    await store.set({ control: { ...S.control, status: 'paused', reason: 'Paused by you' } });
  } else if (kind === 'skip') {
    const i = S.progress.index;
    const results = { ...S.progress.results, [i]: { status: 'skipped', at: Date.now() } };
    await store.set({ progress: { ...S.progress, index: i + 1, results, pending: null, phase: 'idle' } });
  } else if (kind === 'reset') {
    if (!confirm('Stop and reset progress? (Script and sheets are kept.)')) return;
    await store.set({ control: { status: 'idle' }, progress: freshProgress() });
  }
}

// ---------- wiring ----------
function wire() {
  let t;
  $('script').addEventListener('input', e => {
    clearTimeout(t);
    t = setTimeout(() => saveScript(e.target.value), 400);
  });
  $('scriptFile').addEventListener('change', async e => {
    const f = e.target.files[0];
    if (!f) return;
    const text = await f.text();
    if (!looksLikeHtml(text)) $('script').value = text;
    await saveScript(text);
    e.target.value = '';
  });
  let tb;
  $('brief').addEventListener('input', e => {
    clearTimeout(tb);
    tb = setTimeout(async () => {
      S.project = { ...S.project, brief: e.target.value };
      await store.set({ project: S.project });
    }, 400);
  });

  $('sheetFiles').addEventListener('change', async e => {
    await addSheets([...e.target.files]);
    e.target.value = '';
  });
  const drop = $('drop');
  drop.addEventListener('dragover', e => {
    e.preventDefault();
    drop.classList.add('over');
  });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', async e => {
    e.preventDefault();
    drop.classList.remove('over');
    await addSheets([...e.dataTransfer.files]);
  });
  $('sheets').addEventListener('change', async e => {
    const f = e.target.dataset.f;
    const id = e.target.closest('.sheet')?.dataset.id;
    if (!f || !id) return;
    S.sheets = S.sheets.map(s => (s.id === id ? { ...s, [f]: e.target.value } : s));
    await store.set({ sheets: S.sheets });
  });
  $('sheets').addEventListener('click', async e => {
    const id = e.target.dataset.del;
    if (!id) return;
    S.sheets = S.sheets.filter(s => s.id !== id);
    await store.set({ sheets: S.sheets });
  });

  $('plan').addEventListener('change', async e => {
    const i = e.target.dataset.ov;
    if (i === undefined) return;
    const overrides = { ...S.project.overrides };
    if (e.target.value === 'auto') delete overrides[i];
    else overrides[i] = e.target.value;
    S.project = { ...S.project, overrides };
    await store.set({ project: S.project });
  });
  $('startAt').addEventListener('change', renderPlan);

  $('settings').addEventListener('change', async () => {
    const f = $('settings');
    const next = { ...S.settings };
    for (const k of Object.keys(MA.DEFAULT_SETTINGS)) {
      const el = f.elements[k];
      if (!el) continue;
      if (el.type === 'checkbox') next[k] = el.checked;
      else if (el.type === 'number') next[k] = el.value === '' ? MA.DEFAULT_SETTINGS[k] : Number(el.value);
      else next[k] = el.value.trim();
    }
    await store.set({ settings: next });
  });

  $('btnStart').onclick = () => command('start');
  $('btnResume').onclick = () => command('resume');
  $('btnPause').onclick = () => command('pause');
  $('btnSkip').onclick = () => command('skip');
  $('btnReset').onclick = () => command('reset');
  $('btnClearLog').onclick = e => {
    e.preventDefault();
    store.set({ log: [] });
  };

  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area !== 'local') return;
    for (const [k, { newValue }] of Object.entries(changes)) S[k] = newValue;
    S.settings = { ...MA.DEFAULT_SETTINGS, ...(S.settings || {}) };
    S.project = S.project || { scriptText: '', pages: [], overrides: {} };
    S.sheets = S.sheets || [];
    S.control = S.control || { status: 'idle' };
    S.progress = S.progress || freshProgress();
    S.log = S.log || [];
    if (changes.project) renderStartAt();
    if (changes.project || changes.sheets) renderSheets();
    if (changes.project || changes.sheets || changes.settings || changes.progress || changes.control) renderPlan();
    if (changes.control || changes.progress || changes.project) renderRun();
    if (changes.log) renderLog();
  });

  chrome.tabs.onUpdated.addListener((_id, info) => info.status === 'complete' && refreshTab());
  chrome.tabs.onActivated.addListener(refreshTab);
}

(async () => {
  await load();
  $('script').value = S.project.scriptText || '';
  $('brief').value = S.project.brief || '';
  renderSettings();
  renderAll();
  wire();
  refreshTab();
})();
