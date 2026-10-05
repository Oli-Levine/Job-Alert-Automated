# Job description retrieval: handoff summary

Findings from testing ways to add a **full job description** column to the job alert sheet. Reference code is on branch `claude/job-description-extraction-test-9hdi5o` of `oli-levine/job-alert-automated`:
- `JobDescriptionTest.gs`: LinkedIn route (plus earlier Indeed attempts)
- `ApifyIndeedTest.gs`: Indeed route via Apify

Both files are standalone Google Apps Script, with names prefixed `jd` / `ap` so they don't clash with the main script.

## Status

| Source | Method | Status |
|---|---|---|
| LinkedIn | Apps Script downloads LinkedIn's public guest job page | **Working**, confirmed on real alert emails |
| Indeed | Apify scraper (`misceres~indeed-scraper`) | **Built, not yet confirmed on a real run** |

## What does NOT work (don't retry these)
- **Claude API `web_fetch` tool on LinkedIn:** returns `url_not_allowed` / `url_not_accessible`. LinkedIn is blocked for Claude's fetcher.
- **Indeed's own email alerts:** they contain no description snippet, so asking Claude to summarise from the email gives nothing.
- **`UrlFetchApp` on Indeed `viewjob` pages:** Indeed returns **401/403** to Google's servers. Spoofing request headers won't get past this.
- **Claude `web_search` to find the same job elsewhere:** works technically, but the user rejected it (wrong matches, partial descriptions).

## LinkedIn: how it works (working)
1. Take the job link from the alert email and pull out the numeric job ID from the `/jobs/view/<id>` path. `/comm/jobs/view/<id>` links work the same way. Strip the query string.
2. `UrlFetchApp.fetch('https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/<id>', { muteHttpExceptions: true, followRedirects: true })`. No login and no Claude call are needed.
3. The description is inside the `<div>` whose class contains **`show-more-less-html__markup`**. Extract that div's inner HTML while **counting nested `<div>`s** (a simple non-greedy regex cuts it short). If the marker is missing, it's probably a block page.
4. Convert the HTML to text, keeping the formatting: `<li>` becomes `\n• `, opening and closing block tags (p, div, ul, ol, h1–h6, li, tr, td) become newlines, `<br>` becomes a newline. Then strip the remaining tags, decode entities (`&nbsp; &lt; &gt; &quot; &#NN; &#xNN; &amp;`, with `&amp;` last) and collapse blank lines.
5. Cap at **45,000 characters**, because a Google Sheets cell holds 50,000 at most.
6. On a non-200 response, write `FETCH FAILED (LinkedIn returned status <code>)` instead of guessing.

## Indeed: how it works (via Apify, unconfirmed)
1. Collect the Indeed job links from the alert email (`rc/clk`, `pagead/clk` or `viewjob`) and take the **`jk`** parameter. De-duplicate by `jk`, and skip links that have no `jk`. Build `https://uk.indeed.com/viewjob?jk=<jk>`.
2. Send **all** of a run's Indeed URLs to Apify in **one** scraper run, which is cheaper and faster than one run per job:
   - `POST https://api.apify.com/v2/acts/misceres~indeed-scraper/runs`
   - Header: `Authorization: Bearer <APIFY_TOKEN>`
   - Body: `{"startUrls":[{"url":"..."}], "maxItems": N}`
   - The response gives `data.id` (run ID) and `data.defaultDatasetId`.
3. Poll `GET /v2/actor-runs/<runId>?waitForFinish=45` until the status is no longer `READY`/`RUNNING`. Each call waits up to 45 seconds, which stays under UrlFetchApp's ~60-second limit. Stop waiting at around 270 seconds total, to stay within Apps Script's 6-minute run limit. A run usually takes 1–3 minutes.
4. `GET /v2/datasets/<datasetId>/items?clean=true&format=json` returns a bare JSON array.
5. Match each result back to its job by searching the stringified result for the job's `jk`, because the field holding it varies.
6. Field names vary between scrapers, so take the first one present:
   - description: `description`, `descriptionText`, `jobDescription`, `descriptionHTML`
   - company: `company`, `companyName`
   - location: `location`, `jobLocation`, `formattedLocation`

   Run the description through the same HTML-to-text step as LinkedIn.
7. Errors: **401** means a bad token. **402/403** usually means out of credit, or the scraper hasn't been added to the account yet (click "Try for free" on its Apify page). A job with no matching result gets `FETCH FAILED (...)`.

**Run order in the daily job:** start the Apify run *before* doing LinkedIn downloads and Claude parsing, then collect its results at the end. That way the 1–3 minute wait overlaps with other work.

## Setup and secrets
- Script Properties: `CLAUDE_API_KEY` (existing) and `APIFY_TOKEN` (Apify → Settings → API & Integrations). Never put either in code.
- Apify cost: around $3 per 1,000 Indeed jobs. The free plan includes about $5 of usage a month, which should cover the expected 300–900 Indeed jobs a month.
- LinkedIn costs nothing beyond the existing email parsing.

## Things to be aware of
- LinkedIn's and Indeed's terms of service prohibit scraping. Volume is low, but the user has accepted this.
- Both routes can break if LinkedIn or Indeed change their page structure, or if the Apify scraper's developer changes its output. Keep the "write `FETCH FAILED (reason)`, never guess" behaviour so breakages are visible in the sheet.
- On the first real Apify run, check that descriptions come through. The test script logs the first result's field names (`Fields in first result:`) for this purpose.
