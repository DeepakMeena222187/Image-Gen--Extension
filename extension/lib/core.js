// Shared logic: script parsing, sheet matching, attachment planning, message building.
// Loaded by the side panel, the content script, and the Node tests. Only
// htmlToProject() touches the DOM, and only when handed a parsed Document.
(function (root) {
  'use strict';

  const DEFAULT_SETTINGS = {
    sendMode: 'block',          // 'block': send a whole PART first, then "Now create IMGnn" per page
                                // 'page':  send each page's full card as its own message
    blockSize: 0,               // 0 = one block per PART; otherwise at most this many pages per block
    attachMode: 'smart',        // 'smart' | 'always' | 'never'
    refreshEvery: 5,            // re-attach a character's sheet after this many generations in the same chat
    delayMin: 5,                // seconds to wait after an image finishes, before the next prompt
    delayMax: 10,
    genTimeout: 600,            // seconds to wait for one image before treating it as failed
    quietSec: 60,               // a text-only reply must sit unchanged this long before it counts as "no image"
    retries: 1,                 // "please generate it now" nudges when ChatGPT replies without an image
    errorRetries: 3,            // clicks on ChatGPT's own "Retry" button after "Something went wrong"
    onFail: 'pause',            // 'pause' | 'skip'
    rateLimitWaitMin: 0,        // 0 = pause on usage limit; >0 = wait this many minutes and retry
    newChatEvery: 0,            // 0 = never; otherwise start a fresh chat every N pages
    newChatUrl: '',             // e.g. a ChatGPT Project URL; used when starting a fresh chat
    annotateReuse: true,        // tell ChatGPT which sheets were attached earlier in the chat
    oneImageGuard: true,        // tell ChatGPT to make exactly one image, for this page only
    stripVO: true,              // leave "VO (…):" voice-over lines out of the message
    sceneContext: true,         // add the part's one-line beat on the first page of each part
    sendBrief: true,            // send the episode brief once at the start of each chat
    autoDownload: true,
    downloadFolder: 'manhwa-autopilot',
    maxFilesPerMessage: 10,
  };

  const HEADER_LINE_RE = /^[ \t]*={3,}[ \t]*(.+?)[ \t]*={3,}[ \t]*$/;
  const IMG_LINE_RE = /^[ \t]*(?:IMG|IMAGE)[ \t]*0*(\d{1,3})\b[ \t]*(?:[—–:-][ \t]*.*)?$/i;
  const PART_LINE_RE = /^[ \t]*PART[ \t]+[A-Z0-9-]+[ \t]*[—–:-]/i;
  const LAYOUT_LINE_RE = /^[ \t]*L\d{1,2}[ \t]+[^:]{1,40}$/;
  const JUNK_LINE_RE = /^[ \t]*(copy page|copy this whole part|copy now|copied ✓?|\+[ \t]*vo|load-bearing|silent)[ \t]*$/i;
  const ATTACH_LINE_RE = /^[ \t]*[-•]?[ \t]*attach(?:ments?)?[ \t]*[:：][ \t]*(.*)$/im;
  const VO_LINE_RE = /^[ \t]*VO\b[^:\n]{0,30}:/i;
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

  const tidy = s => String(s || '').replace(/\s+/g, ' ').replace(/\s+([:.,])/g, '$1').trim();

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

  function makePage(index, title, body, extra = {}) {
    const m = body.match(ATTACH_LINE_RE);
    const attachRaw = m ? m[1].trim() : '';
    const idm = title.match(/\bIMG\s*0*(\d+)/i) || title.match(/\bpage\s*0*(\d+)/i) || title.match(/^\s*IMAGE\s*0*(\d+)/i);
    const num = idm ? parseInt(idm[1], 10) : index + 1;
    const nn = String(num).padStart(2, '0');
    const warnings = [];
    const attachCount = (body.match(new RegExp(ATTACH_LINE_RE.source, 'gim')) || []).length;
    if (attachCount > 1) warnings.push(`This page has ${attachCount} "Attach:" lines. Several pages may have been merged into one.`);
    if (!/\bprompt\s*:/i.test(body)) warnings.push('No "Prompt:" line found on this page.');
    return {
      index,
      num,
      title: title.trim(),
      body,
      attachRaw,
      characters: parseAttach(attachRaw),
      tags: extra.tags || [],
      part: extra.part || null,
      warnings,
      fileStem: `${nn}_${slug(title, 90) || 'page'}`,
    };
  }

  // Split a script into pages. Understands:
  //  - "=== … ===" header per page (the format the episode HTML's COPY PAGE button makes)
  //  - "IMG10 — Title" lines (text copied straight off the episode page), with the
  //    page's COPY/+VO/LOAD-BEARING/layout/PART lines filtered out
  //  - several "Attach:" blocks with no headers at all
  function parseScript(text) {
    text = String(text || '').replace(/\r\n?/g, '\n');
    const lines = text.split('\n');
    const isStart = l => HEADER_LINE_RE.test(l) || IMG_LINE_RE.test(l);

    if (!lines.some(isStart)) {
      const attachIdx = lines.map((l, i) => (ATTACH_LINE_RE.test(l) ? i : -1)).filter(i => i >= 0);
      if (attachIdx.length > 1) {
        return attachIdx.map((start, k) => {
          const end = k + 1 < attachIdx.length ? attachIdx[k + 1] : lines.length;
          const body = lines.slice(start, end).filter(l => !JUNK_LINE_RE.test(l)).join('\n').trim();
          const pm = body.match(/^\s*prompt\s*:\s*(.{0,60})/im);
          return makePage(k, `Page ${k + 1}${pm ? ` — ${pm[1].trim()}…` : ''}`, body);
        });
      }
      const t = text.trim();
      return t ? [makePage(0, 'Page 1', t)] : [];
    }

    const pages = [];
    let cur = null;
    let part = null;
    let partOpen = false; // collecting the beat line(s) right after a PART header
    let pendingTags = [];

    const close = () => {
      if (!cur) return;
      while (cur.lines.length && !cur.lines[cur.lines.length - 1].trim()) cur.lines.pop();
      pages.push(makePage(pages.length, cur.title, cur.lines.join('\n').trim(), { tags: cur.tags, part: cur.part }));
      cur = null;
    };

    for (const line of lines) {
      const t = line.trim();
      if (PART_LINE_RE.test(t)) {
        close();
        part = { title: t, beat: '' };
        partOpen = true;
        pendingTags = [];
        continue;
      }
      if (JUNK_LINE_RE.test(t)) {
        if (/load-bearing|silent/i.test(t) && !cur) pendingTags.push(t.toUpperCase());
        continue;
      }
      if (LAYOUT_LINE_RE.test(t) && !HEADER_LINE_RE.test(t)) {
        close(); // a layout tag always sits just above the next page's title
        partOpen = false;
        pendingTags.push(t);
        continue;
      }
      const hm = t.match(HEADER_LINE_RE);
      if (hm || IMG_LINE_RE.test(t)) {
        close();
        partOpen = false;
        const title = hm ? hm[1] : t;
        const head = hm ? [line.trim()] : [t, ...(pendingTags.length ? [`Layout: ${pendingTags.join(' · ')}`] : [])];
        cur = { title, lines: head, tags: pendingTags, part };
        pendingTags = [];
        continue;
      }
      if (cur) cur.lines.push(line);
      else if (partOpen && part && t) part.beat = tidy(`${part.beat} ${t}`);
    }
    close();
    return pages;
  }

  // Episode HTML (like S21_EP07_script.html) → { text, brief }.
  // Mirrors the page's own "COPY PAGE" output, without the VO line.
  function htmlToProject(doc) {
    const out = [];
    const h1 = doc.querySelector('h1');
    const episode = h1 ? tidy(h1.textContent) : '';
    const total = [...doc.querySelectorAll('.card h3')].filter(h => /^IMG\s*\d/i.test(tidy(h.textContent))).length;
    let n = 0;
    const cardText = card => {
      const h3 = card.querySelector('h3');
      const title = h3 ? tidy(h3.textContent) : '';
      if (!/^IMG\s*\d/i.test(title)) return null;
      n++;
      const nn = String(n).padStart(2, '0');
      const tags = [...card.querySelectorAll('.tags .badge')].map(b => tidy(b.textContent));
      const lines = [`=== ${episode ? episode + ' — ' : ''}${title} (page ${nn} of ${total}) ===`];
      if (tags.length) lines.push(`PAGE SPEC: ${tags.join(' · ')}`);
      lines.push('');
      for (const el of card.querySelectorAll('.field, .cells .cell, .vo')) {
        if (el.classList.contains('vo')) continue;
        lines.push(el.classList.contains('cell') ? `- ${tidy(el.textContent)}` : tidy(el.textContent));
      }
      return lines.join('\n');
    };

    // Walk the body in order so every card lands under its PART heading.
    for (const el of doc.querySelectorAll('.scene-head, .beat, .card')) {
      if (el.classList.contains('scene-head')) out.push(`\n${tidy(el.textContent)}`);
      else if (el.classList.contains('beat')) out.push(tidy(el.textContent));
      else {
        const t = cardText(el);
        if (t) out.push(`\n${t}\n`);
      }
    }

    const brief = [episode, ...[...doc.querySelectorAll('header .meta, header .note, .note')].map(e => tidy(e.textContent))]
      .filter((v, i, a) => v && a.indexOf(v) === i)
      .join('\n\n');
    return { text: out.join('\n').trim(), brief, pages: n };
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
    return { genInChat: 0, lastAttached: {}, briefSent: false, lastPart: null, lastBlock: null };
  }

  // Block mode groups pages: one block per PART, cut every settings.blockSize
  // pages when that is set (or every 5 pages when the script has no parts).
  function makeBlocks(pages, settings) {
    const size = Math.max(0, Number({ ...DEFAULT_SETTINGS, ...settings }.blockSize) || 0);
    const blocks = [];
    let cur = null;
    pages.forEach((p, i) => {
      const part = p.part?.title || '';
      const limit = size > 0 ? size : part ? Infinity : 5;
      if (!cur || part !== cur.part || cur.idx.length >= limit) {
        cur = { part, idx: [] };
        blocks.push(cur);
      }
      cur.idx.push(i);
    });
    const byPage = {};
    for (const b of blocks) {
      b.key = `p${b.idx[0]}-${b.idx[b.idx.length - 1]}`;
      for (const i of b.idx) byPage[i] = b;
    }
    return { blocks, byPage };
  }

  // Should this sheet go with the next message? (mutates nothing)
  function wantsAttach(sheetId, c, settings, override, refresh) {
    if (override === 'force') return true;
    if (override === 'none') return false;
    if (settings.attachMode === 'always') return true;
    if (settings.attachMode === 'never') return false;
    const last = c.lastAttached[sheetId];
    return last === undefined || c.genInChat - last >= refresh;
  }

  // Decide what to do for one page given the current chat context.
  // override: 'auto' | 'force' | 'none' | 'skip'
  // opts.hasBrief: an episode brief exists and may need sending first.
  // opts.pages / opts.blocks / opts.overrides: needed for block mode.
  function planPage(page, ctx, sheets, settings, override = 'auto', opts = {}) {
    settings = { ...DEFAULT_SETTINGS, ...settings };
    const decision = {
      skip: override === 'skip',
      newChatBefore: false,
      sendBrief: false,
      sceneNote: false,
      block: null,  // { key, idx, attach, reuse, described, missing } when a block message goes first
      attach: [],   // [{ sheetId, name, fuzzy }]
      reuse: [],    // [{ sheetId, name }]  already in chat memory
      missing: [],  // [{ name }]           no sheet uploaded for this character
      described: [], // [{ name }]          no sheet, but the Attach line describes it in text
    };
    if (decision.skip) return decision;

    const every = Number(settings.newChatEvery) || 0;
    if (every > 0 && ctx.genInChat >= every) decision.newChatBefore = true;
    const base = decision.newChatBefore ? freshCtx() : { ...freshCtx(), ...ctx };
    const c = { ...base, lastAttached: { ...base.lastAttached } };
    decision.sendBrief = !!(settings.sendBrief && opts.hasBrief && !c.briefSent);
    decision.sceneNote = !!(settings.sceneContext && page.part?.beat && c.lastPart !== page.part.title);
    const refresh = Math.max(1, Number(settings.refreshEvery) || 1);
    const cap = Math.max(1, Number(settings.maxFilesPerMessage) || 10);

    const sort = (chars, into, ov, seen) => {
      for (const ch of chars) {
        const hit = matchSheet(ch, sheets);
        if (!hit) {
          // "THE STILL — LOCKED. An enormous pale…" carries its own description in the prompt.
          const described = ch.locked && ch.raw.length > ch.name.length + 40;
          const list = described ? into.described : into.missing;
          if (!list.some(m => m.name === ch.name)) list.push({ name: ch.name });
          continue;
        }
        if (seen.has(hit.sheet.id)) continue;
        seen.add(hit.sheet.id);
        const entry = { sheetId: hit.sheet.id, name: hit.sheet.name, charName: ch.name, fuzzy: hit.fuzzy };
        (wantsAttach(hit.sheet.id, c, settings, ov, refresh) ? into.attach : into.reuse).push(entry);
      }
      if (into.attach.length > cap) into.reuse.push(...into.attach.splice(cap));
    };

    // Block mode: the first page we reach in a block sends the whole block first,
    // with every sheet the block needs that ChatGPT doesn't already have.
    const block = settings.sendMode === 'block' && opts.blocks ? opts.blocks.byPage[page.index] : null;
    if (block && c.lastBlock !== block.key && opts.pages) {
      const ov = opts.overrides || {};
      const idx = block.idx.filter(i => i >= page.index && ov[i] !== 'skip');
      decision.block = { key: block.key, idx, attach: [], reuse: [], missing: [], described: [] };
      sort(idx.flatMap(i => opts.pages[i].characters), decision.block, 'auto', new Set());
      for (const a of decision.block.attach) c.lastAttached[a.sheetId] = c.genInChat;
    }

    sort(page.characters, decision, override, new Set());
    return decision;
  }

  // Apply a completed generation to the context.
  function commit(ctx, decision, page) {
    if (decision.skip) return ctx;
    const base = decision.newChatBefore ? freshCtx() : { ...freshCtx(), ...ctx };
    const next = { ...base, lastAttached: { ...base.lastAttached } };
    if (decision.block) {
      for (const a of decision.block.attach) next.lastAttached[a.sheetId] = next.genInChat;
      next.lastBlock = decision.block.key;
    }
    for (const a of decision.attach) next.lastAttached[a.sheetId] = next.genInChat;
    if (decision.sendBrief) next.briefSent = true;
    if (page?.part) next.lastPart = page.part.title;
    next.genInChat += 1;
    return next;
  }

  // Everything planPage needs besides the page itself.
  function planOpts(pages, settings, overrides = {}, hasBrief = false) {
    return { hasBrief, pages, overrides, blocks: makeBlocks(pages, settings) };
  }

  // Simulate a whole run (for the preview table).
  function planAll(pages, sheets, settings, overrides = {}, startIndex = 0, startCtx = freshCtx(), opts = {}) {
    let ctx = startCtx;
    const o = { ...planOpts(pages, settings, overrides), ...opts };
    return pages.map((p, i) => {
      if (i < startIndex) return null;
      const d = planPage(p, ctx, sheets, settings, overrides[i] || 'auto', o);
      ctx = commit(ctx, d, p);
      return d;
    });
  }

  function briefMessage(brief) {
    return (
      'EPISODE BRIEF: the rules and story context for every page I will send in this chat, one page per message.\n' +
      'Read it and keep following it for every page. Do NOT generate any image for this message. Just reply "Ready".\n\n' +
      String(brief || '').trim()
    );
  }

  const nn = n => String(n).padStart(2, '0');
  const names = list => list.map(a => a.charName || a.name).join(', ');

  // "IMG20 — And One In The Mouth", however the page title was written.
  function pageLabel(page) {
    const m = page.title.match(/IMG\s*\d+(?:\s*[—–:-]\s*[^(=]+)?/i);
    return tidy(m ? m[0] : `IMG${nn(page.num)} — ${page.title}`).replace(/\s*[—–:-]\s*$/, '');
  }

  function cardLines(page, settings) {
    let lines = page.body.split('\n').filter(l => !JUNK_LINE_RE.test(l));
    if (settings.stripVO) lines = lines.filter(l => !VO_LINE_RE.test(l));
    return lines;
  }

  // Block mode, step 1: every card of the block in one message, no image yet.
  function blockMessage(pages, decision, settings) {
    settings = { ...DEFAULT_SETTINGS, ...settings };
    const b = decision.block;
    const ps = b.idx.map(i => pages[i]);
    const cards = ps.map(p => cardLines(p, settings));
    // Long lines that repeat on every card (the Negative block) are stated once.
    const shared =
      cards.length > 1
        ? [...new Set(cards[0].filter(l => l.trim().length > 80 && !ATTACH_LINE_RE.test(l) && cards.every(c => c.includes(l))))]
        : [];
    const body = cards.map(c => c.filter(l => !shared.includes(l)).join('\n').replace(/\n{3,}/g, '\n\n').trim());
    const first = ps[0];
    const last = ps[ps.length - 1];
    const range = ps.length > 1 ? `IMG${nn(first.num)} to IMG${nn(last.num)}` : `IMG${nn(first.num)}`;
    const part = first.part;

    const out = [
      `BLOCK: ${ps.length} page card${ps.length > 1 ? 's' : ''}, ${range}${part ? ` (${part.title})` : ''}.`,
      'Read every card now, but do NOT generate any image for this message.',
      'After this I will ask for the pages one at a time, in order. Each time, draw exactly ONE image: only the page I name, following its card exactly.',
    ];
    if (b.attach.length) out.push(`Reference sheets attached with this message: ${names(b.attach)}. Match every character to its sheet.`);
    if (b.reuse.length) out.push(`Reference sheets already in this chat (keep using them exactly): ${names(b.reuse)}.`);
    if (b.described.length) out.push(`Described in words on the cards (no sheet): ${names(b.described)}.`);
    out.push('Reply only "Ready".');
    if (settings.sceneContext && part?.beat) out.push('', `Scene: ${part.beat}`);
    if (shared.length) out.push('', 'Rules for EVERY page in this block:', ...shared);
    out.push('', body.join('\n\n---\n\n'));
    return out.join('\n');
  }

  // Block mode, step 2: the short "now draw this one" message.
  function pageCommand(page, decision) {
    const label = pageLabel(page);
    const out = [
      `Now create ${label}. Exactly ONE image for this page only, following the IMG${nn(page.num)} card in the block above exactly: layout, prompt, SFX, face, balloons, window text and negative. Do not draw any other page.`,
    ];
    const win = page.body.split('\n').filter(l => /^\s*window text\b/i.test(l));
    if (win.length) out.push(...win.map(l => l.trim()));
    if (decision.attach.length) {
      out.push(`(Reference sheet${decision.attach.length > 1 ? 's' : ''} attached again with this message: ${names(decision.attach)}. Use exactly.)`);
    }
    return out.join('\n');
  }

  // Build the text sent to ChatGPT for a page.
  function buildMessage(page, decision, settings) {
    settings = { ...DEFAULT_SETTINGS, ...settings };
    if (settings.sendMode === 'block') return pageCommand(page, decision);
    let text = cardLines(page, settings).join('\n').replace(/\n{3,}/g, '\n\n').trim();

    if (settings.annotateReuse && decision.reuse.length) {
      const reused = names(decision.reuse);
      const now = names(decision.attach);
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
    }

    const top = [];
    if (settings.oneImageGuard) {
      top.push(`Generate exactly ONE image: page ${nn(page.num)} only, as described below. Do not draw any other page.`);
    }
    if (decision.sceneNote && page.part) top.push(`Scene context: ${page.part.title} — ${page.part.beat}`);
    return top.length ? `${top.join('\n')}\n\n${text}` : text;
  }

  const api = {
    DEFAULT_SETTINGS,
    normKey,
    slug,
    parseAttach,
    parseScript,
    htmlToProject,
    matchSheet,
    freshCtx,
    makeBlocks,
    planOpts,
    planPage,
    commit,
    planAll,
    briefMessage,
    blockMessage,
    pageCommand,
    pageLabel,
    buildMessage,
  };
  root.MA = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
