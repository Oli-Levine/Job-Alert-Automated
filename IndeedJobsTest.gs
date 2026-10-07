/**
 * INDEED JOBS TEST — a standalone test, not part of the daily run.
 * ------------------------------------------------------------
 * STEP 1: ijLoadJobs() reads the Indeed alert emails and lists the jobs in an
 * "Indeed Jobs" tab, at most IJ_CONFIG.MAX_JOBS per run. No AI, no Apify,
 * so it costs nothing.
 * STEP 2: ijFetchDescriptions() sends the tab's jobs to Apify
 * (misceres~indeed-scraper) and fills Job Description / Description Status.
 * Two Apify runs, started together:
 *   - Jobs with a job ID (ordinary ones) go to misceres~indeed-scraper as the
 *     clean job link, matched back by job ID. Confirmed working.
 *   - Sponsored jobs (no job ID) go to a real browser (apify~web-scraper,
 *     UK residential proxy) that opens the ad link as it is in the email,
 *     follows it to the job page and reads the description there. The Indeed
 *     scraper itself fails whole runs given ad links, so it's not used for them.
 *     If the browser only gets the job ID, that's saved on the row and the next
 *     ijFetchDescriptions() fetches it like an ordinary job.
 * The execution log shows each run's outcome (for the browser: where each ad
 * link landed), and, for a failed run, the end of Apify's own log for it.
 *
 * Use it in a test Google Sheet: Extensions > Apps Script, paste this in as
 * its own file, add Script Property APIFY_TOKEN (Project Settings), then:
 *   ijLoadJobs()          — adds up to 10 new jobs from the emails (free).
 *   ijCountJobs()         — logs ordinary vs sponsored counts for every Indeed
 *                           email in the window, no cap (free, writes nothing).
 *                           ijCountJobs14Days() does the same for 14 days.
 *   ijFetchDescriptions() — fills descriptions for rows with none yet (or a
 *                           FETCH FAILED), waiting up to 4 minutes for Apify.
 *   ijCollect()           — picks up runs that hadn't finished in time.
 *   ijResetDescriptions() — blanks the description columns, to test again.
 */

const IJ_CONFIG = {
  ALERT_SENDER: 'marklevine@bcllegal.com', // same as CONFIG.MARK_EMAIL in Code.gs
  EMAIL_DAYS: 4,      // how far back to look, like the daily run
  MAX_JOBS: 10,       // most jobs added (and sent to Apify) per run, to keep tests quick and cheap
  TAB: 'Indeed Jobs',
  APIFY_API: 'https://api.apify.com/v2',
  APIFY_ACTOR: 'misceres~indeed-scraper',
  BROWSER_ACTOR: 'apify~web-scraper',
  BROWSER_MEMORY_MB: 2048,
  // UK home-broadband IPs look like a normal visitor; Indeed blocks data-centre IPs.
  // If Apify says the RESIDENTIAL group isn't available on the plan, use { useApifyProxy: true }.
  BROWSER_PROXY: { useApifyProxy: true, apifyProxyGroups: ['RESIDENTIAL'], apifyProxyCountry: 'GB' },
  RUN_TIMEOUT_SECS: 600, // Apify stops (and stops charging for) a run after this
  WAIT_SECS: 240,        // how long ijFetchDescriptions() waits; Apps Script stops a run at 6 minutes
  MAX_CHARS: 45000       // a Sheets cell holds 50,000 characters
};
const IJ_RUNS_KEY = 'IJ_APIFY_RUNS'; // Script Property: Apify runs not yet collected
const IJ_PENDING = 'PENDING (waiting for Apify)';
const IJ_FAILED = 'FETCH FAILED';
// Apify's field names vary between scraper versions; the first one present wins.
const IJ_DESCRIPTION_FIELDS = ['description', 'descriptionText', 'jobDescription', 'descriptionHTML', 'descriptionHtml'];

// Column layout. Step 2 fills DESCRIPTION and DESC_STATUS.
const IJ_HEADERS = ['Email Date', 'Job Title', 'Details (from email)', 'Link Type', 'Job ID', 'Link', 'Job Description', 'Description Status'];
const IJ_COL = { DATE: 0, TITLE: 1, DETAILS: 2, TYPE: 3, JOB_ID: 4, LINK: 5, DESCRIPTION: 6, DESC_STATUS: 7 };

