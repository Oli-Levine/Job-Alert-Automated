/**
 * INDEED JOBS TEST — a standalone test, not part of the daily run.
 * ------------------------------------------------------------
 * STEP 1 (this file, now): read the Indeed alert emails and list the jobs in
 * an "Indeed Jobs" tab, at most IJ_CONFIG.MAX_JOBS per run. No AI, no Apify,
 * so a run costs nothing.
 * STEP 2 (later): fill the Job Description column. The columns for it are
 * already there (Job Description, Description Status, blank for now), and
 * each row keeps what step 2 will need: the job ID where the link has one,
 * and the link exactly as it is in the email.
 *
 * Use it in a test Google Sheet: Extensions > Apps Script, paste this in as
 * its own file, run ijLoadJobs(), and allow Gmail access when asked.
 * Running it again only adds jobs that aren't in the tab yet.
 */

const IJ_CONFIG = {
  ALERT_SENDER: 'marklevine@bcllegal.com', // same as CONFIG.MARK_EMAIL in Code.gs
  EMAIL_DAYS: 4,      // how far back to look, like the daily run
  MAX_JOBS: 10,       // most jobs added per run, to keep tests quick (and cheap once Apify is added)
  TAB: 'Indeed Jobs'
};

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
