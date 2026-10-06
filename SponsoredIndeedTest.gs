/**
 * SPONSORED INDEED TEST — a standalone experiment, not part of the daily run.
 * ------------------------------------------------------------
 * Sponsored Indeed jobs come in alert emails as ad-tracking links
 * (uk.indeed.com/pagead/clk?...) with no job ID (jk) in them. What we know so far:
 *   - Apps Script can't open them: Indeed answers 403 on the very first
 *     request, so even reading where the redirect points is blocked (v23).
 *   - Apify's Indeed scraper (misceres~indeed-scraper) rejects ad links outright.
 *   - An Indeed search (title + company in the town) via that scraper found
 *     and fully described 1 of 3 sponsored jobs.
 *
 * This file tests the remaining routes side by side, on a test Sheet, and
 * writes what happened to a "Test Results" tab. It doesn't touch any
 * daily-run tab. Every name here starts with st / ST_, so it can sit in the
 * same Apps Script project as Code.gs without clashing, or be used on its own.
 *
 * SETUP (once)
 *   1. In the test Sheet: Extensions > Apps Script, add a file
 *      SponsoredIndeedTest, paste this in.
 *   2. Project Settings > Script Properties: add APIFY_TOKEN.
 *   3. Run stSetup(). It creates the "Sponsored Test" and "Test Results" tabs.
 *   4. Paste a few sponsored rows into "Sponsored Test", columns A–F, copied
 *      straight from the live sheet's New Leads (or Needs Review / Other):
 *      Source | Job Title | Company | Town | Date Found | Link. Only rows whose
 *      Link contains indeed.com/pagead/ are used, the first ST_CONFIG.MAX_LEADS
 *      of them. Use links from the last day or two, as ad links may expire.
 *
 * TESTS (run from the editor, in any order)
 *   stScanEmails()  — free. Looks in the raw alert emails for a job ID hidden
 *                     near each sponsored link.
 *   stTestBrowser() — a real browser on Apify (apify~web-scraper) opens each
 *                     ad link, follows it to the job page and reads the job ID
 *                     and description there. Run twice: Apify's default proxy,
 *                     and UK residential proxy (closer to a real visitor).
 *   stTestSearch()  — Indeed searches via misceres~indeed-scraper, three ways
 *                     (company + town, title + town, title + company), and
 *                     reports exact / loose company + title matches.
 *   stCollect()     — collects runs that hadn't finished when a test stopped
 *                     waiting. Safe to run any time.
 * Each Apify test costs a few pence for 3 leads; runs are capped at 5 minutes.
 */

const ST_CONFIG = {
  LEADS_TAB: 'Sponsored Test',
  RESULTS_TAB: 'Test Results',
  ALERT_SENDER: 'marklevine@bcllegal.com', // same as CONFIG.MARK_EMAIL in Code.gs
  EMAIL_DAYS: 7,           // how far back stScanEmails() looks
  MAX_LEADS: 3,            // sponsored rows used per test
  APIFY_API: 'https://api.apify.com/v2',
  INDEED_ACTOR: 'misceres~indeed-scraper',
  BROWSER_ACTOR: 'apify~web-scraper',
  BROWSER_MEMORY_MB: 2048, // two browser runs at once stay inside the free plan's 8 GB
  RUN_TIMEOUT_SECS: 300,   // Apify stops (and stops charging for) a run after this
  WAIT_SECS: 240           // how long a test waits for its runs before leaving them to stCollect()
};
const ST_PENDING_KEY = 'ST_PENDING_RUNS';
const ST_LEAD_HEADERS = ['Source', 'Job Title', 'Company', 'Town', 'Date Found', 'Link'];
const ST_RESULT_HEADERS = ['Tested At', 'Test', 'Lead', 'Job Title', 'Company', 'Outcome', 'Job ID', 'Found At', 'Description'];
const ST_DESCRIPTION_FIELDS = ['description', 'descriptionText', 'jobDescription', 'descriptionHTML', 'descriptionHtml'];

// ==========================================================================
// SETUP
// ==========================================================================