// Indeed job links in the alert emails: rc/clk (ordinary, has jk=), pagead/clk (sponsored ad, no jk), viewjob.
const IJ_JOB_LINK = /indeed\.com\/(rc\/clk|pagead\/clk|viewjob)/i;

// ==========================================================================
// STEP 1 — jobs from the emails
// ==========================================================================

function ijLoadJobs() {
  const sheet = ijSheet();
  const known = new Set(ijRows(sheet).map(r => String(r[IJ_COL.LINK])));
  const messages = [];
  GmailApp.search(`from:${IJ_CONFIG.ALERT_SENDER} newer_than:${IJ_CONFIG.EMAIL_DAYS}d`)
    .forEach(t => t.getMessages().forEach(m => messages.push(m)));
  messages.sort((a, b) => b.getDate() - a.getDate()); // newest emails first

  const added = [];
  let indeedEmails = 0, found = 0;
  for (const msg of messages) {
    const html = msg.getBody();
    if (!ijIsIndeedEmail(html)) continue;
    indeedEmails++;
    const jobs = ijJobsInEmail(html);
    found += jobs.length;
    Logger.log(`Email ${msg.getDate().toLocaleString('en-GB')} "${msg.getSubject()}": ${jobs.length} job(s).`);
    for (const job of jobs) {
      if (added.length >= IJ_CONFIG.MAX_JOBS) break;
      if (known.has(job.link)) continue;
      known.add(job.link);
      const row = new Array(IJ_HEADERS.length).fill('');
      row[IJ_COL.DATE] = msg.getDate();
      row[IJ_COL.TITLE] = job.title;
      row[IJ_COL.DETAILS] = job.details;
      row[IJ_COL.TYPE] = job.jobId ? 'Ordinary' : 'Sponsored';
      row[IJ_COL.JOB_ID] = job.jobId || '';
      row[IJ_COL.LINK] = job.link;
      added.push(row);
    }
    if (added.length >= IJ_CONFIG.MAX_JOBS) break;
  }

  if (added.length) sheet.getRange(sheet.getLastRow() + 1, 1, added.length, IJ_HEADERS.length).setValues(added);
  const sponsored = added.filter(r => r[IJ_COL.TYPE] === 'Sponsored').length;
  Logger.log(`${messages.length} email(s) from ${IJ_CONFIG.ALERT_SENDER} in the last ${IJ_CONFIG.EMAIL_DAYS} days, `
    + `${indeedEmails} of them Indeed, with ${found} job link(s) in all.`);
  Logger.log(`Added ${added.length} job(s) to "${IJ_CONFIG.TAB}" (${added.length - sponsored} ordinary, ${sponsored} sponsored; cap ${IJ_CONFIG.MAX_JOBS}).`);
}

// Counts ordinary vs sponsored jobs in every Indeed email of the last `days`
// days (default EMAIL_DAYS), with no cap. Only logs; writes nothing, no Apify.
function ijCountJobs(days) {
  days = Number(days) || IJ_CONFIG.EMAIL_DAYS;
  const messages = [];
  GmailApp.search(`from:${IJ_CONFIG.ALERT_SENDER} newer_than:${days}d`)
    .forEach(t => t.getMessages().forEach(m => messages.push(m)));
  messages.sort((a, b) => b.getDate() - a.getDate());
  const pct = (n, of) => (of ? Math.round(100 * n / of) : 0) + '%';
  let emails = 0, total = 0, sponsored = 0;
  messages.forEach(msg => {
    const html = msg.getBody();
    if (!ijIsIndeedEmail(html)) return;
    const jobs = ijJobsInEmail(html);
    const s = jobs.filter(j => !j.jobId).length;
    emails++; total += jobs.length; sponsored += s;
    Logger.log(`${msg.getDate().toLocaleString('en-GB')} "${msg.getSubject()}": ${jobs.length} job(s), `
      + `${jobs.length - s} ordinary, ${s} sponsored (${pct(s, jobs.length)}).`);
  });
  Logger.log(`TOTAL over the last ${days} days: ${emails} Indeed email(s), ${total} job(s): `
    + `${total - sponsored} ordinary, ${sponsored} sponsored (${pct(sponsored, total)} sponsored).`);
}

