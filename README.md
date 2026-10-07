# Job Alert Automation — Version Guide

This repo holds a single Google Apps Script file, **`Code.gs`**, that automates job-alert triage for BCL Legal (reads Gmail alerts, classifies with Claude, writes results into a Google Sheet). The filename stays fixed across versions — version identity lives in the header comment's version number plus git history (`git log`, `git diff`, `git show <commit>:Code.gs`), not in the filename.

> Earlier on, this project renamed the file itself on every rewrite (`V17` → `V18`). That's retired: it duplicated what git already tracks for free, and made it easy to lose track of where an old version went. This doc exists to cover the versions from before that retirement; going forward, `git log` and the header comment's changelog are enough.

## v24 — current (`Code.gs`)

**v21 plus job descriptions, built afresh.** v22 and v23 were abandoned (too many problems); v24 starts again from v21, so everything else works exactly as v21 did.

**New `Job Description` column on New Leads, column H**, after Staff ID. Columns A–G are unchanged, so the CRM import mapping keeps working; add column H to it if the CRM should take the description.

**Where the descriptions come from.** They're downloaded from the job page, never written by the AI:
- **LinkedIn:** straight from LinkedIn's public job page. Free.
- **Indeed, ordinary jobs:** Indeed blocks direct downloads, so Apify's Indeed scraper fetches them (about $3 per 1,000 jobs; Apify's free plan includes $5 a month).
- **Indeed, sponsored jobs** (ad links): not fetched. Apify's Indeed scraper won't take ad links. The cell says `No description (sponsored Indeed ad)`.
- If a description can't be retrieved, the cell says `FETCH FAILED (reason)`. Nothing is ever made up.

**Which leads get one:** the leads each morning's run adds to New Leads from the emails, if found on or after **5 October 2026**. Rows already in the sheet, and anything found earlier, are left blank.

**All in one run.** The ~7:30 run adds the new leads and fills their descriptions before it finishes; the ~8:30 email is unchanged. New leads are saved before descriptions are fetched, so a description problem can never lose a lead. If Apify is slow and the run nears Google's 6-minute limit, the Apify job is stopped (so it isn't charged further) and those cells say `FETCH FAILED`.

**Tidy tab.** The description column has a fixed width, text is cut off at the edge, and every row stays one line high. The cell still holds the full description, which goes into the `.xlsx` and the CRM.

**One-time setup:** in the Apps Script editor, **Project Settings → Script Properties**, add `APIFY_TOKEN` (your token from Apify → Settings → API & Integrations). Without it, LinkedIn descriptions still work and Indeed cells say why they failed.

## v22 / v23 — abandoned (`git show a22a280:Code.gs`)

Added descriptions with a two-step 07:30/08:30 Apify process and moved Staff ID to column H. Replaced by v24.

## v21 — superseded (`git show 3c4d6d0:Code.gs`)

**Editing a list now moves jobs that are already in the sheet,** not just future ones. Every daily run starts by checking existing rows against your lists:

| You add… | What moves |
| --- | --- |
| A company to `Company Blocklist`, or a title to `Job Title Blocklist` | Its rows in `New Leads`, `Other` and `Needs Review` move to `Filtered Out`. |
| A company to `Unfilter Company` | Its rows in `Filtered Out` that the AI filtered move out, however old they are. The AI places each job's town to pick the consultant, then the job goes to `New Leads` with its Staff ID. Remote/UK-wide jobs go to `Other`, and jobs whose town can't be placed go to `Needs Review`. |
| A company to `Company Regions` | Its rows in `Other` move to `New Leads` with that region's Staff ID. Rows already in `New Leads` keep their consultant. |

- A job that moves is removed from its old tab, so each job is only ever in one tab.
- **Removing** an entry from a list doesn't move anything back. It only stops future jobs being affected.
- The blocklists still win. Unfilter never pulls out a job that was filtered by a blocklist, or one whose company or title is on a blocklist now.
- If the AI can't be reached when placing unfiltered jobs, they stay in `Filtered Out` and are tried again on the next run. Nothing gets lost.

**Don't want to wait for the morning run?** After editing a list, run `applyListsNow` in the Apps Script editor. It applies the lists straight away and doesn't fetch any new emails.

## v20 — superseded (`git show e4c7561:Code.gs`)

**New `Unfilter Company` tab.** For companies the AI filters out by mistake. If the AI filters a job from a company on this list, the job goes to New Leads as normal, with the right consultant's Staff ID. You fill the list in yourself, and matching works the same way as the blocklists: exact, ignoring case and punctuation.
- If the AI can't place the job's location, it goes to `Needs Review` instead ("Unfilter Company, but AI gave no usable region"). Remote/UK-wide jobs go to `Other`, same as any other job.
- The manual `Company Blocklist` and `Job Title Blocklist` still win. A company on both Unfilter and the blocklist stays filtered, and so does a blocklisted job title at an unfiltered company.
- Jobs the AI already filtered on an earlier run came back into New Leads on the next run, provided their email was still within the 4-day lookback, and their old `Filtered Out` row stayed as a record. (v21 replaces this: older jobs come back too, and the old row is removed.)

**Bournemouth, Poole and Christchurch → Southern Home Counties (Ray),** not South West (Josh). The AI is told this, and the script also corrects it if the AI still says South West.

**Daily schedule.** Every day, UK time:
- **~7:30:** the sheet pulls in the latest job alerts.
- **~8:30:** the workbook is emailed to `valeriiamuzhchyna@bcllegal.com` and `marklevine@bcllegal.com`. It's attached as an `.xlsx` (a snapshot for the CRM import), and the email also has a link to the live Google Sheet. Both recipients are given view access so the link opens; anyone who can already edit keeps edit access.

Google runs each one within 15 minutes either side of the set time. If the 7:30 run failed, the 8:30 email still goes out, marked "(processing error)" with a warning, so a failure can't go unnoticed.

**One-time setup, in the Apps Script editor, after pasting in `Code.gs`:**
1. Run `processJobAlerts`, then `runDailySend`. Google will ask for permission to send email the first time. Check the email arrives.
2. Run `createDailyTriggers`. This sets up the 7:30 and 8:30 runs and removes any older schedule, so it's safe to run again.
3. Run `listAllTriggers` and check there are exactly two triggers: `processJobAlerts` and `runDailySend`.

To stop the schedule, run `removeDailyTriggers`.

## v19 — superseded (`git show fc363a5:Code.gs`)

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