function stSetup() {
  stSheet(ST_CONFIG.LEADS_TAB, ST_LEAD_HEADERS);
  stSheet(ST_CONFIG.RESULTS_TAB, ST_RESULT_HEADERS);
  Logger.log(`Tabs ready. Paste sponsored rows (A–F from New Leads) into "${ST_CONFIG.LEADS_TAB}", then run a test.`);
}

function stSheet(name, headers) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

// Sponsored leads from the "Sponsored Test" tab: [{ n, title, company, town, link }].
function stReadLeads() {
  const sheet = stSheet(ST_CONFIG.LEADS_TAB, ST_LEAD_HEADERS);
  if (sheet.getLastRow() < 2) return [];
  return sheet.getRange(2, 1, sheet.getLastRow() - 1, 6).getValues()
    .filter(r => /indeed\.com\/pagead\//i.test(String(r[5])))
    .slice(0, ST_CONFIG.MAX_LEADS)
    .map((r, i) => ({ n: i + 1, title: String(r[1]), company: String(r[2]), town: String(r[3]), link: String(r[5]).trim() }));
}

// ==========================================================================
// TEST 1 — job ID hidden in the email (free)
// ==========================================================================

// For each sponsored link in recent Indeed alert emails, looks at the email
// HTML around it for a 16-character job ID. Job IDs that belong to the
// email's ordinary (non-sponsored) links are marked, since those are
// neighbouring jobs, not this one.
function stScanEmails() {
  const threads = GmailApp.search(`from:${ST_CONFIG.ALERT_SENDER} newer_than:${ST_CONFIG.EMAIL_DAYS}d`);
  const rows = [];
  let emails = 0;
  threads.forEach(thread => thread.getMessages().forEach(msg => {
    const html = msg.getBody();
    if (!/indeed\.com/i.test(html) || /linkedin\.com/i.test(html) && /job alert/i.test(html)) return;
    emails++;
    const links = [...html.matchAll(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)].map(m => ({
      href: m[1].replace(/&amp;/g, '&'),
      text: m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
      at: m.index
    }));
    const ordinaryJks = new Set(links.map(l => (l.href.match(/[?&]v?jk=([0-9a-f]{16})/i) || [])[1]).filter(Boolean));
    links.filter(l => /indeed\.com\/pagead\//i.test(l.href)).forEach(l => {
      const near = html.substring(Math.max(0, l.at - 1500), l.at + 1500);
      const named = [...near.matchAll(/(?:v?jk|data-jk|jobkey)["'=:\s]+([0-9a-f]{16})\b/gi)].map(m => m[1]);
      const any = [...near.matchAll(/\b[0-9a-f]{16}\b/gi)].map(m => m[0]);
      const candidates = [...new Set([...named, ...any])].map(jk => ordinaryJks.has(jk) ? `${jk} (an ordinary link's)` : jk);
      const params = (l.href.split('?')[1] || '').split('&').map(p => p.split('=')[0]).join(', ');
      const outcome = named.some(jk => !ordinaryJks.has(jk)) ? 'Job ID found next to the link'
        : candidates.length ? 'Only unlabelled 16-character codes nearby (may not be job IDs)'
        : 'No job ID anywhere near the link';
      rows.push(['Email scan', `${msg.getDate().toLocaleDateString('en-GB')}`, l.text, '',
        `${outcome}. Link parameters: ${params}`, candidates.join(' / '), l.href, '']);
    });
  }));
  if (!rows.length) { Logger.log(`No sponsored links in ${emails} Indeed email(s) from the last ${ST_CONFIG.EMAIL_DAYS} days.`); return; }
  stWriteResults(rows.slice(0, 30));
  Logger.log(`Email scan: ${rows.length} sponsored link(s) in ${emails} Indeed email(s). See "${ST_CONFIG.RESULTS_TAB}".`);
}

// ==========================================================================
// TEST 2 — real browser follows the ad link (Apify web-scraper)
// ==========================================================================

// Runs in Apify's browser on the page the ad link ends up on. Waits up to
// 10s for the description to render, then reports the final URL, the job ID
// (from the URL, or the page's canonical link) and the description text.
const ST_PAGE_FUNCTION = `async function pageFunction(context) {
  let description = null;
  for (let i = 0; i < 20 && !description; i++) {
    const el = document.querySelector('#jobDescriptionText');
    if (el && el.innerText.trim()) description = el.innerText.trim();
    else await new Promise(r => setTimeout(r, 500));
  }
  const canonical = document.querySelector('link[rel="canonical"]');
  const jkIn = s => { const m = String(s || '').match(/[?&]v?jk=([0-9a-f]{16})/i); return m ? m[1] : null; };
  return {
    lead: context.request.userData.lead,
    finalUrl: window.location.href,
    jk: jkIn(window.location.href) || jkIn(canonical && canonical.href),
    pageTitle: document.title,
    description: description
  };
}`;

function stTestBrowser() {
  const token = stToken();
  const leads = stReadLeads();
  if (!token || !stHaveLeads(leads)) return;
  const variants = [
    { test: 'Browser (default proxy)', proxy: { useApifyProxy: true } },
    { test: 'Browser (UK residential proxy)', proxy: { useApifyProxy: true, apifyProxyGroups: ['RESIDENTIAL'], apifyProxyCountry: 'GB' } }
  ];
  variants.forEach(v => stStartRun(token, v.test, 'browser', ST_CONFIG.BROWSER_ACTOR, {
    startUrls: leads.map(l => ({ url: l.link, userData: { lead: l.n } })),
    pageFunction: ST_PAGE_FUNCTION,
    proxyConfiguration: v.proxy,
    injectJQuery: false,
    maxRequestRetries: 2,
    maxPagesPerCrawl: leads.length,
    pageLoadTimeoutSecs: 60
  }, leads, ST_CONFIG.BROWSER_MEMORY_MB));
  stCollect(ST_CONFIG.WAIT_SECS);
}

function stJudgeBrowser(lead, items) {
  const item = items.find(it => it.lead === lead.n);
  if (!item) return { outcome: 'No result: the page never loaded (blocked or timed out); see the run log' };
  const description = item.description ? stCellText(item.description) : '';
  const host = (String(item.finalUrl).match(/^https?:\/\/([^/]+)/) || [])[1] || '';
  let outcome;
  if (item.jk && description.length >= 50) outcome = 'WORKS: reached the Indeed job page and read the description';
  else if (item.jk) outcome = `PARTLY: got the job ID (the normal Apify route can fetch it), but no description on the page ("${item.pageTitle}")`;
  else if (host && !/indeed\./i.test(host)) outcome = `Ad goes to the employer's own site (${host}), not Indeed`;
  else outcome = `No job ID: landed on "${item.pageTitle}" (a block / check page?)`;
  return { outcome: outcome, jk: item.jk || '', foundAt: item.finalUrl, description: description };
}

// ==========================================================================
// TEST 3 — Indeed search via the Indeed scraper, three ways
// ==========================================================================

function stTestSearch() {
  const token = stToken();
  const leads = stReadLeads();
  if (!token || !stHaveLeads(leads)) return;
  const town = l => (/remote|uk-?wide|nationwide|united kingdom/i.test(l.town) ? '' : l.town);
  const search = (q, where) => `https://uk.indeed.com/jobs?q=${encodeURIComponent(q)}${where ? `&l=${encodeURIComponent(where)}` : ''}`;
  const variants = [
    { test: 'Search: company + town', url: l => search(l.company, town(l)) },
    { test: 'Search: title + town', url: l => search(stShortTitle(l.title), town(l)) },
    { test: 'Search: title + company', url: l => search(`${stShortTitle(l.title)} ${l.company}`, '') }
  ];
  variants.forEach(v => {
    const urls = leads.map(v.url);
    Logger.log(`${v.test}: ${urls.join(' , ')}`);
    stStartRun(token, v.test, 'search', ST_CONFIG.INDEED_ACTOR,
      { startUrls: urls.map(u => ({ url: u })), maxItems: leads.length * 20 }, leads, null);
  });
  stCollect(ST_CONFIG.WAIT_SECS);
}

function stJudgeSearch(lead, items) {
  const pick = (item, names) => { const k = names.find(n => item[n]); return k ? String(item[k]) : ''; };
  const titleOf = it => pick(it, ['positionName', 'title', 'jobTitle', 'displayTitle']);
  const companyOf = it => pick(it, ['company', 'companyName', 'employer']);
  const looseCompany = c => stNorm(c).replace(/\b(ltd|limited|plc|llp|inc)\b/g, '').replace(/\s+/g, ' ').trim();
  const looseTitle = t => stNorm(stShortTitle(t));

  const exact = items.find(it => stNorm(titleOf(it)) === stNorm(lead.title) && stNorm(companyOf(it)) === stNorm(lead.company));
  const sameCompany = items.filter(it => looseCompany(companyOf(it)) === looseCompany(lead.company));
  const loose = sameCompany.find(it => {
    const a = looseTitle(titleOf(it)), b = looseTitle(lead.title);
    return a === b || (a && b && (a.includes(b) || b.includes(a)));
  });
  const match = exact || loose;
  if (!match) {
    return { outcome: `No match (${items.length} result(s) in the run; ${sameCompany.length} from this company`
      + `${sameCompany.length ? `: ${sameCompany.slice(0, 3).map(titleOf).join(' / ')}` : ''})` };
  }
  const field = ST_DESCRIPTION_FIELDS.find(f => match[f]);
  const raw = field ? match[field] : '';
  const description = stCellText(stHtmlToText(typeof raw === 'object' ? (raw.html || raw.text || JSON.stringify(raw)) : raw));
  const jk = (JSON.stringify(match).match(/[?&"]v?jk["=:]*"?([0-9a-f]{16})/i) || [])[1] || pick(match, ['id', 'jobKey']);
  return {
    outcome: exact ? 'EXACT company + title match' : `LOOSE match: "${titleOf(match)} | ${companyOf(match)}"`,
    jk: jk,
    foundAt: pick(match, ['url', 'externalApplyLink']),
    description: description
  };
}

// ==========================================================================
// APIFY RUNS — start, then collect (now or later)
// ==========================================================================

function stStartRun(token, test, kind, actor, input, leads, memoryMb) {
  const query = `?timeout=${ST_CONFIG.RUN_TIMEOUT_SECS}${memoryMb ? `&memory=${memoryMb}` : ''}`;
  const res = stApify(token, 'post', `/acts/${actor}/runs${query}`, input);
  if (res.error) {
    stWriteResults([[test, '', '', '', `Couldn't start the Apify run: ${res.error}`, '', '', '']]);
    return;
  }
  const pending = stLoadPending();
  pending.push({ test: test, kind: kind, runId: res.data.id, datasetId: res.data.defaultDatasetId, leads: leads, startedAt: Date.now() });
  PropertiesService.getScriptProperties().setProperty(ST_PENDING_KEY, JSON.stringify(pending));
  Logger.log(`${test}: Apify run ${res.data.id} started.`);
}

function stLoadPending() {
  const raw = PropertiesService.getScriptProperties().getProperty(ST_PENDING_KEY);
  return raw ? JSON.parse(raw) : [];
}

// Writes a result row per lead for every finished run. Runs still going after
// waitSecs (default: don't wait) stay pending for the next stCollect().
function stCollect(waitSecs) {
  const token = stToken();
  if (!token) return;
  const deadline = Date.now() + (Number(waitSecs) || 0) * 1000;
  const stillGoing = [];
  stLoadPending().forEach(run => {
    const info = stWaitForRun(token, run.runId, deadline);
    const runLink = `https://console.apify.com/view/runs/${run.runId}`;
    if (!info) { stillGoing.push(run); Logger.log(`${run.test}: still running; run stCollect() later. ${runLink}`); return; }
    if (info.error) { stWriteResults([[run.test, '', '', '', info.error, '', runLink, '']]); return; }
    const items = stApify(token, 'get', `/datasets/${run.datasetId}/items?clean=true&format=json`);
    const list = Array.isArray(items.data) ? items.data : [];
    const runNote = info.status === 'SUCCEEDED' ? '' : ` [run ${info.status}${info.statusMessage ? `: ${info.statusMessage}` : ''}]`;
    Logger.log(`${run.test}: run ${info.status}, ${list.length} result(s).`
      + (list.length ? ` Fields in first result: ${Object.keys(list[0]).join(', ')}` : '') + ` ${runLink}`);
    stWriteResults(run.leads.map(lead => {
      const r = run.kind === 'browser' ? stJudgeBrowser(lead, list) : stJudgeSearch(lead, list);
      return [run.test, lead.n, lead.title, lead.company, r.outcome + runNote, r.jk || '', r.foundAt || runLink, r.description || ''];
    }));
  });
  PropertiesService.getScriptProperties().setProperty(ST_PENDING_KEY, JSON.stringify(stillGoing));
  Logger.log(`Done. ${stillGoing.length} run(s) still going. Results are in "${ST_CONFIG.RESULTS_TAB}".`);
}

// Returns { status, statusMessage } once finished, { error }, or null if
// still running at the deadline.
function stWaitForRun(token, runId, deadline) {
  for (;;) {
    const wait = Math.max(0, Math.min(45, Math.floor((deadline - Date.now()) / 1000)));
    const poll = stApify(token, 'get', `/actor-runs/${runId}?waitForFinish=${wait}`);
    if (poll.error) return { error: poll.error };
    const status = poll.data.status;
    if (status !== 'READY' && status !== 'RUNNING') return { status: status, statusMessage: poll.data.statusMessage || '' };
    if (Date.now() >= deadline) return null;
  }
}

// Calls the Apify API. Returns { data } or { error } (with Apify's own message).
function stApify(token, method, path, payload) {
  const options = { method: method, headers: { Authorization: `Bearer ${token}` }, muteHttpExceptions: true };
  if (payload) { options.contentType = 'application/json'; options.payload = JSON.stringify(payload); }
  let response;
  try {
    response = UrlFetchApp.fetch(ST_CONFIG.APIFY_API + path, options);
  } catch (err) {
    return { error: `Apify request failed: ${String(err).substring(0, 200)}` };
  }
  const code = response.getResponseCode();
  const body = response.getContentText();
  if (code < 200 || code >= 300) {
    let message = body;
    try { message = JSON.parse(body).error.message || body; } catch (e) { /* keep raw body */ }
    Logger.log(`Apify returned ${code} for ${path}: ${body.substring(0, 500)}`);
    return { error: `Apify returned status ${code}: ${String(message).substring(0, 200)}` };
  }
  try {
    const parsed = JSON.parse(body);
    return { data: Array.isArray(parsed) ? parsed : parsed.data };
  } catch (err) {
    return { error: 'Unreadable Apify response' };
  }
}

// ==========================================================================
// HELPERS
// ==========================================================================

function stToken() {
  const token = PropertiesService.getScriptProperties().getProperty('APIFY_TOKEN');
  if (!token) Logger.log('APIFY_TOKEN not set: Project Settings > Script Properties.');
  return token;
}

function stHaveLeads(leads) {
  if (leads.length) {
    leads.forEach(l => Logger.log(`Lead ${l.n}: ${l.title} | ${l.company} | ${l.town}`));
    return true;
  }
  Logger.log(`No sponsored rows (Link containing indeed.com/pagead/) in "${ST_CONFIG.LEADS_TAB}". Run stSetup() and paste some in.`);
  return false;
}

// Row = [test, lead, title, company, outcome, job ID, found at, description].
function stWriteResults(rows) {
  if (!rows.length) return;
  const sheet = stSheet(ST_CONFIG.RESULTS_TAB, ST_RESULT_HEADERS);
  const stamped = rows.map(r => [new Date(), ...r.slice(0, 7), stSafe(r[7])]);
  sheet.getRange(sheet.getLastRow() + 1, 1, stamped.length, ST_RESULT_HEADERS.length).setValues(stamped);
}

// Drops bracketed bits like "(Hybrid)" so searches and title matches aren't too narrow.
function stShortTitle(t) {
  return String(t).replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
}

function stNorm(s) {
  return String(s || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
}

function stCellText(text) {
  const t = String(text || '').trim();
  return t.length > 45000 ? t.substring(0, 45000) + ' …(truncated)' : t;
}

// Stops Sheets reading text that starts with = + - @ as a formula.
function stSafe(text) {
  const t = String(text || '');
  return /^[=+\-@]/.test(t) ? `'${t}` : t;
}

function stHtmlToText(html) {
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