// The editor's Run button can't pass a number, so this gives a bigger sample.
function ijCountJobs14Days() {
  ijCountJobs(14);
}

function ijIsIndeedEmail(html) {
  return /indeed\.com/i.test(html) && !(/linkedin\.com/i.test(html) && /job alert/i.test(html));
}

// The jobs in one email, in order: [{ title, details, jobId, link }].
// A job usually has several links (title, logo, button) to the same address;
// the title is the longest link text. Details is the email text between this
// job and the next one (company, town, salary...).
function ijJobsInEmail(html) {
  html = html.replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<script[\s\S]*?<\/script>/gi, '');
  const jobs = new Map(); // link -> job
  for (const m of html.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
    const href = ijDecode(m[1]);
    if (!IJ_JOB_LINK.test(href)) continue;
    const jobId = ijJobId(href);
    const link = jobId ? `https://uk.indeed.com/viewjob?jk=${jobId}` : href;
    const text = ijText(m[2]);
    const job = jobs.get(link);
    if (!job) jobs.set(link, { title: text, jobId: jobId, link: link, start: m.index, end: m.index + m[0].length });
    else if (text.length > job.title.length) job.title = text;
  }
  const list = [...jobs.values()];
  list.forEach((job, i) => {
    const next = list[i + 1] ? list[i + 1].start : job.end + 1500;
    let details = ijText(html.substring(job.end, next));
    if (job.title && details.startsWith(job.title)) details = details.substring(job.title.length).trim();
    job.details = details.substring(0, 300);
  });
  return list.map(j => ({ title: j.title, details: j.details, jobId: j.jobId, link: j.link }));
}

// ==========================================================================
// STEP 2 — descriptions via Apify
// ==========================================================================

// Ordinary jobs, and sponsored ones whose job ID is already known, go to the
// Indeed scraper by job ID. Sponsored jobs with no job ID yet go to a browser
// run that follows the ad link. Both runs are started together.
function ijFetchDescriptions() {
  const token = ijToken();
  if (!token) return;
  const sheet = ijSheet();
  const todo = ijRows(sheet)
    .map((r, i) => ({ r: r, i: i }))
    .filter(x => !x.r[IJ_COL.DESCRIPTION] && (!x.r[IJ_COL.DESC_STATUS] || String(x.r[IJ_COL.DESC_STATUS]).startsWith(IJ_FAILED)))
    .slice(0, IJ_CONFIG.MAX_JOBS);
  if (!todo.length) { Logger.log('No rows need a description. (ijResetDescriptions() blanks them to test again.)'); return; }

  const byId = todo.filter(x => x.r[IJ_COL.JOB_ID]);
  const byBrowser = todo.filter(x => !x.r[IJ_COL.JOB_ID]);
  if (byId.length) {
    const urls = [...new Set(byId.map(x => ijViewUrl(x.r[IJ_COL.JOB_ID])))];
    ijStartRun(token, sheet, byId, 'id', 'Indeed scraper (by job ID)', IJ_CONFIG.APIFY_ACTOR, '', {
      startUrls: urls.map(u => ({ url: u })),
      maxItems: urls.length
    });
  }
  if (byBrowser.length) {
    const links = [...new Set(byBrowser.map(x => String(x.r[IJ_COL.LINK])))];
    ijStartRun(token, sheet, byBrowser, 'browser', 'Browser (sponsored ad links)', IJ_CONFIG.BROWSER_ACTOR, `&memory=${IJ_CONFIG.BROWSER_MEMORY_MB}`, {
      startUrls: links.map(u => ({ url: u, userData: { link: u } })),
      pageFunction: IJ_PAGE_FUNCTION,
      proxyConfiguration: IJ_CONFIG.BROWSER_PROXY,
      injectJQuery: false,
      waitUntil: ['domcontentloaded'],
      maxRequestRetries: 2,
      maxPagesPerCrawl: links.length,
      pageLoadTimeoutSecs: 60
    });
  }
  ijCollect(IJ_CONFIG.WAIT_SECS);
}

