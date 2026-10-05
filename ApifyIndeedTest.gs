/**
 * APIFY INDEED — FEASIBILITY TEST
 * ------------------------------------------------------------
 * PURPOSE: test whether Apify can get full job descriptions for the
 * Indeed jobs in the alert emails (Indeed blocks Apps Script's own
 * downloads with 401/403). Throwaway experiment — no Claude calls, no
 * routing, filtering or dedup.
 *
 * HOW IT WORKS:
 *   1. Pulls every Indeed job link from the last few days of alert
 *      emails and turns each into a clean viewjob link (by its jk ID).
 *   2. Sends them all to the Apify Indeed scraper in ONE run, waits for
 *      it to finish, and reads back the results.
 *   3. Writes one row per job to the "Apify Test" tab:
 *        Company | Location | Date | Job Description | Link
 *      Company/location come from Apify. Date is when the email arrived.
 *      Jobs Apify returned nothing for say "FETCH FAILED (...)".
 *
 * SETUP:
 *   - Project Settings > Script Properties > add APIFY_TOKEN (your
 *     Apify Personal API token: Apify > Settings > API & Integrations).
 *   - Safe alongside V17 / JobDescriptionTest: every name here is
 *     prefixed AP_/ap so nothing clashes.
 *   - Run testApifyIndeed() manually. A run usually takes 1–3 minutes.
 *   - The log prints the field names of the first Apify result — if
 *     descriptions come out blank, send those over so the field names
 *     below (AP_FIELDS) can be adjusted.
 */

const AP_CONFIG = {
  SENDER_EMAIL: 'marklevine@bcllegal.com',
  SHEET_NAME: 'Apify Test',
  LOOKBACK_DAYS: 4,
  MAX_JOBS: 10, // cap per run — Apify charges per job scraped (~$3 per 1,000)
  ACTOR_ID: 'misceres~indeed-scraper', // Apify scraper to use (owner~name, as in its API URL)
  MAX_WAIT_SECONDS: 270, // stay inside Apps Script's 6-minute limit
  MAX_DESCRIPTION_CHARS: 45000 // a Sheets cell holds 50,000 characters at most
};

const AP_HEADERS = ['Company', 'Location', 'Date', 'Job Description', 'Link'];

// Field names differ between Apify scrapers — the first one present wins.
const AP_FIELDS = {
  description: ['description', 'descriptionText', 'jobDescription', 'descriptionHTML', 'descriptionHtml'],
  company: ['company', 'companyName', 'employer'],
  location: ['location', 'jobLocation', 'formattedLocation', 'city']
};

const AP_API = 'https://api.apify.com/v2';

// ==========================================================================
// MAIN
// ==========================================================================

function testApifyIndeed() {
  const token = PropertiesService.getScriptProperties().getProperty('APIFY_TOKEN');
  if (!token) {
    Logger.log('APIFY_TOKEN not set in Script Properties. Project Settings > Script Properties > add APIFY_TOKEN.');
    return;
  }

  const jobs = apCollectIndeedJobs();
  if (!jobs.length) { Logger.log('No Indeed job links found in recent alert emails.'); return; }
  Logger.log(`Sending ${jobs.length} Indeed jobs to Apify...`);

  const result = apRunScraper(token, jobs.map(j => j.url));
  const items = result.items || [];
  Logger.log(`Apify run finished: ${result.status} — ${items.length} results back for ${jobs.length} jobs.`);
  if (items.length) {
    Logger.log(`Fields in first result: ${Object.keys(items[0]).join(', ')}`);
    Logger.log(`First result (first 1000 chars): ${JSON.stringify(items[0]).substring(0, 1000)}`);
  }

  let described = 0;
  const rows = jobs.map(job => {
    // Match results back by Indeed's job ID (jk), wherever the scraper put it.
    const item = items.find(it => JSON.stringify(it).indexOf(job.jk) !== -1);
    let description = item ? apHtmlToText(String(apField(item, 'description'))) : '';
    if (description.length > AP_CONFIG.MAX_DESCRIPTION_CHARS) {
      description = description.substring(0, AP_CONFIG.MAX_DESCRIPTION_CHARS) + ' …(truncated)';
    }
    if (description) described++;
    else description = item ? 'FETCH FAILED (Apify result had no description)' : `FETCH FAILED (${result.error || 'Apify returned nothing for this job'})`;

    return [item ? apField(item, 'company') : '', item ? apField(item, 'location') : '', job.date, description, job.url];
  });

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(AP_CONFIG.SHEET_NAME) || ss.insertSheet(AP_CONFIG.SHEET_NAME);
  sheet.clear();
  sheet.getRange(1, 1, 1, AP_HEADERS.length).setValues([AP_HEADERS]).setFontWeight('bold');
  sheet.getRange(2, 1, rows.length, AP_HEADERS.length).setValues(rows);
  sheet.getRange(2, 3, rows.length, 1).setNumberFormat('dd/mm/yyyy');
  sheet.setFrozenRows(1);
  sheet.autoResizeColumns(1, 3);
  sheet.setColumnWidth(4, 500);
  sheet.setColumnWidth(5, 150);
  sheet.getRange(1, 1, rows.length + 1, AP_HEADERS.length).setVerticalAlignment('top');
  sheet.getRange(1, 4, rows.length + 1, 1).setWrap(true);

  Logger.log(`Done. ${rows.length} jobs written — ${described} with descriptions, ${rows.length - described} without.`);
}

