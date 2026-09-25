# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A single Google Apps Script file (`Code.gs`) that automates job-alert triage for BCL Legal. It is bound to a Google Sheet, reads LinkedIn/Indeed job-alert emails from Gmail, classifies each listing with the Claude API, and writes results into a `New Leads` tab that is imported directly into the company CRM. There is no package manager, build step, linter, or test runner — this is plain Apps Script (V8 runtime) deployed by pasting the file's contents into the Apps Script editor (which names the file `Code.gs` by default) bound to the Google Sheet.

## Working with this codebase

- There is only one source file, `Code.gs`. The filename is stable across versions — do NOT rename it per version (an earlier convention renamed the file itself, e.g. `V17` → `V18`; that's retired, since it fought git's own history instead of using it). Version identity lives in exactly two places: the header comment's version number (bump it on a meaningful change) and git history/log (use `git log`, `git diff`, or `git show <commit>:Code.gs` to inspect or recover a prior version).
- The file's top-of-file comment block is a running changelog ("CHANGES FROM v18", "CHANGES FROM v17 (carried forward)", ...), keeping the two most recent entries and dropping older ones. When making a meaningful change, bump the version number in the header comment and add a new entry describing what changed and why — this is the project's in-file changelog; git history is the source of truth for anything older than what it keeps.
- There's no automated test suite. Verification happens via the diagnostic/dry-run functions defined in the file itself, run manually from the Apps Script editor against the live Gmail/Sheet data:
  - `testParseLatestEmail()` — dry run: parses the latest matching email and logs what Claude would classify (including the Staff ID a routed job would get), without writing anything. It does not apply the blocklists or Company Regions.
  - `debugIndeedLinks()` — logs raw vs. detected Indeed job links, for diagnosing link-extraction regressions.
  - `debugListSheetNames()` — logs actual sheet tab names vs. expected working tab names (catches naming/whitespace mismatches).
  - `listAllTriggers()` — lists what time-based triggers are currently installed on a given copy of the script.
- `resetAllJobData()` is a destructive utility for the live spreadsheet — don't suggest running it casually. `migrateConsultantTabsToNewLeads()` is a one-off migration (see below) meant to be run once, not on a schedule.
- Because the sheet feeds a CRM import, the New Leads column layout is effectively an external contract — adding, removing or reordering its columns affects the import, so treat it as a user decision, not a refactor.

## Architecture

