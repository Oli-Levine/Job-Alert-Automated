# Job Alert Automation — Version Guide

This repo holds a single Google Apps Script file, **`Code.gs`**, that automates job-alert triage for BCL Legal (reads Gmail alerts, classifies with Claude, writes results into a Google Sheet). The filename stays fixed across versions — version identity lives in the header comment's version number plus git history (`git log`, `git diff`, `git show <commit>:Code.gs`), not in the filename.

> Earlier on, this project renamed the file itself on every rewrite (`V17` → `V18`). That's retired: it duplicated what git already tracks for free, and made it easy to lose track of where an old version went. This doc exists to cover the versions from before that retirement; going forward, `git log` and the header comment's changelog are enough.

## v19 — current (`Code.gs`)

The sheet's end goal is now a **direct import into the company CRM**.

**New `Staff ID` column on New Leads (column G, after Link).** Filled using the old v17 region → consultant mapping, but it outputs the consultant's CRM Staff ID instead of their name:

| Region(s) | Consultant | Staff ID |
| --- | --- | --- |
| Scotland, North West | Craig Wilson | `TI174EJE010620110002` |
| Ireland | Alison McKee | `TI0W4STT300120180003` |
| North East, Yorkshire | Tom Shaw | `TI0W0UTT300120180002` |
| West Midlands, East Midlands, South West | Josh Mcconnell | `TI19FWLD10052021001G` |
| London, Northern Home Counties, Southern Home Counties, East Anglia | Ray Birkett | `TI19OTTT110820230060` |

North West goes to Craig only (v17 sent it to Craig *and* Alison). Rows that were already in New Leads before v19 keep a blank Staff ID. The `Other` tab has no Staff ID column.

**New `Job Title Blocklist` tab.** Works exactly like `Company Blocklist`, but for job titles, and you fill it in yourself. It uses exact matching with case and punctuation ignored, so listing `Paralegal` blocks "paralegal" and "Paralegal." but **not** "Senior Paralegal". List each variant you want blocked. Blocked jobs go to `Filtered Out` with the reason "Job title on blocklist". The tab is created automatically, with a `Job Title` header, on the first run.

**Removed (for now):**
- The 30-day resurfacing / high-priority (amber) flag. A job already in New Leads is always treated as a duplicate, however long ago it was first seen. Existing amber rows lose their highlight on the first v19 run.
- The 84-day retention purge, on every tab. Nothing is deleted automatically any more.

Both removals can be brought back from git history (`git show c51aff2:Code.gs` is v18).

**Unchanged:** `Company Blocklist`, `Company Regions`, `Needs Review`, `Filtered Out`, `Other`.

## v18 — superseded (`git show c51aff2:Code.gs`)

**Output structure:** one flat `New Leads` tab replaces the 5 per-consultant tabs from v17. Every routable job writes exactly one row — no Consultant column, no Region column, no section headings — sorted by Date Found, newest first.

**What carried over from v17, now against the single tab instead of 5:**
- Dedup by exact link and by normalized title+company+town key
- Resurfacing: a job reappearing after 30+ days (`RESURFACE_WINDOW_DAYS`) gets bolded with an amber background, and the flag survives future rebuilds
- 84-day retention purge (`PURGE_WINDOW_DAYS`), run unconditionally on every execution

**Unchanged from v17:** `Company Blocklist`, `Company Regions`, `Needs Review`, `Filtered Out`, and `Other` — same schema, same logic.

**Added in v18:** `migrateConsultantTabsToNewLeads()` — a one-off function to run once after deploying v18. It pulls every job row out of the old `Craig`/`Alison`/`Tom`/`Josh`/`Ray` tabs, dedupes by link (a `North West` job used to live in both `Craig`'s and `Alison`'s tab — this collapses it to one row), and feeds the result into `New Leads`. It leaves the old tabs in place; delete them by hand once `New Leads` looks right.

## v17 — superseded (recoverable from git history only)

v17 isn't a file in the working tree — it predates the file being renamed to `Code.gs`, and its own filename (`V17`) was retired along with the rest of that convention. Its exact contents are still recoverable:

```
git show d4327d7:V17
```

**What v17 was:** job leads routed into 5 separate consultant tabs (`Craig`, `Alison`, `Tom`, `Josh`, `Ray`), each internally sectioned into region headings. `REGION_TO_TABS` fanned some regions out to two tabs at once — e.g. `North West` wrote a row to *both* `Craig` and `Alison`.

**Added in v17 (over v16):** the `Company Regions` override tab — a manually maintained `Company | Region` list that redirects a job the AI classified as region `Other` to a locked-in region, without touching the displayed `Town` value.

**Carried into v17 from v15:** the 84-day data retention purge, with `Company Blocklist` explicitly exempt from it, and consultant tabs always rebuilding every run (not just when touched) so the purge actually runs daily.

## How to tell which version is live

Check `Code.gs`'s header comment (`JOB ALERT AUTOMATION v__`) — that's the version in this repo. Whatever is pasted into the Apps Script editor bound to the live Google Sheet is the version actually *running*; check its header comment the same way if you're ever unsure whether the sheet has caught up with this repo. For any older version, `git log` and `git show <commit>:<filename>` are how you look it up — there's no separate file on disk for it.

See `CLAUDE.md` for the full architecture writeup of the current version.
