/**
 * INDEED + APIFY TEST — a standalone test, not part of the daily run.
 * ------------------------------------------------------------
 * Takes the Indeed jobs from the alert emails, lists them in an "Indeed Test"
 * tab with a Job Description column, and tries to fill it via Apify
 * (misceres~indeed-scraper). Everything Apify sends back is also listed in
 * an "Apify Raw" tab, so we can see exactly what happened and troubleshoot.
 *
 * Ordinary and sponsored jobs are kept apart, because they're different:
 *   - Ordinary links carry the job ID (jk), so Apify gets the clean job page
 *     link (uk.indeed.com/viewjob?jk=...) and results are matched back by jk.
 *   - Sponsored links (pagead/clk ad redirects) carry no job ID, so Apify
 *     gets the ad link exactly as it is in the email, in a SEPARATE run (so
 *     if Apify rejects it, the ordinary run isn't affected). Results are
 *     matched back by job title, and the row says so.
 *
 * SETUP (once), in a test Google Sheet:
 *   1. Extensions > Apps Script: paste this file in (on its own, or next to
 *      Code.gs — every name here starts with it / IT_, so nothing clashes).
 *   2. Project Settings > Script Properties: add APIFY_TOKEN.
 *
 * RUN
 *   itRunTest()      — does everything: reads the emails, adds new jobs to
 *                      the tab, starts Apify and waits up to 4 minutes.
 *   itCollect()      — if a run hadn't finished in time, run this a few
 *                      minutes later to pick up its results.
 *   itLoadJobs() / itFetchDescriptions() — the two halves, if needed alone.
 * The Gmail permission prompt appears on the first run.
 */

const IT_CONFIG = {
  ALERT_SENDER: 'marklevine@bcllegal.com', // same as CONFIG.MARK_EMAIL in Code.gs
  EMAIL_DAYS: 4,          // same lookback as the daily run
  JOBS_TAB: 'Indeed Test',
  RAW_TAB: 'Apify Raw',
  APIFY_API: 'https://api.apify.com/v2',
  APIFY_ACTOR: 'misceres~indeed-scraper',
  RUN_TIMEOUT_SECS: 600,  // Apify stops (and stops charging for) a run after this
  WAIT_SECS: 240,         // how long itRunTest() waits for results
  MAX_CHARS: 45000        // a Sheets cell holds 50,000 characters
};
const IT_RUNS_KEY = 'IT_APIFY_RUNS';
const IT_HEADERS = ['Email Date', 'Job Title', 'Link Type', 'Link', 'Job ID', 'Job Description', 'Status'];
const IT_RAW_HEADERS = ['Checked At', 'Run', 'Run Status', 'Result #', 'Title', 'Company', 'Location', 'URL', 'Job ID', 'Description Chars', 'Fields'];
const IT_COL = { DATE: 0, TITLE: 1, TYPE: 2, LINK: 3, JK: 4, DESC: 5, STATUS: 6 };
const IT_DESCRIPTION_FIELDS = ['description', 'descriptionText', 'jobDescription', 'descriptionHTML', 'descriptionHtml'];
const IT_PENDING = 'PENDING (waiting for Apify)';

function itRunTest() {
  itLoadJobs();
  itFetchDescriptions();
}

// ==========================================================================
// 1. INDEED JOBS FROM THE EMAILS
// ==========================================================================