// ==========================================================================
// STEP 1 — Indeed links from the alert emails
// ==========================================================================

// Returns [{ jk, url, date }], one per unique Indeed job, newest emails first.
function apCollectIndeedJobs() {
  const threads = GmailApp.search(`from:${AP_CONFIG.SENDER_EMAIL} newer_than:${AP_CONFIG.LOOKBACK_DAYS}d`);
  const jobs = [];
  const seen = new Set();
  let noId = 0;

  for (const thread of threads) {
    for (const msg of thread.getMessages()) {
      const html = msg.getBody();
      if (!/indeed\.com/i.test(html)) continue;

      const hrefs = html.match(/href="[^"]*indeed\.com[^"]*"/gi) || [];
      for (const raw of hrefs) {
        if (jobs.length >= AP_CONFIG.MAX_JOBS) return jobs;
        const href = raw.slice(6, -1).replace(/&amp;/g, '&');
        if (!/(rc\/clk|pagead\/clk|viewjob)/i.test(href)) continue; // not a job link
        const jk = (href.match(/[?&]jk=([^&]+)/) || [])[1];
        if (!jk) { noId++; continue; }
        if (seen.has(jk)) continue;
        seen.add(jk);
        jobs.push({ jk: jk, url: `https://uk.indeed.com/viewjob?jk=${jk}`, date: msg.getDate() });
      }
    }
  }
  if (noId) Logger.log(`${noId} Indeed links had no job ID (jk) and were skipped.`);
  return jobs;
}

// ==========================================================================
// STEP 2 — run the Apify scraper and collect its results
// ==========================================================================

// Starts one scraper run for all URLs, waits for it, and returns
// { status, items, error }. Never throws — problems come back in error.
function apRunScraper(token, urls) {
  const start = apRequest(token, 'post', `/acts/${AP_CONFIG.ACTOR_ID}/runs`, {
    startUrls: urls.map(u => ({ url: u })),
    maxItems: urls.length
  });
  if (start.error) return { status: 'NOT STARTED', items: [], error: start.error };

  const runId = start.data.id;
  const datasetId = start.data.defaultDatasetId;
  let status = start.data.status;
  Logger.log(`Apify run ${runId} started.`);

  // waitForFinish makes Apify hold each request open for up to 45s, so this
  // only checks in a handful of times.
  const deadline = Date.now() + AP_CONFIG.MAX_WAIT_SECONDS * 1000;
  while (['READY', 'RUNNING'].indexOf(status) !== -1 && Date.now() < deadline) {
    const poll = apRequest(token, 'get', `/actor-runs/${runId}?waitForFinish=45`);
    if (poll.error) return { status: 'UNKNOWN', items: [], error: poll.error };
    status = poll.data.status;
  }

  if (status !== 'SUCCEEDED') {
    const why = ['READY', 'RUNNING'].indexOf(status) !== -1
      ? `Apify still running after ${AP_CONFIG.MAX_WAIT_SECONDS}s — check run ${runId} in the Apify console`
      : `Apify run ${status}`;
    Logger.log(why);
    // A failed or slow run may still have scraped some jobs — keep going.
    if (['READY', 'RUNNING'].indexOf(status) !== -1) return { status: status, items: [], error: why };
  }

  const items = apRequest(token, 'get', `/datasets/${datasetId}/items?clean=true&format=json`);
  if (items.error) return { status: status, items: [], error: items.error };
  return { status: status, items: Array.isArray(items.data) ? items.data : [], error: status === 'SUCCEEDED' ? '' : `Apify run ${status}` };
}

// Calls the Apify API. Returns { data } on success or { error } (logged).
// Run/dataset endpoints wrap their payload in { data: ... }; dataset items
// come back as a bare array.
function apRequest(token, method, path, payload) {
  const options = {
    method: method,
    headers: { Authorization: `Bearer ${token}` },
    muteHttpExceptions: true
  };
  if (payload) {
    options.contentType = 'application/json';
    options.payload = JSON.stringify(payload);
  }

  let response;
  try {
    response = UrlFetchApp.fetch(AP_API + path, options);
  } catch (err) {
    Logger.log(`Apify request failed (${path}): ${err}`);
    return { error: 'Apify request failed — see logs' };
  }

  const code = response.getResponseCode();
  const body = response.getContentText();
  if (code < 200 || code >= 300) {
    // 401 = bad token; 402/403 usually = out of credit or the scraper needs
    // to be enabled on your account first.
    Logger.log(`Apify returned status ${code} for ${path}: ${body.substring(0, 500)}`);
    return { error: `Apify returned status ${code} — see logs` };
  }

  try {
    const parsed = JSON.parse(body);
    return { data: Array.isArray(parsed) ? parsed : parsed.data };
  } catch (err) {
    Logger.log(`Couldn't parse Apify response for ${path}: ${err}`);
    return { error: 'Unreadable Apify response — see logs' };
  }
}

// ==========================================================================
// HELPERS
// ==========================================================================

function apField(item, kind) {
  for (const name of AP_FIELDS[kind]) {
    const value = item[name];
    if (value && typeof value === 'object') return value.text || value.name || JSON.stringify(value);
    if (value) return value;
  }
  return '';
}

// Plain-text descriptions pass through untouched apart from tidying;
// HTML ones keep their bullets and line breaks.
function apHtmlToText(html) {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n• ')
    .replace(/<\/?(p|div|td|tr|li|ul|ol|h[1-6])\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (m, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/gi, '&')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}