// Runs inside Apify's browser on the page the ad link ends up on: waits up to
// 15s for Indeed's description box, then reports where it landed, the job ID
// (from the address or the page's canonical link) and the description text.
const IJ_PAGE_FUNCTION = `async function pageFunction(context) {
  let description = null;
  for (let i = 0; i < 30 && !description; i++) {
    const el = document.querySelector('#jobDescriptionText');
    if (el && el.innerText.trim()) description = el.innerText.trim();
    else await new Promise(r => setTimeout(r, 500));
  }
  const canonical = document.querySelector('link[rel="canonical"]');
  const jk = s => { const m = String(s || '').match(/[?&]v?jk=([0-9a-f]{16})/i); return m ? m[1] : null; };
  return {
    link: context.request.userData.link,
    finalUrl: window.location.href,
    jobId: jk(window.location.href) || jk(canonical && canonical.href),
    pageTitle: document.title,
    description: description
  };
}`;

function ijStartRun(token, sheet, group, kind, label, actor, extraQuery, input) {
  const res = ijApify(token, 'post', `/acts/${actor}/runs?timeout=${IJ_CONFIG.RUN_TIMEOUT_SECS}${extraQuery}`, input);
  if (res.error) {
    Logger.log(`${label}: couldn't start Apify: ${res.error}`);
    group.forEach(x => ijSet(sheet, x.i, IJ_COL.DESC_STATUS, `${IJ_FAILED} (couldn't start Apify: ${res.error})`));
    return;
  }
  group.forEach(x => ijSet(sheet, x.i, IJ_COL.DESC_STATUS, IJ_PENDING));
  const runs = ijLoadRuns();
  runs.push({ kind: kind, label: label, runId: res.data.id, datasetId: res.data.defaultDatasetId, links: group.map(x => String(x.r[IJ_COL.LINK])) });
  ijSaveRuns(runs);
  Logger.log(`${label}: Apify run started for ${group.length} job(s): ${ijRunLink(res.data.id)}`);
}

// Writes the results of every finished run into its PENDING rows. Runs still
// going after waitSecs (default: no wait) are kept for the next ijCollect().
function ijCollect(waitSecs) {
  const token = ijToken();
  if (!token) return;
  const sheet = ijSheet();
  const deadline = Date.now() + (Number(waitSecs) || 0) * 1000;
  const stillGoing = [];

  ijLoadRuns().forEach(run => {
    const label = run.label || run.type;
    const info = ijWaitForRun(token, run.runId, deadline);
    if (!info) { stillGoing.push(run); Logger.log(`${label}: run still going; run ijCollect() in a few minutes. ${ijRunLink(run.runId)}`); return; }
    if (info.error) { stillGoing.push(run); Logger.log(`${label}: couldn't check the run: ${info.error}`); return; }

    const res = ijApify(token, 'get', `/datasets/${run.datasetId}/items?clean=true&format=json`);
    const items = Array.isArray(res.data) ? res.data : [];
    Logger.log(`${label}: run ${info.status}${info.statusMessage ? ` (${info.statusMessage})` : ''}, ${items.length} result(s). ${ijRunLink(run.runId)}`);
    if (run.kind === 'browser') items.forEach(it => Logger.log(`${label}: ${it.link}\n  landed on: ${it.finalUrl}\n  page title: "${it.pageTitle}", job ID: ${it.jobId || 'none'}, description: ${it.description ? it.description.length + ' chars' : 'none'}`));
    else if (items.length) Logger.log(`${label}: first result: ${JSON.stringify(items[0]).substring(0, 1500)}`);
    if (info.status !== 'SUCCEEDED') Logger.log(`${label}: end of Apify's own log for this run:\n${ijRunLog(token, run.runId)}`);
    const runNote = info.status === 'SUCCEEDED' ? '' : `; Apify run ${info.status}${info.statusMessage ? `: ${info.statusMessage}` : ''}`;
    const links = new Set(run.links || []);

    ijRows(sheet).forEach((r, i) => {
      if (r[IJ_COL.DESC_STATUS] !== IJ_PENDING || (run.links && !links.has(String(r[IJ_COL.LINK])))) return;
      if (res.error) { ijSet(sheet, i, IJ_COL.DESC_STATUS, `${IJ_FAILED} (couldn't read Apify's results: ${res.error})`); return; }
      if (run.kind === 'browser') ijWriteBrowserResult(sheet, i, items.find(it => it.link === String(r[IJ_COL.LINK])), items.length, runNote);
      else ijWriteScraperResult(sheet, i, items.find(it => JSON.stringify(it).indexOf(r[IJ_COL.JOB_ID]) !== -1), items.length, runNote);
    });
  });

  ijSaveRuns(stillGoing);
  Logger.log(`Done${stillGoing.length ? `; ${stillGoing.length} run(s) still going` : ''}. See the "${IJ_CONFIG.TAB}" tab.`);
}