// Adds every Indeed job link in the recent alert emails to the tab (skipping
// ones already there). The title is the link's own text in the email.
function itLoadJobs() {
  const sheet = itSheet(IT_CONFIG.JOBS_TAB, IT_HEADERS);
  const known = new Set(itRows(sheet).map(r => itKey(r[IT_COL.LINK])));
  const threads = GmailApp.search(`from:${IT_CONFIG.ALERT_SENDER} newer_than:${IT_CONFIG.EMAIL_DAYS}d`);
  const added = [];
  let emails = 0;

  threads.forEach(thread => thread.getMessages().forEach(msg => {
    const html = msg.getBody();
    if (!/indeed\.com/i.test(html) || (/linkedin\.com/i.test(html) && /job alert/i.test(html))) return;
    emails++;
    const byLink = new Map(); // a job often has several links (title, logo, button) — keep the longest text
    for (const m of html.matchAll(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
      const href = m[1].replace(/&amp;/g, '&');
      if (!/indeed\.com\/(rc\/clk|pagead\/clk|viewjob)/i.test(href)) continue;
      const text = m[2].replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
      const prev = byLink.get(href);
      if (prev === undefined || text.length > prev.length) byLink.set(href, text);
    }
    byLink.forEach((title, href) => {
      const jk = itJobKey(href);
      const link = jk ? itViewUrl(jk) : href;
      if (known.has(itKey(link))) return;
      known.add(itKey(link));
      added.push([msg.getDate(), title, jk ? 'Ordinary' : 'Sponsored', link, jk || '', '', '']);
    });
  }));

  if (added.length) sheet.getRange(sheet.getLastRow() + 1, 1, added.length, IT_HEADERS.length).setValues(added);
  const sponsored = added.filter(r => r[IT_COL.TYPE] === 'Sponsored').length;
  Logger.log(`${emails} Indeed email(s) in the last ${IT_CONFIG.EMAIL_DAYS} days: ${added.length} new job(s) added `
    + `(${added.length - sponsored} ordinary, ${sponsored} sponsored).`);
}

// ==========================================================================
// 2. DESCRIPTIONS VIA APIFY
// ==========================================================================

// Starts Apify for every row with no description yet (one run for ordinary
// jobs, one for sponsored), then waits for the results.
function itFetchDescriptions() {
  const token = itToken();
  if (!token) return;
  const sheet = itSheet(IT_CONFIG.JOBS_TAB, IT_HEADERS);
  const rows = itRows(sheet);
  const todo = rows.map((r, i) => ({ r: r, i: i })).filter(x => !x.r[IT_COL.DESC] && x.r[IT_COL.STATUS] !== IT_PENDING);
  if (!todo.length) { Logger.log('No rows waiting for a description.'); itCollect(); return; }

  ['Ordinary', 'Sponsored'].forEach(type => {
    const group = todo.filter(x => x.r[IT_COL.TYPE] === type);
    if (!group.length) return;
    const urls = [...new Set(group.map(x => String(x.r[IT_COL.LINK])))];
    const res = itApify(token, 'post', `/acts/${IT_CONFIG.APIFY_ACTOR}/runs?timeout=${IT_CONFIG.RUN_TIMEOUT_SECS}`, {
      startUrls: urls.map(u => ({ url: u })),
      maxItems: urls.length
    });
    const status = res.error ? `FETCH FAILED (couldn't start Apify: ${res.error})` : IT_PENDING;
    group.forEach(x => itSet(sheet, x.i, IT_COL.STATUS, status));
    if (res.error) { Logger.log(`${type}: couldn't start Apify — ${res.error}`); return; }
    const runs = itLoadRuns();
    runs.push({ type: type, runId: res.data.id, datasetId: res.data.defaultDatasetId, startedAt: Date.now() });
    PropertiesService.getScriptProperties().setProperty(IT_RUNS_KEY, JSON.stringify(runs));
    Logger.log(`${type}: Apify run ${res.data.id} started for ${urls.length} job(s). https://console.apify.com/view/runs/${res.data.id}`);
  });
  itCollect(IT_CONFIG.WAIT_SECS);
}

// Writes the results of every finished run into the tab, and lists every
// result in "Apify Raw". Runs still going after waitSecs stay for next time.
function itCollect(waitSecs) {
  const token = itToken();
  if (!token) return;
  const deadline = Date.now() + (Number(waitSecs) || 0) * 1000;
  const sheet = itSheet(IT_CONFIG.JOBS_TAB, IT_HEADERS);
  const stillGoing = [];

  itLoadRuns().forEach(run => {
    const link = `https://console.apify.com/view/runs/${run.runId}`;
    const info = itWaitForRun(token, run.runId, deadline);
    if (!info) { stillGoing.push(run); Logger.log(`${run.type}: run still going — run itCollect() in a few minutes. ${link}`); return; }
    if (info.error) { stillGoing.push(run); Logger.log(`${run.type}: couldn't check the run — ${info.error}`); return; }

    const res = itApify(token, 'get', `/datasets/${run.datasetId}/items?clean=true&format=json`);
    const items = Array.isArray(res.data) ? res.data : [];
    const runNote = info.status === 'SUCCEEDED' ? '' : `Apify run ${info.status}${info.statusMessage ? `: ${info.statusMessage}` : ''}`;
    Logger.log(`${run.type}: run ${info.status}${info.statusMessage ? ` (${info.statusMessage})` : ''}, ${items.length} result(s). ${link}`);
    if (items.length) Logger.log(`First result: ${JSON.stringify(items[0]).substring(0, 1500)}`);
    if (info.status !== 'SUCCEEDED') Logger.log(`${run.type}: end of Apify's log for this run:\n${itRunLog(token, run.runId)}`);
    itWriteRaw(run, info.status, items);
    itWriteResults(sheet, run, items, runNote, res.error);
  });

  PropertiesService.getScriptProperties().setProperty(IT_RUNS_KEY, JSON.stringify(stillGoing));
  Logger.log(`Done${stillGoing.length ? `; ${stillGoing.length} run(s) still going` : ''}. See the "${IT_CONFIG.JOBS_TAB}" and "${IT_CONFIG.RAW_TAB}" tabs.`);
}

// Fills the PENDING rows of this run's type. Ordinary rows match by job ID;
// sponsored rows by title (the only thing they share with a result).
function itWriteResults(sheet, run, items, runNote, readError) {
  itRows(sheet).forEach((r, i) => {
    if (r[IT_COL.TYPE] !== run.type || r[IT_COL.STATUS] !== IT_PENDING) return;
    if (readError) { itSet(sheet, i, IT_COL.STATUS, `FETCH FAILED (couldn't read results: ${readError})`); return; }
    let item, how;
    if (run.type === 'Ordinary') {
      item = items.find(it => JSON.stringify(it).indexOf(r[IT_COL.JK]) !== -1);
      how = 'matched by job ID';
    } else {
      item = items.find(it => itNorm(itPick(it, ['positionName', 'title', 'jobTitle'])) === itNorm(r[IT_COL.TITLE]));
      how = 'matched by title';
    }
    if (!item) {
      itSet(sheet, i, IT_COL.STATUS, `FETCH FAILED (no result for this job; ${items.length} result(s) in the run${runNote ? `; ${runNote}` : ''})`);
      return;
    }
    const field = IT_DESCRIPTION_FIELDS.find(f => item[f]);
    const raw = field ? item[field] : '';
    const text = itHtmlToText(typeof raw === 'object' ? (raw.html || raw.text || JSON.stringify(raw)) : raw);
    if (!r[IT_COL.JK]) { // a sponsored job: record the job ID Apify found, if any
      const jk = itJobKey(JSON.stringify(item));
      if (jk) itSet(sheet, i, IT_COL.JK, jk);
    }
    if (text.length < 50) { itSet(sheet, i, IT_COL.STATUS, `FETCH FAILED (result ${how} had no description)`); return; }
    itSet(sheet, i, IT_COL.DESC, itSafe(text.length > IT_CONFIG.MAX_CHARS ? text.substring(0, IT_CONFIG.MAX_CHARS) + ' …(truncated)' : text));
    itSet(sheet, i, IT_COL.STATUS, `OK (${how})`);
  });
}

function itWriteRaw(run, status, items) {
  const sheet = itSheet(IT_CONFIG.RAW_TAB, IT_RAW_HEADERS);
  const now = new Date();
  const rows = items.length ? items.map((it, n) => {
    const field = IT_DESCRIPTION_FIELDS.find(f => it[f]);
    return [now, `${run.type} ${run.runId}`, status, n + 1,
      itPick(it, ['positionName', 'title', 'jobTitle']), itPick(it, ['company', 'companyName']),
      itPick(it, ['location', 'jobLocation', 'formattedLocation']), itPick(it, ['url', 'externalApplyLink']),
      itJobKey(JSON.stringify(it)) || '', field ? String(it[field]).length : 0, Object.keys(it).join(', ')];
  }) : [[now, `${run.type} ${run.runId}`, status, 0, '(no results)', '', '', '', '', 0, '']];
  sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, IT_RAW_HEADERS.length).setValues(rows);
}

