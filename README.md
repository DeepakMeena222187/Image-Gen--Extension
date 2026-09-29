# Manhwa Autopilot for ChatGPT

A Chrome extension that runs a whole episode's page prompts through ChatGPT image generation, one page at a time:

1. It pastes the prompt for the page.
2. It attaches the character sheets that page needs, but **only when ChatGPT is likely to have forgotten them**.
3. It waits for the image to finish, then downloads it with a sensible filename.
4. It waits a random 5–10 seconds, then moves to the next page.

If the tab reloads or you pause, it picks up at the same page.

## Install (about 1 minute)

1. Download this repo (Code → Download ZIP) and unzip it.
2. Open `chrome://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and select the `extension/` folder.
4. Pin the extension. Clicking its icon opens the side panel.

## Use

1. Open `https://chatgpt.com` in a tab and start a new chat (or open a Project chat).
2. In the side panel:
   - **Script**: load the episode's `.html` script file (best), or paste text copied from it. "COPY THIS WHOLE PART" text works too.
   - **Character sheets**: drop in your sheet images once. They are stored locally in the extension.
   - **Plan**: check every page before you start. Each character on a page gets a chip:
     - 📎 **green**: the sheet will be attached on this page.
     - **grey**: ChatGPT already has this sheet from earlier in the chat, so it is not re-uploaded.
     - **red**: no sheet is uploaded for this character. The prompt text still describes it.
     - **⚠**: the name was a guessed match. Rename the sheet or add an alias to fix it.
3. Click **Start**. Keep the ChatGPT tab visible (ideally in its own window) while it runs.

Open "message that will be sent" under any page to see exactly what will be typed.

## Script format

**One card = one page = one message = one image.** The extension accepts three shapes:

1. **The episode `.html` file** (like `S21_EP07_script.html`). Each `IMG01 — …` card becomes a page, built the same way the file's own COPY PAGE button builds it, without the VO line. The notes at the top (HP ledger, series rules, "never in this chapter", Sage, …) become the **episode brief**. Each `PART …` heading and its one-line beat become scene context.
2. **Text copied off that page** (for example "COPY THIS WHOLE PART"). Pages are split on the `IMG10 — Title` lines. The page's button labels (`COPY PAGE`, `+VO`, `COPY THIS WHOLE PART`) are dropped. Layout tags (`L3 three stacked`, `LOAD-BEARING`) stay with the page they belong to. `PART …` lines start a new part and never leak into the previous page.
3. **`=== … ===` headers**, one per page, as below.

### Two ways of sending (Settings → "How pages are sent")

- **Block (default).** For each PART:
  1. The whole part goes to ChatGPT in one message with every sheet it needs. The message says: *"Read every card now, but do NOT generate any image… reply Ready"*. A Negative line repeated on every card is stated once at the top.
  2. Then, one page at a time: *"Now create IMG20 — And One In The Mouth. Exactly ONE image for this page only…"*. It waits for the image, saves it, then asks for IMG21, and so on.
  3. Each "create" message repeats that page's exact `Window text` line so the numbers survive. It re-attaches a sheet only when it has gone stale.

  Set "Max pages per block" (e.g. 5) to split long parts like PART SEVEN (10 pages).
- **Page.** Each page's full card is sent as its own message.

In page mode, every message starts with *"Generate exactly ONE image: page NN only…"*. If a page still looks like several pages stuck together (more than one `Attach:` line), the plan shows a ⚠ and Start asks before sending it.

The **episode brief** is sent once at the start of each chat, before the first page, as a separate message that tells ChatGPT not to draw anything. You can edit the brief in the Script section.

The `Attach:` line on each page decides which sheets that page needs:

```
=== SPECIMEN 21 — EPISODE 7 … — IMG01 — The Door Is Open (page 01 of 50) ===
PAGE SPEC: …
Attach: MC sheet + FRILLRUNNER LV 6 sheet + THE STILL — LOCKED. An enormous pale …
Prompt: …
Negative: …
```

- Separate sheets with ` + ` (commas also work for short names). `Attach: none` means no sheets.
- The name is the text before ` — `, `: ` or `. `. Words like "sheet", "ref" and "LOCKED" are ignored. So `THE STILL — LOCKED. An enormous…` matches a sheet named `The Still`.
- Name matching ignores case, spaces and punctuation, and treats `LV 6`, `LV6`, `Level 6` and `lvl 6` as the same.
- Downloaded files are named `01_specimen-21-episode-7-….png` inside `Downloads/<subfolder>/`.

## When sheets get attached (Smart mode)

Each character's sheet is attached:

- on the character's first page in the current chat, and
- again once **N** images have been generated since it was last attached (N is "Re-attach a sheet after N images", default 5).

On pages where a sheet is not re-attached, the extension adds one line under the `Attach:` line: *"Reference sheets for MC, … were attached earlier in this chat — keep using them exactly."* This keeps ChatGPT anchored to the earlier upload.

To change the behaviour for one page, use the per-page dropdown: **attach all**, **attach none**, or **skip page**.

## Settings

| Setting | Default | Notes |
|---|---|---|
| Attach mode | Smart | `Always` re-uploads every page. `Never` relies on the text only. |
| Re-attach after N images | 5 | Lower it if characters start drifting. |
| Delay min/max | 5 / 10 s | Random wait between pages. |
| Image timeout | 600 s | After this long with no image, the page counts as failed. |
| Patience for text-only reply | 60 s | ChatGPT often goes quiet or blank while it reads the sheets. A reply with no image only counts as "no image" after sitting unchanged this long. Empty or shimmering replies never count. |
| Re-asks if no image | 1 | If ChatGPT answers with text or a question, it sends "please generate the image for page NN now". |
| Clicks on "Retry" | 3 | When ChatGPT shows "Something went wrong", the extension clicks ChatGPT's own Retry button instead of giving up. |
| ONE image guard / brief / scene beat / strip VO | on | See "Script format". Each can be turned off. |
| When a page fails | Pause | Or log it and skip to the next page. |
| On usage limit | Pause | Set a number of minutes to wait and retry automatically, for overnight runs. |
| New chat every N pages | 0 (off) | Long chats get slow. A fresh chat resets memory, so all sheets are re-attached. |
| New chat URL | empty | Point this at a ChatGPT Project so style instructions carry over to new chats. |

## Good to know

- **The ChatGPT page changes often.** All selectors are in one `SEL` block at the top of `extension/content.js`. If a ChatGPT update breaks sending or attaching, that block is what needs fixing.
- **Keep the tab visible.** Chrome slows timers in background tabs, so the run would crawl.
- **Usage limits still apply.** ChatGPT's image limits are the real bottleneck. The extension pauses (or waits) when it sees the limit message.
- **Terms of service.** OpenAI's terms restrict automated use of ChatGPT. Use this at your own risk and at a human pace. For fully sanctioned automation, the OpenAI Images API is the alternative, but it has no chat memory, so sheets would go with every call.

## Development

```
npm test                 # parser / planner unit tests (Node 18+)
npm i && npm run test:e2e  # loads the extension in Chromium against a fake chatgpt.com page
```

Files:

- `extension/lib/core.js`: parsing, sheet matching and attachment planning. It has no DOM code and is shared by the side panel and the content script.
- `extension/content.js`: the runner inside chatgpt.com.
- `extension/sidepanel.*`: the UI.
- `extension/background.js`: downloads and side-panel wiring.
