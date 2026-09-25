# Job Alert Automation — Version Guide

This repo holds a single Google Apps Script file that automates job-alert triage for BCL Legal (reads Gmail alerts, classifies with Claude, writes results into a Google Sheet). Each meaningful rewrite gets a new version number, and the **filename itself is renamed to match** (`V17` → `V18`, and so on) rather than keeping every version side by side. That means only the *current* version's file exists in the working tree at any time — this doc is here so you can tell what changed between versions without having to dig through `git log`.

## V18 — current (`V18`)

**Output structure:** one flat `New Leads` tab replaces the 5 per-consultant tabs from v17. Every routable job writes exactly one row — no Consultant column, no Region column, no section headings — sorted by Date Found, newest first.

**What carried over from v17, now against the single tab instead of 5:**
- Dedup by exact link and by normalized title+company+town key
- Resurfacing: a job reappearing after 30+ days (`RESURFACE_WINDOW_DAYS`) gets bolded with an amber background, and the flag survives future rebuilds
- 84-day retention purge (`PURGE_WINDOW_DAYS`), run unconditionally on every execution

**Unchanged from v17:** `Company Blocklist`, `Company Regions`, `Needs Review`, `Filtered Out`, and `Other` — same schema, same logic.

**New in v18:** `migrateConsultantTabsToNewLeads()` — a one-off function to run once after deploying v18. It pulls every job row out of the old `Craig`/`Alison`/`Tom`/`Josh`/`Ray` tabs, dedupes by link (a `North West` job used to live in both `Craig`'s and `Alison`'s tab — this collapses it to one row), and feeds the result into `New Leads`. It leaves the old tabs in place; delete them by hand once `New Leads` looks right.

## V17 — superseded (no longer a file in this repo)

V17's code isn't in the working tree anymore — renaming to `V18` replaced it. Its exact contents are still recoverable from git history:

```
git show d4327d7:V17
```

**What V17 was:** job leads routed into 5 separate consultant tabs (`Craig`, `Alison`, `Tom`, `Josh`, `Ray`), each internally sectioned into region headings. `REGION_TO_TABS` fanned some regions out to two tabs at once — e.g. `North West` wrote a row to *both* `Craig` and `Alison`.

**Added in v17 (over v16):** the `Company Regions` override tab — a manually maintained `Company | Region` list that redirects a job the AI classified as region `Other` to a locked-in region, without touching the displayed `Town` value.

**Carried into v17 from v15:** the 84-day data retention purge, with `Company Blocklist` explicitly exempt from it, and consultant tabs always rebuilding every run (not just when touched) so the purge actually runs daily.

## How to tell which version is live

The version number lives in two places that should always agree: the filename (`V18`) and the first line of the file's header comment (`JOB ALERT AUTOMATION v18`). Whatever is pasted into the Apps Script editor bound to the live Google Sheet is the version actually running — check its header comment if you're ever unsure whether the sheet has caught up with this repo.

See `CLAUDE.md` for the full architecture writeup of the current version.