// ==========================================================================
// APIFY API
// ==========================================================================

function itLoadRuns() {
  const raw = PropertiesService.getScriptProperties().getProperty(IT_RUNS_KEY);
  return raw ? JSON.parse(raw) : [];
}

// Returns { status, statusMessage } once finished, { error }, or null if
// still running at the deadline. Each poll holds up to 45s (UrlFetchApp's limit is ~60s).
function itWaitForRun(token, runId, deadline) {
  for (;;) {
    const wait = Math.max(0, Math.min(45, Math.floor((deadline - Date.now()) / 1000)));
    const poll = itApify(token, 'get', `/actor-runs/${runId}?waitForFinish=${wait}`);
    if (poll.error) return { error: poll.error };
    const status = poll.data.status;
    if (status !== 'READY' && status !== 'RUNNING') return { status: status, statusMessage: poll.data.statusMessage || '' };
    if (Date.now() >= deadline) return null;
  }
}

// The last part of a run's own log, which says why a run failed.
function itRunLog(token, runId) {
  try {
    const res = UrlFetchApp.fetch(`${IT_CONFIG.APIFY_API}/logs/${runId}`, { headers: { Authorization: `Bearer ${token}` }, muteHttpExceptions: true });
    const text = res.getContentText();
    return res.getResponseCode() === 200 ? text.slice(-3000) : `(couldn't read the log: status ${res.getResponseCode()})`;
  } catch (err) {
    return `(couldn't read the log: ${err})`;
  }
}