**Entry point:** `processJobAlerts()` is the main daily job. It:
1. Loads reference/override sheets: `Company Blocklist`, `Job Title Blocklist` (both force-filter) and `Company Regions` (manual region overrides, see below).
2. Searches Gmail for alert emails from `CONFIG.MARK_EMAIL` within `CONFIG.LOOKBACK_DAYS`.
3. For each email, strips it down to job-relevant text via `prepareEmailForApi()` and sends it to Claude (`callClaudeForJobs()`) for classification.
4. Applies code-level overrides on top of the AI's classification (the two blocklists always win; `Company Regions` only redirects jobs the AI already called region `'Other'`).
5. Dedupes against existing sheet rows by exact link and by a normalized title/company/town key (see `normalizeJobKey()`). Dedup is permanent: there is no resurfacing window and no retention purge (both removed in v19 — recoverable from git history at commit `c51aff2` if they're wanted back).
6. Routes each job to its destination tab via `REGION_TO_TABS` (every region except `Other` goes to `New Leads`; `Other` keeps its own tab), or to `Needs Review` / `Filtered Out`. New Leads rows also get a Staff ID via `REGION_TO_STAFF_ID`.
7. Rebuilds `New Leads` in full (see below); `Other`, `Needs Review` and `Filtered Out` are append-only.

**Staff ID column (New Leads column G):** `REGION_TO_STAFF_ID` is the old v17 region → consultant mapping, but it outputs the consultant's CRM Staff ID (from `STAFF_IDS`) instead of a name. `North West` maps to Craig only; v17 also sent it to Alison, but New Leads is one row per job. `Other` has no Staff ID because those jobs go to the `Other` tab. Rows written before v19 have a blank Staff ID: no region is stored per row, so it can't be derived after the fact.

**Header/column invariants:** New Leads uses `NEW_LEADS_HEADERS` (7 columns: `TAB_HEADERS` + `Staff ID`). `Other` still uses the 6-column `TAB_HEADERS` — don't add Staff ID to `TAB_HEADERS`, or `ensureHeaders()` will insert a new header row into `Other`. Code all over the file assumes Date Found is column E (index 4) and Link is column F (index 5): dedup, sorting, date formatting, the fixed Link column width. That's why Staff ID is appended at the end rather than inserted earlier.

**`REGION_TO_TABS` maps every region to its destination tab(s):** as of v18 every region except `Other` maps to the single `New Leads` tab. `ALL_TAB_NAMES` and `REBUILD_TABS` (currently just `New Leads`) are both derived from or tied to this map — extending routing to a second rebuilt tab means adding it to `REBUILD_TABS` too.

**Job links use a placeholder scheme to avoid truncation:** `prepareEmailForApi()` never sends real URLs to Claude — it replaces each job link with a short ID (`L1`, `L2`, ...) via `linkMap`, and Claude only ever echoes the ID back. `resolveJobLink()` maps the ID back to the real URL afterward. Any change to prompt construction or email parsing must preserve this indirection.

**Three override lists sit above the AI classification**, all maintained by hand as plain sheet tabs:
- `Company Blocklist` (single column) — force-filters a company regardless of AI output.
- `Job Title Blocklist` (single column) — same, for job titles. Only checked when the company isn't already blocked, so each job is counted once. Both blocklists share `loadBlocklist()` and use `normalizeText()` exact matching: case and punctuation are ignored, but the whole value must match, so `Paralegal` does not block `Senior Paralegal`.
- `Company Regions` (Company | Region) — only fires when a job is already classified `action: 'route'` and `region: 'Other'`; redirects it to the locked-in region (and therefore that region's Staff ID) without touching the displayed `Town` value. Runs after the blocklist checks, so a blocklisted job never reaches this logic.

**`New Leads` rebuild (`rebuildNewLeadsTab()`) is a full read-clear-rewrite per run**, not an incremental append — this is what distinguishes it from `Other`'s always-append pattern (see `FLAT_TABS`). It reads back existing rows, merges in the run's new rows, dedupes by Link, sorts newest-first and rewrites the tab with a fresh header. On read-back, the header row is detected by comparing only the first 6 cells to `TAB_HEADERS`, so a pre-v19 header without Staff ID is still recognised and never carried forward as a job row. `sheet.clear()` wipes all formatting on every run, so manual formatting in New Leads does not survive.

**`migrateConsultantTabsToNewLeads()` is a one-off migration** (v17's 5 consultant tabs → v18's single `New Leads`): it pulls every job row out of `Craig`/`Alison`/`Tom`/`Josh`/`Ray`, dedupes by `Link`, pads each row with a blank Staff ID, and feeds the result through `rebuildNewLeadsTab()`. It leaves the old tabs in place — they're deleted manually once `New Leads` looks right, not by the script.

**The "Daily Run + Send" block at the bottom of the file (`DAILY_SEND_CONFIG`, `dailyRunAndSend()`, `sendSheetCopy()`, `createDailyRunAndSendTrigger()`) is deployed separately**, on *copies* of the master sheet's script, not the master itself — copying a Sheet copies its bound script but not its triggers, so each copy needs this wrapper and its own trigger. It calls `processJobAlerts()` then emails an `.xlsx` export, using a single combined trigger (not two separate ones) specifically to avoid a race where the email fires before processing finishes.

**Claude API usage:** `callClaudeForJobs()` calls `CONFIG.CLAUDE_API_URL` directly via `UrlFetchApp` (no SDK), authenticated with `CLAUDE_API_KEY` from Script Properties (Project Settings → Script Properties in the Apps Script editor — never hardcoded). Model is `CONFIG.CLAUDE_MODEL`; the prompt in `buildPrompt()` is the sole source of truth for classification rules (filtering categories, region assignment, the East Anglia/Peterborough exception, etc.) — region logic changes should generally go there rather than in post-processing code, unless they're deterministic overrides like the blocklists/Company Regions lists.
