/**
 * JOB DESCRIPTION FETCH — FEASIBILITY TEST
 * ------------------------------------------------------------
 * PURPOSE: test whether we can get a short job description for each
 * posting in the job alert emails. This is a throwaway experiment, NOT
 * part of the main pipeline — no routing, filtering, blocklist, dedup
 * or purge logic.
 *
 * HOW IT WORKS:
 *   1. One Claude call per email pulls out each job's company, location
 *      and link (same [JOBLINK:ID] placeholder trick as V17).
 *   2. The description depends on the source:
 *      - Indeed: Claude writes it in that same call, from the snippet
 *        shown under each job in the alert email. No extra cost.
 *      - LinkedIn: alert emails carry no description, so the script
 *        downloads LinkedIn's public guest job page itself (Claude's own
 *        web fetch tool is blocked from LinkedIn), then one Claude call
 *        per job summarises it.
 *
 * OUTPUT: a single "JD Test" tab — Company | Location | Date | Job Description | Link
 *   - Date is the date the alert email arrived (same as V17's Date Found).
 *   - Nothing is guessed. The description cell says one of these instead:
 *       FETCH FAILED (<reason>)  — LinkedIn page couldn't be downloaded
 *       NO DESCRIPTION IN EMAIL  — Indeed snippet had nothing useful
 *       NO LINK FOUND IN EMAIL   — LinkedIn job with no link to fetch
 *
 * SETUP:
 *   - Safe to paste into the same Apps Script project as V17: every
 *     name here is prefixed with JD_/jd so nothing clashes.
 *   - Uses the same CLAUDE_API_KEY Script Property as V17.
 *   - Run testJobDescriptions() manually. It rewrites the JD Test tab
 *     each run and stops after JD_CONFIG.MAX_JOBS jobs to keep cost down.
 */

const JD_CONFIG = {
  SENDER_EMAIL: 'marklevine@bcllegal.com',
  SHEET_NAME: 'JD Test',
  LOOKBACK_DAYS: 4,
  MAX_JOBS: 10, // cap per run — each LinkedIn job is one page download + one API call
  CLAUDE_API_URL: 'https://api.anthropic.com/v1/messages',
  CLAUDE_MODEL: 'claude-haiku-4-5' // same cheap model as V17 — plenty for summarising text
};

// Failure markers written to the description cell (counted as "failed").
const JD_FAILURE_PREFIXES = ['FETCH FAILED', 'NO DESCRIPTION', 'NO LINK'];

const JD_HEADERS = ['Company', 'Location', 'Date', 'Job Description', 'Link'];

const JD_JOB_LINK_PATTERNS = [
  /indeed\.com\/rc\/clk\/dl/i, /indeed\.com\/pagead\/clk\/dl/i,
  /indeed\.com\/viewjob/i, /linkedin\.com\/comm\/jobs\/view/i,
  /linkedin\.com\/jobs\/view/i
];

// ==========================================================================
// MAIN
// ==========================================================================

function testJobDescriptions() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(JD_CONFIG.SHEET_NAME) || ss.insertSheet(JD_CONFIG.SHEET_NAME);

  const threads = GmailApp.search(`from:${JD_CONFIG.SENDER_EMAIL} newer_than:${JD_CONFIG.LOOKBACK_DAYS}d`);
  const rows = [];
  let described = 0, failed = 0;

  for (const thread of threads) {
    for (const msg of thread.getMessages()) {
      if (rows.length >= JD_CONFIG.MAX_JOBS) break;

      const html = msg.getBody();
      const source = jdDetectSource(html);
      if (!source) continue;

      const { text: emailText, linkMap } = jdPrepareEmail(html);
      if (!emailText || emailText.length < 20) continue;

      const jobs = jdExtractJobs(emailText, source);
      if (!jobs) continue; // already logged

      for (const job of jobs) {
        if (rows.length >= JD_CONFIG.MAX_JOBS) break;
        if (!job || !job.company) continue;

        const url = linkMap[job.link] || '';
        let description;
        if (source === 'Indeed') {
          description = job.description || 'NO DESCRIPTION IN EMAIL';
        } else {
          description = url ? jdLinkedInDescription(job.title, job.company, url) : 'NO LINK FOUND IN EMAIL';
        }
        if (JD_FAILURE_PREFIXES.some(p => description.startsWith(p))) failed++;
        else described++;

        Logger.log(`${job.company} | ${job.town} | ${url}\n  -> ${description}`);
        rows.push([job.company, job.town || '', msg.getDate(), description, url]);
      }
    }
  }

  sheet.clear();
  sheet.getRange(1, 1, 1, JD_HEADERS.length).setValues([JD_HEADERS]).setFontWeight('bold');
  if (rows.length) {
    sheet.getRange(2, 1, rows.length, JD_HEADERS.length).setValues(rows);
    sheet.getRange(2, 3, rows.length, 1).setNumberFormat('dd/mm/yyyy');
  }
  sheet.setFrozenRows(1);
  sheet.autoResizeColumns(1, 3);
  sheet.setColumnWidth(4, 500);
  sheet.setColumnWidth(5, 150); // full URLs are unreadable when auto-sized
  sheet.getRange(1, 4, rows.length + 1, 1).setWrap(true);

  Logger.log(`Done. ${rows.length} jobs written — ${described} with descriptions, ${failed} without.`);
}