function ijWriteScraperResult(sheet, i, item, count, runNote) {
  if (!item) { ijSet(sheet, i, IJ_COL.DESC_STATUS, `${IJ_FAILED} (no result for this job; ${count} result(s) in the run${runNote})`); return; }
  const field = IJ_DESCRIPTION_FIELDS.find(f => item[f]);
  const value = field ? item[field] : '';
  ijWriteDescription(sheet, i, ijDescriptionText(typeof value === 'object' ? (value.html || value.text || JSON.stringify(value)) : value), 'Indeed scraper, matched by job ID');
}

// A browser result can give the description, or just the job ID — which is
// then saved on the row, so the next ijFetchDescriptions() sends it to the
// Indeed scraper by job ID like an ordinary job.
function ijWriteBrowserResult(sheet, i, item, count, runNote) {
  if (!item) { ijSet(sheet, i, IJ_COL.DESC_STATUS, `${IJ_FAILED} (browser couldn't open the ad link; ${count} result(s) in the run${runNote})`); return; }
  if (item.jobId) ijSet(sheet, i, IJ_COL.JOB_ID, item.jobId);
  const text = item.description ? ijDescriptionText(item.description) : '';
  if (text.length >= 50) { ijWriteDescription(sheet, i, text, 'browser followed the ad link'); return; }
  const host = (String(item.finalUrl).match(/^https?:\/\/([^/]+)/) || [])[1] || '?';
  const reason = item.jobId ? `browser found job ID ${item.jobId} but no description; run ijFetchDescriptions() again to fetch it by job ID`
    : !/indeed\./i.test(host) ? `ad goes to the employer's own site (${host}), not an Indeed job page`
    : `browser landed on "${item.pageTitle}" with no job ID; probably blocked`;
  ijSet(sheet, i, IJ_COL.DESC_STATUS, `${IJ_FAILED} (${reason})`);
}

function ijWriteDescription(sheet, i, text, how) {
  if (text.length < 50) { ijSet(sheet, i, IJ_COL.DESC_STATUS, `${IJ_FAILED} (${how}: result had no description)`); return; }
  if (text.length > IJ_CONFIG.MAX_CHARS) text = text.substring(0, IJ_CONFIG.MAX_CHARS) + ' …(truncated)';
  ijSet(sheet, i, IJ_COL.DESCRIPTION, /^[=+\-@]/.test(text) ? `'${text}` : text); // stop Sheets reading it as a formula
  ijSet(sheet, i, IJ_COL.DESC_STATUS, `OK (${how})`);
}

// Blanks Job Description and Description Status on every row, and forgets
// uncollected runs, so ijFetchDescriptions() can be tested again.
function ijResetDescriptions() {
  const sheet = ijSheet();
  const n = ijRows(sheet).length;
  if (n) sheet.getRange(2, IJ_COL.DESCRIPTION + 1, n, 2).clearContent();
  ijSaveRuns([]);
  Logger.log(`Cleared descriptions on ${n} row(s).`);
}

// ---- Apify API ----

function ijToken() {
  const token = PropertiesService.getScriptProperties().getProperty('APIFY_TOKEN');
  if (!token) Logger.log('APIFY_TOKEN not set: Project Settings > Script Properties > add APIFY_TOKEN.');
  return token;
}

function ijLoadRuns() {
  const raw = PropertiesService.getScriptProperties().getProperty(IJ_RUNS_KEY);
  return raw ? JSON.parse(raw) : [];
}

function ijSaveRuns(runs) {
  PropertiesService.getScriptProperties().setProperty(IJ_RUNS_KEY, JSON.stringify(runs));
}