// Returns { data } or { error } (with Apify's own message; full reply logged).
function itApify(token, method, path, payload) {
  const options = { method: method, headers: { Authorization: `Bearer ${token}` }, muteHttpExceptions: true };
  if (payload) { options.contentType = 'application/json'; options.payload = JSON.stringify(payload); }
  let response;
  try {
    response = UrlFetchApp.fetch(IT_CONFIG.APIFY_API + path, options);
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
    return { error: 'unreadable reply' };
  }
}

// ==========================================================================
// HELPERS
// ==========================================================================

function itToken() {
  const token = PropertiesService.getScriptProperties().getProperty('APIFY_TOKEN');
  if (!token) Logger.log('APIFY_TOKEN not set: Project Settings > Script Properties.');
  return token;
}

function itSheet(name, headers) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(name) || ss.insertSheet(name);
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function itRows(sheet) {
  if (sheet.getLastRow() < 2) return [];
  return sheet.getRange(2, 1, sheet.getLastRow() - 1, IT_HEADERS.length).getValues();
}

function itSet(sheet, rowIndex, col, value) {
  sheet.getRange(rowIndex + 2, col + 1).setValue(value);
}

function itJobKey(s) {
  const m = String(s || '').match(/[?&]v?jk=([0-9a-f]{16})/i);
  return m ? m[1] : null;
}

function itViewUrl(jk) {
  return `https://uk.indeed.com/viewjob?jk=${jk}`;
}

// Ordinary jobs are compared by job ID, sponsored ones by their exact ad link.
function itKey(link) {
  return itJobKey(link) || String(link || '');
}

function itPick(item, names) {
  const k = names.find(n => item[n]);
  return k ? (typeof item[k] === 'object' ? JSON.stringify(item[k]) : String(item[k])) : '';
}

function itNorm(s) {
  return String(s || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
}

// Stops Sheets reading text that starts with = + - @ as a formula.
function itSafe(text) {
  return /^[=+\-@]/.test(text) ? `'${text}` : text;
}

function itHtmlToText(html) {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n• ')
    .replace(/<\/?(p|div|td|tr|li|ul|ol|h[1-6])\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"')
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (m, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/gi, '&')
    .replace(/[ \t]+\n/g, '\n').replace(/\n{2,}/g, '\n')
    .trim();
}