// ==========================================================================
// STEP 1 — extract jobs from the email
// ==========================================================================

// For Indeed emails, also asks for a 2-line "description" per job, written
// from the snippet under each listing. LinkedIn emails have no snippet, so
// that field is left out and filled in later by jdLinkedInDescription().
function jdExtractJobs(emailText, source) {
  const descriptionField = source === 'Indeed'
    ? `\n- "description": a job description of at most 2 short lines (roughly 40 words) covering what the role is and its key responsibilities or requirements, written ONLY from the text shown under this job in the email. Never guess from the job title. If the email shows nothing useful for this job (e.g. only salary or "Easily apply"), use exactly "NO DESCRIPTION IN EMAIL".`
    : '';

  const prompt = `You are extracting job listings from a ${source} job alert email. Job links are marked inline as [JOBLINK:ID] right after the job title, where ID is a short code like L1, L2, L3.

Return a JSON array with one object per job listing, each with exactly these fields:
- "title": job title (string)
- "company": employer/company name (string)
- "town": the location as written in the email (string, empty string if not shown)
- "link": the short ID from the matching [JOBLINK:ID] marker, e.g. "L3" — not a URL. Empty string if there is no marker.${descriptionField}

Respond with ONLY the JSON array — no code fences or commentary.

EMAIL TEXT:
${emailText}`;

  const data = jdCallClaude({
    max_tokens: 8192,
    messages: [{ role: 'user', content: prompt }]
  });
  if (!data) return null;

  const text = jdText(data.content);
  try {
    const parsed = JSON.parse(text.replace(/```json|```/g, '').trim());
    if (!Array.isArray(parsed)) throw new Error('Response was not a JSON array');
    return parsed;
  } catch (err) {
    Logger.log(`Failed to parse job list: ${err}. Raw (first 500 chars): ${text.substring(0, 500)}`);
    return null;
  }
}

// ==========================================================================
// STEP 2 (LinkedIn only) — download the job page and summarise it
// ==========================================================================

// LinkedIn's guest endpoint returns the public job page (description
// included) without a login. Apps Script downloads it with UrlFetchApp,
// then Claude summarises the text — no Claude web fetch tool involved.
function jdLinkedInDescription(title, company, url) {
  const idMatch = url.match(/\/jobs\/view\/(\d+)/);
  if (!idMatch) return 'FETCH FAILED (no job ID in link)';

  let response;
  try {
    response = UrlFetchApp.fetch(`https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${idMatch[1]}`, {
      muteHttpExceptions: true,
      followRedirects: true
    });
  } catch (err) {
    Logger.log(`LinkedIn download failed for ${url}: ${err}`);
    return 'FETCH FAILED (download error — see logs)';
  }

  const code = response.getResponseCode();
  if (code !== 200) return `FETCH FAILED (LinkedIn returned status ${code})`;

  // The description sits in the "show-more-less-html__markup" block; fall
  // back to the whole page if LinkedIn ever changes that class name.
  const html = response.getContentText();
  const block = html.match(/<div[^>]*show-more-less-html__markup[^>]*>([\s\S]*?)<\/div>/i);
  const pageText = jdHtmlToText(block ? block[1] : html).substring(0, 15000);
  if (pageText.length < 50) return 'FETCH FAILED (page had no description text)';

  const prompt = `Below is the text of a job posting for "${title}" at ${company}.

Write a job description of at most 2 short lines (roughly 40 words total) covering what the role is and its key responsibilities or requirements. Base it ONLY on the text below — never guess from the job title.

If the text doesn't contain a job description, reply with exactly: FETCH FAILED (no description on page)

Reply with ONLY the description (or the FETCH FAILED line) — no preamble.

JOB POSTING TEXT:
${pageText}`;

  const data = jdCallClaude({ max_tokens: 1024, messages: [{ role: 'user', content: prompt }] });
  if (!data) return 'FETCH FAILED (API error — see logs)';
  return jdText(data.content) || 'FETCH FAILED (empty response)';
}

