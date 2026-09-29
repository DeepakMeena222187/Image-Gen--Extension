// Shared, DOM-free logic: script parsing, sheet matching, attachment planning.
// Loaded by the side panel, the content script, and the Node tests.
(function (root) {
  'use strict';

  const DEFAULT_SETTINGS = {
    attachMode: 'smart',        // 'smart' | 'always' | 'never'
    refreshEvery: 5,            // re-attach a character's sheet after this many generations in the same chat
    delayMin: 5,                // seconds to wait after an image finishes, before the next prompt
    delayMax: 10,
    genTimeout: 420,            // seconds to wait for one image before treating it as failed
    retries: 1,                 // "please generate it now" nudges when ChatGPT replies without an image
    onFail: 'pause',            // 'pause' | 'skip'
    rateLimitWaitMin: 0,        // 0 = pause on usage limit; >0 = wait this many minutes and retry
    newChatEvery: 0,            // 0 = never; otherwise start a fresh chat every N pages
    newChatUrl: '',             // e.g. a ChatGPT Project URL; used when starting a fresh chat
    annotateReuse: true,        // tell ChatGPT which sheets were attached earlier in the chat
    autoDownload: true,
    downloadFolder: 'manhwa-autopilot',
    maxFilesPerMessage: 10,
  };

  const HEADER_RE = /^[ \t]*={3,}[ \t]*(.+?)[ \t]*={3,}[ \t]*$/gm;
  const ATTACH_LINE_RE = /^[ \t]*attach(?:ments?)?[ \t]*[:：][ \t]*(.*)$/im;
  const NONE_RE = /^(none|n\/?a|nothing|no sheets?|-+|—)\.?$/i;

  function normKey(s) {
    return String(s || '')
      .toLowerCase()
      .replace(/\.(png|jpe?g|webp|gif)$/i, '')
      .replace(/\b(design|character|char)\s+(sheet|ref(erence)?)s?\b/g, ' ')
      .replace(/\b(sheet|ref|reference|seed|image|img|locked)s?\b/g, ' ')
      .replace(/\b(level|lvl)\b/g, 'lv')
      .replace(/[^a-z0-9]+/g, '');
  }

  function slug(s, max = 80) {
    return String(s || '')
      .normalize('NFKD')
      .replace(/[^\w\s-]+/g, ' ')
      .trim()
      .replace(/[\s_]+/g, '-')
      .replace(/-+/g, '-')
      .toLowerCase()
      .slice(0, max)
      .replace(/-+$/, '');
  }

  function cleanName(part) {
    // Name = text before the first " — ", " – ", " - ", ": " or ". "
    const head = part.split(/\s+[—–-]\s+|\s*:\s+|\.\s+/)[0];
    const stripped = head
      .replace(/\b(design\s+)?(sheet|ref(erence)?|seed)s?\b\.?/gi, ' ')
      .replace(/\s+/g, ' ')
      .replace(/[.\s]+$/, '')
      .trim();
    return stripped || head.trim();
  }

  function parseAttach(raw) {
    raw = String(raw || '').trim();
    if (!raw || NONE_RE.test(raw)) return [];
    let parts;
    if (/\s\+\s/.test(raw)) {
      parts = raw.split(/\s+\+\s+/);
    } else {
      const byComma = raw.split(/\s*[,;]\s*/);
      // Only treat commas as separators when every piece looks like a short name.
      parts = byComma.every(p => p.split(/\s+/).length <= 6) ? byComma : [raw];
    }
    const seen = new Set();
    const out = [];
    for (let part of parts) {
      part = part.trim();
      if (!part) continue;
      const name = cleanName(part);
      const key = normKey(name);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push({ raw: part, name, key, locked: /\bLOCKED\b/.test(part) });
    }
    return out;
  }

  function makePage(index, title, body) {
    const m = body.match(ATTACH_LINE_RE);
    const attachRaw = m ? m[1].trim() : '';
    const idm = title.match(/\bIMG\s*0*(\d+)/i) || title.match(/\bpage\s*0*(\d+)/i);
    const num = idm ? parseInt(idm[1], 10) : index + 1;
    const nn = String(num).padStart(2, '0');
    return {
      index,
      num,
      title: title.trim(),
      body,
      attachRaw,
      characters: parseAttach(attachRaw),
      fileStem: `${nn}_${slug(title, 90) || 'page'}`,
    };
  }

  // Split a script into pages on "=== ... ===" headers.
  function parseScript(text) {
    text = String(text || '').replace(/\r\n?/g, '\n');
    const heads = [...text.matchAll(HEADER_RE)];
    if (!heads.length) {
      const t = text.trim();
      return t ? [makePage(0, 'Page 1', t)] : [];
    }
    return heads.map((m, i) => {
      const end = i + 1 < heads.length ? heads[i + 1].index : text.length;
      return makePage(i, m[1], text.slice(m.index, end).trim());
    });
  }

  function sheetKeys(sheet) {
    const keys = [normKey(sheet.name)];
    String(sheet.aliases || '')
      .split(',')
      .map(normKey)
      .filter(Boolean)
      .forEach(k => keys.push(k));
    return keys.filter(Boolean);
  }

  // Returns { sheet, fuzzy } or null. Exact key match wins; otherwise the longest
  // containment match (either direction) of at least 3 chars.
  function matchSheet(character, sheets) {
    const ck = character.key;
    for (const s of sheets) if (sheetKeys(s).includes(ck)) return { sheet: s, fuzzy: false };
    let best = null;
    let bestLen = 0;
    for (const s of sheets) {
      for (const k of sheetKeys(s)) {
        if (k.length < 3) continue;
        if ((ck.includes(k) || k.includes(ck)) && k.length > bestLen) {
          best = s;
          bestLen = k.length;
        }
      }
    }
    return best ? { sheet: best, fuzzy: true } : null;
  }

  function freshCtx() {
    return { genInChat: 0, lastAttached: {} };
  }

  // Decide what to do for one page given the current chat context.
  // override: 'auto' | 'force' | 'none' | 'skip'
  function planPage(page, ctx, sheets, settings, override = 'auto') {
    settings = { ...DEFAULT_SETTINGS, ...settings };
    const decision = {
      skip: override === 'skip',
      newChatBefore: false,
      attach: [],   // [{ sheetId, name, fuzzy }]
      reuse: [],    // [{ sheetId, name }]  already in chat memory
      missing: [],  // [{ name }]           no sheet uploaded for this character
    };
    if (decision.skip) return decision;

    const every = Number(settings.newChatEvery) || 0;
    if (every > 0 && ctx.genInChat >= every) decision.newChatBefore = true;
    const genInChat = decision.newChatBefore ? 0 : ctx.genInChat;
    const lastAttached = decision.newChatBefore ? {} : ctx.lastAttached;
    const refresh = Math.max(1, Number(settings.refreshEvery) || 1);

    const seen = new Set();
    for (const ch of page.characters) {
      const hit = matchSheet(ch, sheets);
      if (!hit) {
        decision.missing.push({ name: ch.name });
        continue;
      }
      if (seen.has(hit.sheet.id)) continue;
      seen.add(hit.sheet.id);
      const last = lastAttached[hit.sheet.id];
      let attach;
      if (override === 'force') attach = true;
      else if (override === 'none') attach = false;
      else if (settings.attachMode === 'always') attach = true;
      else if (settings.attachMode === 'never') attach = false;
      else attach = last === undefined || genInChat - last >= refresh;

      const entry = { sheetId: hit.sheet.id, name: hit.sheet.name, charName: ch.name, fuzzy: hit.fuzzy };
      (attach ? decision.attach : decision.reuse).push(entry);
    }
    const cap = Math.max(1, Number(settings.maxFilesPerMessage) || 10);
    if (decision.attach.length > cap) decision.reuse.push(...decision.attach.splice(cap));
    return decision;
  }

  // Apply a completed generation to the context.
  function commit(ctx, decision) {
    if (decision.skip) return ctx;
    const next = decision.newChatBefore
      ? freshCtx()
      : { genInChat: ctx.genInChat, lastAttached: { ...ctx.lastAttached } };
    for (const a of decision.attach) next.lastAttached[a.sheetId] = next.genInChat;
    next.genInChat += 1;
    return next;
  }

  // Simulate a whole run (for the preview table).
  function planAll(pages, sheets, settings, overrides = {}, startIndex = 0, startCtx = freshCtx()) {
    let ctx = startCtx;
    return pages.map((p, i) => {
      if (i < startIndex) return null;
      const d = planPage(p, ctx, sheets, settings, overrides[i] || 'auto');
      ctx = commit(ctx, d);
      return d;
    });
  }

  // Build the text sent to ChatGPT for a page.
  function buildMessage(page, decision, settings) {
    settings = { ...DEFAULT_SETTINGS, ...settings };
    let text = page.body;
    if (!settings.annotateReuse || !decision.reuse.length) return text;
    const reused = decision.reuse.map(r => r.charName || r.name).join(', ');
    const now = decision.attach.map(a => a.charName || a.name).join(', ');
    const note =
      `(Reference sheets for ${reused} were attached earlier in this chat — keep using them exactly.` +
      (now ? ` Attached with this message: ${now}.)` : ')');
    const m = text.match(ATTACH_LINE_RE);
    if (m) {
      const at = m.index + m[0].length;
      text = text.slice(0, at) + '\n' + note + text.slice(at);
    } else {
      text = note + '\n\n' + text;
    }
    return text;
  }

  const api = {
    DEFAULT_SETTINGS,
    normKey,
    slug,
    parseAttach,
    parseScript,
    matchSheet,
    freshCtx,
    planPage,
    commit,
    planAll,
    buildMessage,
  };
  root.MA = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
