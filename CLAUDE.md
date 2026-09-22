# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A single Google Apps Script file (`V18`) that automates job-alert triage for BCL Legal. It is bound to a Google Sheet, reads LinkedIn/Indeed job-alert emails from Gmail, classifies each listing with the Claude API, and writes results into a `New Leads` tab in the sheet. There is no package manager, build step, linter, or test runner — this is plain Apps Script (V8 runtime) deployed by pasting the file's contents into the Apps Script editor (Code.gs) bound to the Google Sheet.

## Working with this codebase

- There is only one source file, `V18`. Despite the lack of a `.gs`/`.js` extension, it is standard Apps Script/JS and should be edited as such. Each meaningful rewrite historically gets a new version number and the file is renamed accordingly (`V17` → `V18`, etc.) — keep the filename, the header comment's version number, and `CONFIG.CLAUDE_MODEL`'s surrounding comment in sync when doing this.
- The file's top-of-file comment block is a running changelog ("CHANGES FROM v17", "CHANGES FROM v16 (carried forward)", ...), keeping the two most recent entries and dropping older ones. When making a meaningful change, add a new entry describing what changed and why — this is the project's only changelog and future edits rely on it to understand prior tradeoffs.
- There's no automated test suite. Verification happens via the diagnostic/dry-run functions defined in the file itself, run manually from the Apps Script editor against the live Gmail/Sheet data:
  - `testParseLatestEmail()` — dry run: parses the latest matching email and logs what Claude would classify, without writing anything.
  - `debugIndeedLinks()` — logs raw vs. detected Indeed job links, for diagnosing link-extraction regressions.
  - `debugListSheetNames()` — logs actual sheet tab names vs. expected working tab names (catches naming/whitespace mismatches).
  - `listAllTriggers()` — lists what time-based triggers are currently installed on a given copy of the script.
- `resetAllJobData()` is a destructive utility for the live spreadsheet — don't suggest running it casually. `migrateConsultantTabsToNewLeads()` is a one-off migration (see below) meant to be run once, not on a schedule.

## Architecture

**Entry point:** `processJobAlerts()` is the main daily job. It:
1. Loads reference/override sheets: `Company Blocklist` (companies always filtered) and `Company Regions` (manual region overrides, see below).
2. Searches Gmail for alert emails from `CONFIG.MARK_EMAIL` within `CONFIG.LOOKBACK_DAYS`.
3. For each email, strips it down to job-relevant text via `prepareEmailForApi()` and sends it to Claude (`callClaudeForJobs()`) for classification.
4. Applies code-level overrides on top of the AI's classification (blocklist always wins; `Company Regions` only redirects jobs the AI already called region `'Other'`).
5. Dedupes against existing sheet rows (by exact link and by a normalized title/company/town key — see `normalizeJobKey()`), with resurfacing logic for jobs reappearing after `RESURFACE_WINDOW_DAYS`.
6. Routes each job to its destination tab via `REGION_TO_TABS` (every region except `Other` goes to `New Leads`; `Other` keeps its own tab), or to `Needs Review` / `Filtered Out`.
7. Rebuilds `New Leads` and purges rows older than `PURGE_WINDOW_DAYS` (84 days) — this purge runs unconditionally every run, not just when the tab receives new data, which is why `New Leads` is always rebuilt rather than only rebuilt when touched.

**`REGION_TO_TABS` maps every region to its destination tab(s):** as of v18 every region except `Other` maps to the single `New Leads` tab (previously this fanned out across 5 per-consultant tabs, with `North West` going to both `Craig` and `Alison` — that fan-out, and the resulting double-write, no longer exists). `New Leads` carries no Region or Consultant column; it's a flat list sorted by Date Found, newest first. `ALL_TAB_NAMES` and `REBUILD_TABS` (currently just `New Leads`) are both derived from this map — extending routing to a second rebuilt tab means adding it to `REBUILD_TABS` too.

**Job links use a placeholder scheme to avoid truncation:** `prepareEmailForApi()` never sends real URLs to Claude — it replaces each job link with a short ID (`L1`, `L2`, ...) via `linkMap`, and Claude only ever echoes the ID back. `resolveJobLink()` maps the ID back to the real URL afterward. Any change to prompt construction or email parsing must preserve this indirection.

**Two override lists sit above the AI classification**, both maintained as plain sheet tabs and exempt from the 84-day purge (they're standing reference data, not job data):
- `Company Blocklist` (single column) — force-filters a company regardless of AI output.
- `Company Regions` (Company | Region) — only fires when a job is already classified `action: 'route'` and `region: 'Other'`; redirects it to the locked-in region without touching the displayed `Town` value. Runs after the blocklist check, so a blocklisted company never reaches this logic.

**`New Leads` rebuild (`rebuildNewLeadsTab()`) is a full read-clear-rewrite per run**, not an incremental append — this is what distinguishes it from `Other`'s simpler always-append-then-purge pattern (see `FLAT_TABS`). It reads back existing rows first to: carry forward high-priority formatting (`HIGH_PRIORITY_BG`) for previously-flagged resurfaced jobs, drop rows superseded by a resurfaced link (`staleLinks`), and drop expired rows (purge). Since there are no region sections, the only special row to detect on read-back is the repeated header row itself (exact match against `TAB_HEADERS`); every other row with a `Link` is real job data.

**`migrateConsultantTabsToNewLeads()` is a one-off migration** (v17's 5 consultant tabs → v18's single `New Leads`): it pulls every job row out of `Craig`/`Alison`/`Tom`/`Josh`/`Ray`, dedupes by `Link` (a `North West` job used to live in both `Craig`'s and `Alison`'s tab), and feeds the result through `rebuildNewLeadsTab()`. It leaves the old tabs in place — they're deleted manually once `New Leads` looks right, not by the script.

**The "Daily Run + Send" block at the bottom of the file (`DAILY_SEND_CONFIG`, `dailyRunAndSend()`, `sendSheetCopy()`, `createDailyRunAndSendTrigger()`) is deployed separately**, on *copies* of the master sheet's script, not the master itself — copying a Sheet copies its bound script but not its triggers, so each copy needs this wrapper and its own trigger. It calls `processJobAlerts()` then emails an `.xlsx` export, using a single combined trigger (not two separate ones) specifically to avoid a race where the email fires before processing finishes.

**Claude API usage:** `callClaudeForJobs()` calls `CONFIG.CLAUDE_API_URL` directly via `UrlFetchApp` (no SDK), authenticated with `CLAUDE_API_KEY` from Script Properties (Project Settings → Script Properties in the Apps Script editor — never hardcoded). Model is `CONFIG.CLAUDE_MODEL`; the prompt in `buildPrompt()` is the sole source of truth for classification rules (filtering categories, region assignment, the East Anglia/Peterborough exception, etc.) — region logic changes should generally go there rather than in post-processing code, unless they're deterministic overrides like the blocklist/Company Regions lists.