// ==========================================================================
// CLAUDE API
// ==========================================================================

// Sends one Messages API request and returns the parsed response, or null
// on any HTTP/parse failure or refusal (all logged).
function jdCallClaude(body) {
  const apiKey = PropertiesService.getScriptProperties().getProperty('CLAUDE_API_KEY');
  if (!apiKey) {
    Logger.log('CLAUDE_API_KEY not set in Script Properties. Project Settings > Script Properties > add CLAUDE_API_KEY.');
    return null;
  }

  body.model = JD_CONFIG.CLAUDE_MODEL;

  let response;
  try {
    response = UrlFetchApp.fetch(JD_CONFIG.CLAUDE_API_URL, {
      method: 'post',
      contentType: 'application/json',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      payload: JSON.stringify(body),
      muteHttpExceptions: true
    });
  } catch (err) {
    Logger.log(`Claude API request failed: ${err}`);
    return null;
  }

  const code = response.getResponseCode();
  if (code !== 200) {
    Logger.log(`Claude API returned status ${code}: ${response.getContentText().substring(0, 500)}`);
    return null;
  }

  let data;
  try {
    data = JSON.parse(response.getContentText());
  } catch (err) {
    Logger.log(`Failed to parse Claude API response: ${err}`);
    return null;
  }

  if (data.stop_reason === 'refusal') {
    Logger.log(`Claude declined the request: ${JSON.stringify(data.stop_details)}`);
    return null;
  }
  return data;
}

function jdText(content) {
  return (content || []).filter(b => b.type === 'text' && b.text).map(b => b.text).join('').trim();
}

// ==========================================================================
// EMAIL PREP (standalone copies of V17's helpers)
// ==========================================================================

function jdDetectSource(html) {
  if (/linkedin\.com/i.test(html) && /job alert/i.test(html)) return 'LinkedIn';
  if (/indeed\.com/i.test(html)) return 'Indeed';
  return null;
}

// Swaps each job link for a short [JOBLINK:Ln] placeholder so the model
// never has to echo long tracking URLs; linkMap resolves them back.
function jdPrepareEmail(html) {
  let working = html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '');

  const linkMap = {};
  let counter = 0;
  working = working.replace(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (match, href, inner) => {
    const rawUrl = href.replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"');
    const text = inner.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    if (!JD_JOB_LINK_PATTERNS.some(p => p.test(rawUrl))) return text;
    counter++;
    const id = 'L' + counter;
    linkMap[id] = jdShortenJobLink(rawUrl);
    return `${text} [JOBLINK:${id}]`;
  });

  return { text: jdHtmlToText(working), linkMap: linkMap };
}

function jdHtmlToText(html) {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|td|tr|li)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&#8203;|\u200b/g, '')
    .replace(/\u034f/g, '')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

// Clean public URLs: these go in the Link column, and the LinkedIn job ID
// is read from the /jobs/view/<id> path.
function jdShortenJobLink(url) {
  const jkMatch = url.match(/[?&]jk=([^&]+)/);
  if (jkMatch) return `https://uk.indeed.com/viewjob?jk=${jkMatch[1]}`;
  if (/linkedin\.com/i.test(url)) return url.split('?')[0].replace('/comm/jobs/', '/jobs/');
  return url;
}
