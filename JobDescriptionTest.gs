/**
 * JOB DESCRIPTION FETCH — FEASIBILITY TEST
 * ------------------------------------------------------------
 * PURPOSE: test whether the Claude API can fetch a short job
 * description for each posting in the job alert emails. This is a
 * throwaway experiment, NOT part of the main V17 pipeline — no
 * routing, filtering, blocklist, dedup or purge logic.
 *
 * HOW IT WORKS (two Claude calls):
 *   1. One call per email: pull out each job's company, location and
 *      link (same [JOBLINK:ID] placeholder trick as V17).
 *   2. One call per job: Claude uses its server-side web_fetch tool to
 *      open the job link and write a 2-line description.
 *
 * OUTPUT: a single "JD Test" tab — Company | Location | Date | Job Description | Link
 *   - Date is the date the alert email arrived (same as V17's Date Found).
 *   - If the page couldn't be fetched (LinkedIn/Indeed often block bots),
 *     the description cell says "FETCH FAILED (<reason>)" instead of
 *     guessing — that's the main thing this test is meant to reveal.
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
  MAX_JOBS: 10, // cap per run — each job is one API call with a web fetch
  CLAUDE_API_URL: 'https://api.anthropic.com/v1/messages',
  // web_fetch_20260209 needs a 4.6+ Opus/Sonnet model — Haiku 4.5 (used
  // by V17) only supports the older fetch tool. Sonnet keeps cost down.
  CLAUDE_MODEL: 'claude-sonnet-5'
};

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
  let fetched = 0, failed = 0;

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
        const description = url
          ? jdFetchDescription(job.title, job.company, url)
          : 'NO LINK FOUND IN EMAIL';
        if (description.startsWith('FETCH FAILED') || description.startsWith('NO LINK')) failed++;
        else fetched++;

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

  Logger.log(`Done. ${rows.length} jobs written — ${fetched} descriptions fetched, ${failed} failed.`);
}

// ==========================================================================
// STEP 1 — extract jobs from the email
// ==========================================================================

function jdExtractJobs(emailText, source) {
  const prompt = `You are extracting job listings from a ${source} job alert email. Job links are marked inline as [JOBLINK:ID] right after the job title, where ID is a short code like L1, L2, L3.

Return a JSON array with one object per job listing, each with exactly these fields:
- "title": job title (string)
- "company": employer/company name (string)
- "town": the location as written in the email (string, empty string if not shown)
- "link": the short ID from the matching [JOBLINK:ID] marker, e.g. "L3" — not a URL. Empty string if there is no marker.

Respond with ONLY the JSON array — no code fences or commentary.

EMAIL TEXT:
${emailText}`;

  const data = jdCallClaude({
    max_tokens: 4096,
    output_config: { effort: 'low' },
    messages: [{ role: 'user', content: prompt }]
  });
  if (!data) return null;

  const text = jdLastText(data.content);
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
// STEP 2 — fetch the job page and summarise it in 2 lines
// ==========================================================================

function jdFetchDescription(title, company, url) {
  const prompt = `Fetch this job posting with the web_fetch tool and summarise it.

Job: ${title} at ${company}
URL: ${url}

Write a job description of at most 2 short lines (roughly 40 words total) covering what the role is and its key responsibilities or requirements. Base it ONLY on the fetched page — never guess from the job title.

If the page cannot be fetched, requires a login, or doesn't contain the job description, reply with exactly: FETCH FAILED (<short reason>)

Reply with ONLY the description (or the FETCH FAILED line) — no preamble.`;

  const messages = [{ role: 'user', content: prompt }];
  const tools = [{ type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 2 }];

  // Server tools can end a turn with stop_reason "pause_turn" — resend the
  // conversation so far and Claude picks up where it left off.
  for (let attempt = 0; attempt < 3; attempt++) {
    const data = jdCallClaude({ max_tokens: 4096, output_config: { effort: 'low' }, tools: tools, messages: messages });
    if (!data) return 'FETCH FAILED (API error — see logs)';

    if (data.stop_reason === 'pause_turn') {
      messages.push({ role: 'assistant', content: data.content });
      continue;
    }

    // Report the fetch tool's own error code if it failed, so the sheet
    // shows WHY (e.g. url_not_accessible) rather than just "failed".
    const fetchError = (data.content || [])
      .filter(b => b.type === 'web_fetch_tool_result' && b.content && b.content.type === 'web_fetch_tool_error')
      .map(b => b.content.error_code)[0];

    const text = jdLastText(data.content);
    if (fetchError && (!text || text.startsWith('FETCH FAILED'))) return `FETCH FAILED (${fetchError})`;
    return text || 'FETCH FAILED (empty response)';
  }
  return 'FETCH FAILED (too many pause_turn continuations)';
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

// With tools in play the response can hold several text blocks (e.g. a
// "let me fetch that" line before the tool call) — the answer is the last one.
function jdLastText(content) {
  const texts = (content || []).filter(b => b.type === 'text' && b.text);
  return texts.length ? texts[texts.length - 1].text.trim() : '';
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

  const text = working
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|td|tr|li)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&#8203;|​/g, '')
    .replace(/͏/g, '')
    .trim();

  return { text: text, linkMap: linkMap };
}

// Clean public URLs matter more here than in V17 — web_fetch has to open
// them, and tracking redirects are more likely to be blocked.
function jdShortenJobLink(url) {
  const jkMatch = url.match(/[?&]jk=([^&]+)/);
  if (jkMatch) return `https://uk.indeed.com/viewjob?jk=${jkMatch[1]}`;
  if (/linkedin\.com/i.test(url)) return url.split('?')[0].replace('/comm/jobs/', '/jobs/');
  return url;
}
