// Runs inside chatgpt.com. Drives the composer: attach sheets, type prompt, send,
// wait for the image, download it, wait, repeat. All state lives in chrome.storage
// so a reload / navigation resumes where it left off.
(() => {
  'use strict';
  if (window.__MA_RUNNER__) return;
  window.__MA_RUNNER__ = true;

  const MA = globalThis.MA;

  // ChatGPT changes its DOM often. If something breaks, this is the place to patch.
  const SEL = {
    editor: ['#prompt-textarea[contenteditable="true"]', 'div#prompt-textarea', 'div.ProseMirror[contenteditable="true"]', 'textarea#prompt-textarea', 'form textarea'],
    send: ['button[data-testid="send-button"]', 'button#composer-submit-button', 'button[aria-label="Send prompt"]', 'button[aria-label*="Send"]'],
    stop: ['button[data-testid="stop-button"]', 'button[aria-label*="Stop"]'],
    newChat: ['a[data-testid="create-new-chat-button"]', 'button[data-testid="create-new-chat-button"]', 'a[aria-label="New chat"]', 'button[aria-label="New chat"]'],
    userMsg: '[data-message-author-role="user"]',
    assistantMsg: '[data-message-author-role="assistant"]',
    turn: 'article[data-testid^="conversation-turn"], [data-testid^="conversation-turn-"]',
    progress: '[role="progressbar"], .animate-spin',
  };
  const BUSY_RE = /creating image|generating|getting started|adding details|almost done|still working|thinking|analy[sz]ing|reading (the )?(image|file|document)s?|uploading|processing|one moment|just a (sec|moment)/i;
  const LIMIT_RE = /(hit|reached) (the|your) .{0,40}limit|rate limit|too many (requests|images)|limit resets|try again (later|in \d|after \d)/i;
  const ERROR_RE = /something went wrong|an error occurred|error (in|generating|while)|network error|there was (a problem|an error)|unable to (load|generate)|failed to (load|generate)|conversation not found/i;

  let myTabId = null;
  let looping = false;
  let control = null;
  let baselineBox = null; // assistant reply that existed before our last send

  class Halt extends Error {}

  // ---------- small helpers ----------
  const q = list => {
    for (const s of [].concat(list)) {
      const el = document.querySelector(s);
      if (el) return el;
    }
    return null;
  };
  const visible = el => !!el && el.getClientRects().length > 0;
  const now = () => Date.now();

  function checkHalt() {
    if (!control || control.status !== 'running' || control.tabId !== myTabId) throw new Halt();
  }

  async function sleep(ms) {
    const end = now() + ms;
    while (now() < end) {
      checkHalt();
      await new Promise(r => setTimeout(r, Math.min(500, end - now())));
    }
  }

  async function waitFor(fn, timeoutMs, stepMs = 500) {
    const end = now() + timeoutMs;
    for (;;) {
      checkHalt();
      const v = fn();
      if (v) return v;
      if (now() > end) return null;
      await new Promise(r => setTimeout(r, stepMs));
    }
  }

  async function get(keys) {
    return chrome.storage.local.get(keys);
  }
  async function set(obj) {
    return chrome.storage.local.set(obj);
  }

  async function log(msg, level = 'info') {
    const { log: lines = [] } = await get('log');
    lines.push({ t: now(), level, msg });
    await set({ log: lines.slice(-400) });
  }

  async function setControl(patch) {
    const { control: c } = await get('control');
    control = { ...c, ...patch };
    await set({ control });
  }

  async function patchProgress(patch) {
    const { progress: p } = await get('progress');
    const next = { ...p, ...patch };
    await set({ progress: next });
    return next;
  }

  // ---------- DOM actions ----------
  const editorText = el => (el.tagName === 'TEXTAREA' ? el.value : el.innerText || '');
  const squash = s => s.replace(/\s+/g, ' ').trim();

  async function clearEditor(el) {
    el.focus();
    if (el.tagName === 'TEXTAREA') return;
    document.execCommand('selectAll');
    document.execCommand('delete');
  }

  async function typeText(text) {
    const el = await waitFor(() => q(SEL.editor), 30000);
    if (!el) throw new Error('Could not find the ChatGPT message box.');
    await clearEditor(el);
    if (el.tagName === 'TEXTAREA') {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(el, text);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      // insertText avoids ChatGPT turning long pastes into a "pasted text" attachment.
      document.execCommand('insertText', false, text);
      await sleep(300);
      if (!squash(editorText(el)).includes(squash(text).slice(0, 60))) {
        await clearEditor(el);
        const dt = new DataTransfer();
        dt.setData('text/plain', text);
        el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      }
    }
    await sleep(400);
    if (!squash(editorText(el)).includes(squash(text).slice(0, 60))) {
      throw new Error('Typing the prompt into ChatGPT failed.');
    }
  }

  async function dataUrlToFile(dataUrl, name, mime) {
    const blob = await (await fetch(dataUrl)).blob();
    return new File([blob], name, { type: mime || blob.type || 'image/png' });
  }

  async function attachFiles(files) {
    if (!files.length) return;
    const inputs = [...document.querySelectorAll('input[type="file"]')];
    const input =
      inputs.find(i => /image/.test(i.accept || '')) || inputs.find(i => !i.accept) || inputs[0];
    const dt = new DataTransfer();
    files.forEach(f => dt.items.add(f));
    if (input) {
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      const el = q(SEL.editor);
      if (!el) throw new Error('No file input or message box found for attaching sheets.');
      el.focus();
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    }
    // Give uploads time to start, then wait for spinners to clear.
    await sleep(1500 + 700 * files.length);
    const form = q(SEL.editor)?.closest('form') || document;
    let calm = 0;
    await waitFor(() => {
      calm = form.querySelector(SEL.progress) ? 0 : calm + 1;
      return calm >= 4;
    }, 120000);
  }

  async function clickSend() {
    const btn = await waitFor(() => {
      const b = q(SEL.send);
      return b && !b.disabled && b.getAttribute('aria-disabled') !== 'true' ? b : null;
    }, 120000);
    const before = document.querySelectorAll(SEL.userMsg).length;
    baselineBox = lastAssistant();
    if (btn) btn.click();
    else {
      const el = q(SEL.editor);
      el?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
    }
    const ok = await waitFor(() => document.querySelectorAll(SEL.userMsg).length > before, 20000);
    if (!ok) throw new Error('Clicked send but no message appeared (upload still running, or ChatGPT UI changed).');
  }

  function lastAssistant() {
    const turns = [...document.querySelectorAll(SEL.turn)];
    if (turns.length) {
      const last = turns[turns.length - 1];
      return last.querySelector(SEL.userMsg) ? null : last;
    }
    const msgs = document.querySelectorAll(SEL.assistantMsg);
    return msgs.length ? msgs[msgs.length - 1] : null;
  }

  function bigImages(container) {
    return [...container.querySelectorAll('img')].filter(
      img => img.complete && img.naturalWidth >= 256 && img.naturalHeight >= 256 && visible(img),
    );
  }

  // Anything that says "still working" inside the reply: half-loaded or blurred
  // preview images, shimmer/pulse placeholders, aria-busy, or a short status line.
  function replyBusy(box, text) {
    if (!box) return false;
    if (box.querySelector('[aria-busy="true"], .animate-pulse, [class*="shimmer"], [class*="skeleton"]')) return true;
    for (const img of box.querySelectorAll('img')) {
      if (!visible(img)) continue;
      if (!img.complete) return true;
      if (img.naturalWidth >= 256 && /blur/.test(getComputedStyle(img).filter || '')) return true;
    }
    // "Something went wrong while generating…" is an error, not progress.
    return text.length < 300 && BUSY_RE.test(text) && !ERROR_RE.test(text) && !LIMIT_RE.test(text);
  }

  function findRetryButton() {
    const btns = [...document.querySelectorAll('main button, [role="main"] button')].filter(visible);
    for (let k = btns.length - 1; k >= 0; k--) {
      const label = (btns[k].innerText || btns[k].getAttribute('aria-label') || '').trim();
      if (/^(retry|try again|regenerate)$/i.test(label)) return btns[k];
    }
    return null;
  }

  // Waits for the reply to the last message sent. Returns
  // { kind: 'image', imgs } | { kind: 'text', text } | { kind: 'limit', text } |
  // { kind: 'noimage', text } | { kind: 'error', text } | { kind: 'timeout' }
  //
  // ChatGPT often goes quiet for a long time after sheets are attached (it is
  // reading them), shows empty or shimmering placeholders, or briefly blanks the
  // reply. None of that counts as "done": a reply without an image must sit
  // unchanged, with nothing busy, for settings.quietSec before we call it.
  async function waitForResult(settings, expectImage = true) {
    const end = now() + (Number(settings.genTimeout) || 600) * 1000;
    const quietMs = expectImage ? Math.max(15, Number(settings.quietSec) || 60) * 1000 : 6000;
    const maxErrorClicks = Number(settings.errorRetries ?? 3);
    const started = now();
    let errorClicks = 0;
    let lastSig = '';
    let stableSince = now();
    while (now() < end) {
      checkHalt();
      const stop = q(SEL.stop);
      const stopping = !!stop && visible(stop);
      let box = lastAssistant();
      if (box && box === baselineBox) box = null;
      const text = box ? (box.innerText || '').trim() : '';
      const imgs = box ? bigImages(box) : [];
      const busy = stopping || replyBusy(box, text);
      const sig = `${busy}|${text.length}|${imgs.map(i => i.currentSrc || i.src).join(',')}`;
      if (sig !== lastSig) {
        lastSig = sig;
        stableSince = now();
      }
      const stableFor = now() - stableSince;
      // Page-level text is only trusted once the send is well behind us, so an old
      // error or limit notice from a previous page can't end this wait.
      const tail = box || now() - started > 20000 ? (q(['main', '[role="main"]', 'body'])?.innerText || '').slice(-1500) : '';

      if (!busy && stableFor > 3000 && !imgs.length) {
        if (LIMIT_RE.test(box ? text : tail)) return { kind: 'limit', text: box ? text : 'Usage limit message on page' };
        if (ERROR_RE.test(box ? text : tail)) {
          const retry = findRetryButton();
          if (retry && errorClicks < maxErrorClicks) {
            errorClicks++;
            await log(`ChatGPT showed an error, clicking its Retry button (${errorClicks}/${maxErrorClicks})`, 'warn');
            baselineBox = null;
            retry.click();
            lastSig = '';
            await sleep(5000);
            continue;
          }
          return { kind: 'error', text: box ? text : tail.slice(-200) };
        }
      }
      if (!busy && box) {
        if (imgs.length && stableFor > 5000) return { kind: 'image', imgs };
        if (!expectImage && text && stableFor > quietMs) return { kind: 'text', text };
        if (expectImage && !imgs.length && text.length >= 20 && stableFor > quietMs) return { kind: 'noimage', text };
      }
      await new Promise(r => setTimeout(r, 1000));
    }
    return { kind: 'timeout' };
  }

  async function sendText(text) {
    await typeText(text);
    await clickSend();
  }

  async function imgToDataUrl(src) {
    const res = await fetch(src, { credentials: 'include' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = reject;
      r.readAsDataURL(blob);
    });
  }

  async function download(imgs, page, settings) {
    const pick = [...imgs].sort((a, b) => b.naturalWidth * b.naturalHeight - a.naturalWidth * a.naturalHeight)[0];
    const src = pick.currentSrc || pick.src;
    const folder = (settings.downloadFolder || 'manhwa-autopilot').replace(/[\\:*?"<>|]+/g, '').replace(/^\/+|\/+$/g, '');
    const filename = `${folder ? folder + '/' : ''}${page.fileStem}.png`;
    let url = src;
    try {
      url = await imgToDataUrl(src);
    } catch {
      /* fall back to letting chrome.downloads fetch it with the browser's cookies */
    }
    const res = await chrome.runtime.sendMessage({ type: 'download', url, filename });
    if (!res?.ok) throw new Error(`Download failed: ${res?.error || 'unknown'}`);
    return filename;
  }

  async function startNewChat(settings) {
    if (settings.newChatUrl) {
      location.assign(settings.newChatUrl); // content script reloads and resumes
      await new Promise(() => {});
    }
    const btn = q(SEL.newChat);
    const before = location.href;
    if (btn) {
      btn.click();
      await waitFor(() => location.href !== before || !document.querySelector(SEL.userMsg), 10000);
      await sleep(1500);
      return;
    }
    location.assign(location.origin + '/');
    await new Promise(() => {});
  }

  // ---------- one page ----------
  async function runPage(project, sheets, settings, progress) {
    const i = progress.index;
    const page = project.pages[i];
    const override = (project.overrides || {})[i] || 'auto';
    const results = { ...(progress.results || {}) };

    // Re-derive the decision unless we already sent this page (resume after reload).
    let decision = progress.pending?.index === i ? progress.pending.decision : null;
    if (!decision) decision = MA.planPage(page, progress.ctx, sheets, settings, override, { hasBrief: !!project.brief?.trim() });

    if (decision.skip) {
      results[i] = { status: 'skipped', at: now() };
      await patchProgress({ index: i + 1, results, pending: null, phase: 'idle' });
      await log(`Page ${page.num}: skipped`);
      return;
    }

    if (progress.phase !== 'sent') {
      if (decision.newChatBefore) {
        await log(`Starting a fresh chat before page ${page.num}`);
        await patchProgress({ pending: { index: i, decision: { ...decision, newChatBefore: false } }, ctx: MA.freshCtx() });
        decision = { ...decision, newChatBefore: false };
        progress.ctx = MA.freshCtx();
        await startNewChat(settings);
      }
      if (!(await waitFor(() => q(SEL.editor), 30000))) throw new Error('ChatGPT composer not found. Is the chat open?');

      if (decision.sendBrief) {
        await log('Sending the episode brief first (rules and story context, no image)');
        await sendText(MA.briefMessage(project.brief));
        const r = await waitForResult({ ...settings, genTimeout: 300 }, false);
        if (r.kind === 'limit') throw new Error('ChatGPT usage limit reached. Paused. Resume when your limit resets.');
        if (r.kind === 'error' || r.kind === 'timeout') throw new Error(`The episode brief did not get a reply (${r.kind}).`);
        progress.ctx = { ...MA.freshCtx(), ...progress.ctx, briefSent: true };
        decision = { ...decision, sendBrief: false };
        await patchProgress({ ctx: progress.ctx, pending: { index: i, decision } });
        await sleep(3000);
      }

      const byId = Object.fromEntries(sheets.map(s => [s.id, s]));
      const files = [];
      for (const a of decision.attach) {
        const s = byId[a.sheetId];
        if (s) files.push(await dataUrlToFile(s.dataUrl, s.fileName || `${MA.slug(s.name)}.png`, s.mime));
      }
      const names = decision.attach.map(a => a.name).join(', ') || 'none';
      const reused = decision.reuse.map(a => a.name).join(', ');
      await log(`Page ${page.num}: attaching [${names}]${reused ? `, reusing from chat [${reused}]` : ''}${decision.missing.length ? `, no sheet for [${decision.missing.map(m => m.name).join(', ')}]` : ''}`);

      await attachFiles(files);
      await typeText(MA.buildMessage(page, decision, settings));
      await clickSend();
      await patchProgress({ phase: 'sent', pending: { index: i, decision }, sentAt: now() });
    } else {
      await log(`Page ${page.num}: resuming, waiting for the image already requested`);
    }

    let result;
    let nudges = 0;
    for (;;) {
      result = await waitForResult(settings, true);
      if (result.kind === 'limit') {
        const wait = Number(settings.rateLimitWaitMin) || 0;
        if (wait > 0) {
          await log(`Usage limit hit. Waiting ${wait} min, then asking again.`, 'warn');
          await sleep(wait * 60000);
          await sendText('Please continue and generate the image from my previous message now, exactly as specified. One image only.');
          continue;
        }
        throw Object.assign(new Error('ChatGPT usage limit reached. Paused. Resume when your limit resets.'), { soft: true });
      }
      if ((result.kind === 'noimage' || result.kind === 'error') && nudges < (Number(settings.retries) || 0)) {
        nudges++;
        await log(`Page ${page.num}: ${result.kind === 'error' ? 'ChatGPT errored' : 'reply had no image'}, asking again (${nudges})`, 'warn');
        await sendText(`Please generate the image for page ${String(page.num).padStart(2, '0')} now, exactly as specified in my previous message. One image only. Do not ask questions.`);
        continue;
      }
      break;
    }

    if (result.kind !== 'image') {
      const why =
        result.kind === 'timeout'
          ? `no image after ${settings.genTimeout}s`
          : result.kind === 'error'
            ? `ChatGPT error: "${(result.text || '').slice(0, 140)}"`
            : `reply had no image: "${(result.text || '').slice(0, 140)}"`;
      if (settings.onFail === 'skip') {
        results[i] = { status: 'failed', error: why, at: now() };
        await log(`Page ${page.num}: ${why}. Skipping.`, 'error');
        // The sheets were still sent, so count them as in chat memory.
        await patchProgress({ index: i + 1, results, ctx: MA.commit(progress.ctx, decision, page), pending: null, phase: 'idle' });
        return;
      }
      throw new Error(`Page ${page.num}: ${why}`);
    }

    let file = null;
    if (settings.autoDownload) {
      try {
        file = await download(result.imgs, page, settings);
      } catch (e) {
        await log(`Page ${page.num}: ${e.message}`, 'warn');
      }
    }
    results[i] = { status: 'done', file, attached: decision.attach.map(a => a.name), at: now() };
    await patchProgress({ index: i + 1, results, ctx: MA.commit(progress.ctx, decision, page), pending: null, phase: 'idle' });
    await log(`Page ${page.num}: done${file ? ` → ${file}` : ''}`, 'ok');

    if (i + 1 < project.pages.length) {
      const lo = Number(settings.delayMin) || 0;
      const hi = Math.max(lo, Number(settings.delayMax) || lo);
      await sleep((lo + Math.random() * (hi - lo)) * 1000);
    }
  }

  // ---------- main loop ----------
  async function loop() {
    if (looping) return;
    looping = true;
    try {
      for (;;) {
        const st = await get(['control', 'progress', 'project', 'sheets', 'settings']);
        control = st.control;
        if (!control || control.status !== 'running' || control.tabId !== myTabId) return;
        const project = st.project;
        const progress = st.progress;
        if (!project?.pages?.length) throw new Error('No script loaded.');
        if (progress.index >= project.pages.length) {
          await setControl({ status: 'done' });
          await log('All pages finished.', 'ok');
          return;
        }
        const settings = { ...MA.DEFAULT_SETTINGS, ...(st.settings || {}) };
        await runPage(project, st.sheets || [], settings, progress);
      }
    } catch (e) {
      if (!(e instanceof Halt)) {
        await log(e.message || String(e), 'error');
        await setControl({ status: 'paused', reason: e.message });
      }
    } finally {
      looping = false;
    }
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.control) return;
    control = changes.control.newValue;
    if (control?.status === 'running' && control.tabId === myTabId) loop();
  });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'ping') sendResponse({ ok: true, tabId: myTabId, composer: !!q(SEL.editor) });
  });

  (async () => {
    const res = await chrome.runtime.sendMessage({ type: 'whoami' });
    myTabId = res?.tabId ?? null;
    const st = await get('control');
    control = st.control;
    if (control?.status === 'running' && control.tabId === myTabId) {
      await sleep(2500).catch(() => {});
      loop();
    }
  })();
})();