function ijRunLink(runId) {
  return `https://console.apify.com/view/runs/${runId}`;
}

// { status, statusMessage } once the run has finished, { error }, or null if
// it's still going at the deadline. Each check waits up to 45s for it to finish.
function ijWaitForRun(token, runId, deadline) {
  for (;;) {
    const wait = Math.max(0, Math.min(45, Math.floor((deadline - Date.now()) / 1000)));
    const poll = ijApify(token, 'get', `/actor-runs/${runId}?waitForFinish=${wait}`);
    if (poll.error) return { error: poll.error };
    const status = poll.data.status;
    if (status !== 'READY' && status !== 'RUNNING') return { status: status, statusMessage: poll.data.statusMessage || '' };
    if (Date.now() >= deadline) return null;
  }
}

// The end of a run's own log, which says why it failed.
function ijRunLog(token, runId) {
  try {
    const res = UrlFetchApp.fetch(`${IJ_CONFIG.APIFY_API}/logs/${runId}`, { headers: { Authorization: `Bearer ${token}` }, muteHttpExceptions: true });
    return res.getResponseCode() === 200 ? res.getContentText().slice(-3000) : `(couldn't read it: status ${res.getResponseCode()})`;
  } catch (err) {
    return `(couldn't read it: ${err})`;
  }
}

// Calls the Apify API: { data } or { error } with Apify's own message (full reply logged).
function ijApify(token, method, path, payload) {
  const options = { method: method, headers: { Authorization: `Bearer ${token}` }, muteHttpExceptions: true };
  if (payload) { options.contentType = 'application/json'; options.payload = JSON.stringify(payload); }
  let response;
  try {
    response = UrlFetchApp.fetch(IJ_CONFIG.APIFY_API + path, options);
  } catch (err) {
    return { error: `request failed: ${String(err).substring(0, 200)}` };
  }
  const code = response.getResponseCode();
  const body = response.getContentText();
  if (code < 200 || code >= 300) {
    Logger.log(`Apify returned ${code} for ${path}: ${body.substring(0, 1000)}`);
    let message = body;
    try { message = JSON.parse(body).error.message || body; } catch (e) { /* keep the raw reply */ }
    return { error: `status ${code}: ${String(message).substring(0, 200)}` };
  }
  try {
    const parsed = JSON.parse(body);
    return { data: Array.isArray(parsed) ? parsed : parsed.data };
  } catch (err) {
    return { error: 'unreadable reply from Apify' };
  }
}

// ==========================================================================
// HELPERS
// ==========================================================================

function ijSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(IJ_CONFIG.TAB) || ss.insertSheet(IJ_CONFIG.TAB);
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, IJ_HEADERS.length).setValues([IJ_HEADERS]).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function ijRows(sheet) {
  if (sheet.getLastRow() < 2) return [];
  return sheet.getRange(2, 1, sheet.getLastRow() - 1, IJ_HEADERS.length).getValues();
}

function ijSet(sheet, rowIndex, col, value) {
  sheet.getRange(rowIndex + 2, col + 1).setValue(value);
}

// Description HTML (or plain text) to readable text, keeping bullets and line breaks.
function ijDescriptionText(html) {
  return ijDecode(String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n• ')
    .replace(/<\/?(p|div|td|tr|li|ul|ol|h[1-6])\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ''))
    .replace(/[ \t]+\n/g, '\n').replace(/\n{2,}/g, '\n')
    .trim();
}

function ijViewUrl(jobId) {
  return `https://uk.indeed.com/viewjob?jk=${jobId}`;
}

// Indeed's job ID (jk): 16 hex characters in the link's jk= / vjk= parameter.
function ijJobId(link) {
  const m = String(link || '').match(/[?&]v?jk=([0-9a-f]{16})/i);
  return m ? m[1] : null;
}

function ijText(html) {
  return ijDecode(String(html || '').replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function ijDecode(s) {
  return String(s)
    .replace(/&nbsp;/gi, ' ').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (m, d) => String.fromCharCode(Number(d)))
    .replace(/&middot;/gi, '·').replace(/&pound;/gi, '£')
    .replace(/&(?!amp;)[a-z]+;/gi, ' ')
    .replace(/&amp;/gi, '&');
}
