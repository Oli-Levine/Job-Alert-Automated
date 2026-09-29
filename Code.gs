/**
 * JOB ALERT AUTOMATION v20
 * ------------------------------------------------------------
 * CHANGES FROM v19:
 *   - NEW "Unfilter Company" tab (single column, Company). If the AI
 *     filters a job from a company on this list, the filter is reversed
 *     and the job routes as normal: New Leads with its region's Staff ID
 *     (or Other / Needs Review, same rules as any routed job). The AI is
 *     now asked to give a region for filtered jobs too, so there's a
 *     region to route with. Only reverses the AI's own "filter" — the
 *     manual Company / Job Title Blocklists still win over it.
 *   - A job rescued this way skips the Filtered Out dedup check, so a job
 *     the AI filtered on an earlier run can still reach New Leads while
 *     its email is inside LOOKBACK_DAYS. The old Filtered Out row is left
 *     in place as a record.
 *   - Bournemouth, Poole and Christchurch now go to Southern Home Counties
 *     (Ray), not South West. Set in the prompt, like the Peterborough
 *     exception, and enforced in code (SOUTHERN_HOME_COUNTIES_TOWNS) in
 *     case the AI still answers South West for them.
 *   - Daily schedule built into this script: processJobAlerts() runs at
 *     ~07:30 and runDailySend() emails the workbook at ~08:30 (UK time)
 *     to DAILY_SEND_CONFIG.RECIPIENT_EMAILS, as an .xlsx attachment plus
 *     a link to the live Google Sheet (recipients are given viewer
 *     access so the link opens). Set up once with
 *     createDailyTriggers(). Replaces createDailyTrigger(),
 *     dailyRunAndSend() and createDailyRunAndSendTrigger().
 *
 * CHANGES FROM v18 (carried forward — sheet now feeds a CRM import):
 *   - NEW "Staff ID" column on New Leads (column G, after Link), from the
 *     old v17 region -> consultant mapping but outputting CRM Staff IDs.
 *     North West -> Craig only. Pre-v19 rows keep a blank Staff ID.
 *     Appended at the end so Date Found (E) and Link (F) keep the
 *     positions dedup and sorting rely on; Other keeps 6 columns.
 *   - NEW "Job Title Blocklist" tab, same normalised exact match as
 *     Company Blocklist.
 *   - REMOVED (for now) the 30-day resurfacing flag and the 84-day purge;
 *     dedup is permanent. Recoverable from git history (v18 = c51aff2).
 */

const CONFIG = {
  MARK_EMAIL: 'marklevine@bcllegal.com',
  NEW_LEADS_SHEET_NAME: 'New Leads',
  NEEDS_REVIEW_SHEET_NAME: 'Needs Review',
  FILTERED_SHEET_NAME: 'Filtered Out',
  OTHER_SHEET_NAME: 'Other',
  BLOCKLIST_SHEET_NAME: 'Company Blocklist',
  TITLE_BLOCKLIST_SHEET_NAME: 'Job Title Blocklist',
  UNFILTER_SHEET_NAME: 'Unfilter Company',
  COMPANY_REGIONS_SHEET_NAME: 'Company Regions',
  TORY_EMAIL: '', // TODO: add Tory's email address
  LOOKBACK_DAYS: 4,
  CLAUDE_API_URL: 'https://api.anthropic.com/v1/messages',
  CLAUDE_MODEL: 'claude-haiku-4-5-20251001' // cheap + plenty accurate at this volume; bump to 'claude-sonnet-4-6' if testing shows accuracy problems
};

// ---- Logical regions --------------------------------------------------------
const REGIONS = [
  'Scotland', 'North East', 'Yorkshire', 'North West', 'West Midlands',
  'East Midlands', 'Northern Home Counties', 'Southern Home Counties',
  'London', 'South West', 'Ireland', 'East Anglia', 'Other'
];

// ---- Region -> destination tab(s) mapping -----------------------------------
// Every region except "Other" lands in the single New Leads tab (v18 —
// previously fanned out across 5 per-consultant tabs, with North West going
// to both Craig and Alison). "Other" keeps its own separate flat tab.
const REGION_TO_TABS = {
  'Scotland': [CONFIG.NEW_LEADS_SHEET_NAME],
  'North West': [CONFIG.NEW_LEADS_SHEET_NAME],
  'Ireland': [CONFIG.NEW_LEADS_SHEET_NAME],
  'North East': [CONFIG.NEW_LEADS_SHEET_NAME],
  'Yorkshire': [CONFIG.NEW_LEADS_SHEET_NAME],
  'West Midlands': [CONFIG.NEW_LEADS_SHEET_NAME],
  'East Midlands': [CONFIG.NEW_LEADS_SHEET_NAME],
  'South West': [CONFIG.NEW_LEADS_SHEET_NAME],
  'London': [CONFIG.NEW_LEADS_SHEET_NAME],
  'Northern Home Counties': [CONFIG.NEW_LEADS_SHEET_NAME],
  'Southern Home Counties': [CONFIG.NEW_LEADS_SHEET_NAME],
  'East Anglia': [CONFIG.NEW_LEADS_SHEET_NAME],
  'Other': [CONFIG.OTHER_SHEET_NAME]
};

// Tabs that get rewritten in full every run (read back, merge, dedupe by
// Link, sort newest-first) rather than Other's simpler always-append pattern.
const REBUILD_TABS = [CONFIG.NEW_LEADS_SHEET_NAME];
const FLAT_TABS = [CONFIG.OTHER_SHEET_NAME];
const ALL_TAB_NAMES = [...new Set(Object.values(REGION_TO_TABS).flat())];

// ---- Consultant CRM Staff IDs -------------------------------------------------
const STAFF_IDS = {
  'Alison McKee': 'TI0W4STT300120180003',
  'Craig Wilson': 'TI174EJE010620110002',
  'Josh Mcconnell': 'TI19FWLD10052021001G',
  'Ray Birkett': 'TI19OTTT110820230060',
  'Tom Shaw': 'TI0W0UTT300120180002'
};

// The v17 region -> consultant mapping, outputting the CRM Staff ID for the
// New Leads "Staff ID" column. North West is Craig only (v17 also sent it to
// Alison). "Other" has no consultant — those jobs go to the Other tab.
const REGION_TO_STAFF_ID = {
  'Scotland': STAFF_IDS['Craig Wilson'],
  'North West': STAFF_IDS['Craig Wilson'],
  'Ireland': STAFF_IDS['Alison McKee'],
  'North East': STAFF_IDS['Tom Shaw'],
  'Yorkshire': STAFF_IDS['Tom Shaw'],
  'West Midlands': STAFF_IDS['Josh Mcconnell'],
  'East Midlands': STAFF_IDS['Josh Mcconnell'],
  'South West': STAFF_IDS['Josh Mcconnell'],
  'London': STAFF_IDS['Ray Birkett'],
  'Northern Home Counties': STAFF_IDS['Ray Birkett'],
  'Southern Home Counties': STAFF_IDS['Ray Birkett'],
  'East Anglia': STAFF_IDS['Ray Birkett']
};

// ---- Headers ------------------------------------------------------------------
// TAB_HEADERS is still used by Other. New Leads has its own header list with
// Staff ID appended at the end, so Date Found (E) and Link (F) stay put.
const TAB_HEADERS = ['Source', 'Job Title', 'Company', 'Town', 'Date Found', 'Link'];
const NEW_LEADS_HEADERS = [...TAB_HEADERS, 'Staff ID'];
const REVIEW_HEADERS = ['Source', 'Job Title', 'Company', 'Town', 'Date Found', 'Link', 'Reason'];
const FILTERED_HEADERS = ['Source', 'Job Title', 'Company', 'Town', 'Date Found', 'Link', 'Filtered Reason'];
const BLOCKLIST_HEADERS = ['Company'];
const TITLE_BLOCKLIST_HEADERS = ['Job Title'];
const UNFILTER_HEADERS = ['Company'];

// Dorset towns BCL treats as Southern Home Counties rather than South West.
// Mirrors the prompt's exception; applied in code when the AI says South West.
const SOUTHERN_HOME_COUNTIES_TOWNS = /\b(bournemouth|poole|christchurch)\b/i;
const COMPANY_REGIONS_HEADERS = ['Company', 'Region'];

// ---- Job link detection (kept deterministic — not handed to the AI) ----------
const JOB_LINK_PATTERNS = [
  /indeed\.com\/rc\/clk\/dl/i, /indeed\.com\/pagead\/clk\/dl/i,
  /indeed\.com\/viewjob/i, /linkedin\.com\/comm\/jobs\/view/i,
  /linkedin\.com\/jobs\/view/i
];

// ==========================================================================
// MAIN
// ==========================================================================

function processJobAlerts() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  const tabSheets = {};
  ALL_TAB_NAMES.forEach(tabName => { tabSheets[tabName] = getOrCreateSheet(ss, tabName); });
  FLAT_TABS.forEach(tabName => ensureHeaders(tabSheets[tabName], TAB_HEADERS));

  const reviewSheet = getOrCreateSheet(ss, CONFIG.NEEDS_REVIEW_SHEET_NAME);
  ensureHeaders(reviewSheet, REVIEW_HEADERS);
  const filteredSheet = getOrCreateSheet(ss, CONFIG.FILTERED_SHEET_NAME);
  ensureHeaders(filteredSheet, FILTERED_HEADERS);
  const blocklistSheet = getOrCreateSheet(ss, CONFIG.BLOCKLIST_SHEET_NAME);
  ensureHeaders(blocklistSheet, BLOCKLIST_HEADERS);
  const blockedCompanies = loadBlocklist(blocklistSheet);
  const titleBlocklistSheet = getOrCreateSheet(ss, CONFIG.TITLE_BLOCKLIST_SHEET_NAME);
  ensureHeaders(titleBlocklistSheet, TITLE_BLOCKLIST_HEADERS);
  const blockedTitles = loadBlocklist(titleBlocklistSheet);
  const unfilterSheet = getOrCreateSheet(ss, CONFIG.UNFILTER_SHEET_NAME);
  ensureHeaders(unfilterSheet, UNFILTER_HEADERS);
  const unfilterCompanies = loadBlocklist(unfilterSheet);

  const companyRegionsSheet = getOrCreateSheet(ss, CONFIG.COMPANY_REGIONS_SHEET_NAME);
  ensureHeaders(companyRegionsSheet, COMPANY_REGIONS_HEADERS);
  const companyRegionOverrides = loadCompanyRegions(companyRegionsSheet);

  const existingLinksByTab = {};
  const existingKeysByTab = {};
  ALL_TAB_NAMES.forEach(tabName => {
    const { links, keys } = loadExistingLinksAndKeys(tabSheets[tabName]);
    existingLinksByTab[tabName] = links;
    existingKeysByTab[tabName] = keys;
  });
  const { links: reviewLinks, keys: reviewKeys } = loadExistingLinksAndKeys(reviewSheet);
  const { links: filteredLinks, keys: filteredKeys } = loadExistingLinksAndKeys(filteredSheet);

  const query = `from:${CONFIG.MARK_EMAIL} newer_than:${CONFIG.LOOKBACK_DAYS}d`;
  const threads = GmailApp.search(query);

  const newRowsByTab = {};
  ALL_TAB_NAMES.forEach(tabName => { newRowsByTab[tabName] = []; });
  const touchedTabs = new Set();

  let addedCount = 0, filteredCount = 0, reviewCount = 0, skippedEmails = 0, blockedCount = 0, blockedTitleCount = 0, companyRegionOverrideCount = 0, unfilteredCount = 0;

  threads.forEach(thread => {
    thread.getMessages().forEach(msg => {
      const html = msg.getBody();
      const dateFound = msg.getDate();
      const source = detectSource(html);
      if (!source) return;

      const { text: emailText, linkMap } = prepareEmailForApi(html);
      if (!emailText || emailText.length < 20) return; // nothing worth sending

      const jobs = callClaudeForJobs(emailText, source);
      if (jobs === null) { skippedEmails++; return; } // API/parse failure — already logged

      jobs.forEach(job => {
        if (!job || !job.title || !job.company || !job.action) return;

        // Unfilter Company reverses the AI's own "filter" so the job routes
        // as normal, using the region the AI still gives for filtered jobs.
        // Runs before the blocklists so those manual lists still win.
        const aiFilteredUnfilterCompany = job.action === 'filter' && unfilterCompanies.has(normalizeText(job.company));
        if (aiFilteredUnfilterCompany) {
          job.action = 'route';
          job.reason = 'Unfilter Company, but AI gave no usable region';
        }

        // Code-level blocklist enforcement — overrides whatever the AI
        // decided. A blocklisted company is ALWAYS filtered, regardless
        // of whether the AI recognised it as an agency/law firm/etc.
        // Job Title Blocklist works the same way; only checked when the
        // company isn't already blocked, so each job counts once.
        if (blockedCompanies.has(normalizeText(job.company))) {
          job.action = 'filter';
          job.reason = 'Company on blocklist';
          blockedCount++;
        } else if (blockedTitles.has(normalizeText(job.title))) {
          job.action = 'filter';
          job.reason = 'Job title on blocklist';
          blockedTitleCount++;
        }

        const rescued = aiFilteredUnfilterCompany && job.action === 'route';
        if (rescued) unfilteredCount++;

        if (job.action === 'route' && job.region === 'South West' && SOUTHERN_HOME_COUNTIES_TOWNS.test(job.town || '')) {
          job.region = 'Southern Home Counties';
        }

        // Company Regions override — only applies to jobs the AI already
        // classified as "Other" (Remote/UK-wide, no real town). A
        // blocklisted job never reaches here with action still 'route',
        // so no conflict-handling needed against either blocklist.
        if (job.action === 'route' && job.region === 'Other') {
          const overrideRegion = companyRegionOverrides.get(normalizeText(job.company));
          if (overrideRegion) {
            job.region = overrideRegion;
            companyRegionOverrideCount++;
          }
        }

        const link = resolveJobLink(linkMap, job.link);
        const town = job.town || '';
        const jobKey = normalizeJobKey(job.title, job.company, town);

        // Dedup is permanent: with no purge, a job seen once in Filtered
        // Out / Needs Review is never reprocessed. The exception is a job
        // rescued by Unfilter Company, which skips the Filtered Out check
        // so a job filtered on an earlier run can still reach New Leads
        // (its old Filtered Out row is left as a record).
        const inFiltered = !rescued && ((link && filteredLinks.has(link)) || filteredKeys.has(jobKey));
        const inReview = (link && reviewLinks.has(link)) || reviewKeys.has(jobKey);
        if (inFiltered || inReview) return;

        if (job.action === 'filter') {
          filteredSheet.appendRow([source, job.title, job.company, town, dateFound, link, job.reason || 'Filtered by AI']);
          if (link) filteredLinks.add(link);
          filteredKeys.add(jobKey);
          touchedTabs.add(CONFIG.FILTERED_SHEET_NAME);
          filteredCount++;
          return;
        }

        if (job.action === 'review' || !REGIONS.includes(job.region)) {
          reviewSheet.appendRow([source, job.title, job.company, town, dateFound, link, job.reason || 'AI uncertain of region']);
          if (link) reviewLinks.add(link);
          reviewKeys.add(jobKey);
          touchedTabs.add(CONFIG.NEEDS_REVIEW_SHEET_NAME);
          reviewCount++;
          return;
        }

        // action === 'route'
        const region = job.region;
        const targetTabs = REGION_TO_TABS[region] || [];
        targetTabs.forEach(tabName => {
          const linkSet = existingLinksByTab[tabName];
          const keySet = existingKeysByTab[tabName];

          if (link && linkSet.has(link)) return; // exact same link already present
          if (keySet.has(jobKey)) return; // same job under a different link — always a duplicate

          if (link) linkSet.add(link);
          keySet.add(jobKey);
          const row = [source, job.title, job.company, town, dateFound, link];
          if (tabName === CONFIG.NEW_LEADS_SHEET_NAME) row.push(REGION_TO_STAFF_ID[region]);
          newRowsByTab[tabName].push(row);
          touchedTabs.add(tabName);
          addedCount++;
        });
      });
    });
  });

  REBUILD_TABS.forEach(tabName => {
    rebuildNewLeadsTab(tabSheets[tabName], newRowsByTab[tabName]);
  });

  FLAT_TABS.forEach(tabName => {
    const sheet = tabSheets[tabName];
    if (touchedTabs.has(tabName)) {
      newRowsByTab[tabName].forEach(row => sheet.appendRow(row));
    }
    formatDateColumn(sheet);
    sortNewestFirst(sheet);
    autoResizeSheet(sheet);
  });

  [reviewSheet, filteredSheet].forEach(sheet => {
    formatDateColumn(sheet);
    sortNewestFirst(sheet);
    autoResizeSheet(sheet);
  });

  // Read by runDailySend() to warn if the morning run didn't complete.
  PropertiesService.getScriptProperties().setProperty(LAST_PROCESSING_SUCCESS_KEY, todayInSendTimeZone());

  Logger.log(`Done. ${addedCount} rows written (${companyRegionOverrideCount} redirected from Other via Company Regions, ${unfilteredCount} unfiltered via Unfilter Company). ${reviewCount} sent to Needs Review. ${filteredCount} filtered out (${blockedCount} due to Company Blocklist, ${blockedTitleCount} due to Job Title Blocklist). ${skippedEmails} email(s) skipped due to API/parse errors.`);
}

// ==========================================================================
// EMAIL PREP — keeps job links attached, strips everything else
// ==========================================================================

function prepareEmailForApi(html) {
  let working = html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '');

  // Instead of embedding the real URL inline (which is what caused the
  // truncation bugs — some Indeed/LinkedIn tracking URLs run 300+ chars,
  // and asking the model to reproduce several of those verbatim blows
  // past the output token limit), each job link gets a short placeholder
  // ID (L1, L2, ...). The model only ever has to echo back "L3", not the
  // URL itself. Apps Script resolves the ID back to the real link
  // afterward — see resolveJobLink().
  const linkMap = {};
  let counter = 0;

  working = working.replace(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (match, href, inner) => {
    const rawUrl = decodeHtmlEntities(href);
    const text = cleanText(stripInlineTags(inner));
    if (!isJobLink(rawUrl)) return text;
    counter++;
    const id = 'L' + counter;
    linkMap[id] = shortenJobLink(rawUrl);
    return `${text} [JOBLINK:${id}]`;
  });

  return { text: stripTags(working), linkMap: linkMap };
}

function resolveJobLink(linkMap, idOrLink) {
  if (!idOrLink) return '';
  return linkMap[idOrLink] || '';
}

// This is only used to decide what link gets STORED against a placeholder
// ID — it's never sent to the model, so length is no longer a concern.
// Still worth cleaning Indeed's jk-based links to a short working URL;
// everything else (LinkedIn, sponsored pagead links) is kept as-is since
// the full URL is what actually works.
function shortenJobLink(url) {
  const jkMatch = url.match(/[?&]jk=([^&]+)/);
  if (jkMatch) return `https://uk.indeed.com/viewjob?jk=${jkMatch[1]}`;
  // LinkedIn's job ID lives in the URL PATH, so the tracking query string
  // (trackingId=..., refId=..., etc.) can be safely dropped — this was
  // accidentally lost in an earlier simplification.
  if (/linkedin\.com/i.test(url)) return url.split('?')[0];
  return url;
}

function stripInlineTags(html) {
  return html.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '');
}

function isJobLink(href) {
  return JOB_LINK_PATTERNS.some(p => p.test(href));
}

// ==========================================================================
// CLAUDE API CALL
// ==========================================================================

function callClaudeForJobs(emailText, source) {
  const apiKey = PropertiesService.getScriptProperties().getProperty('CLAUDE_API_KEY');
  if (!apiKey) {
    Logger.log('CLAUDE_API_KEY not set in Script Properties — skipping this email. Project Settings > Script Properties > add CLAUDE_API_KEY.');
    return null;
  }

  const prompt = buildPrompt(emailText, source);

  let response;
  try {
    response = UrlFetchApp.fetch(CONFIG.CLAUDE_API_URL, {
      method: 'post',
      contentType: 'application/json',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      payload: JSON.stringify({
        model: CONFIG.CLAUDE_MODEL,
        max_tokens: 4096,
        messages: [{ role: 'user', content: prompt }]
      }),
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
    Logger.log(`Failed to parse Claude API response envelope: ${err}`);
    return null;
  }

  const textBlock = (data.content || []).find(c => c.type === 'text');
  if (!textBlock || !textBlock.text) {
    Logger.log('Claude API returned no text content.');
    return null;
  }

  const cleaned = textBlock.text.replace(/```json|```/g, '').trim();
  try {
    const parsed = JSON.parse(cleaned);
    if (!Array.isArray(parsed)) throw new Error('Response was not a JSON array');
    return parsed;
  } catch (err) {
    Logger.log(`Failed to parse Claude JSON output: ${err}. Raw (first 500 chars): ${cleaned.substring(0, 500)}`);
    return null;
  }
}

function buildPrompt(emailText, source) {
  return `You are extracting job listings from a ${source} job alert email for a legal recruitment company (BCL Legal). The email text below has job links marked inline as [JOBLINK:ID] right after the job title text, where ID is a short code like L1, L2, L3.

TASK: Return a JSON array with one object per job listing found. Each object must have exactly these fields:
- "title": job title (string)
- "company": employer/company name (string)
- "town": the location/town as written in the email (string, empty string if not shown)
- "link": the ID from the matching [JOBLINK:ID] marker — just the short code itself, e.g. "L3" — NOT a URL. Empty string if no marker is present for this listing.
- "action": one of "route", "filter", or "review"
- "region": must be exactly one of: ${REGIONS.join(', ')}. Required if action is "route". If action is "filter", still give the region the location maps to using the same rules below (empty string if it genuinely can't be placed) — it is used if the filter is overridden. Empty string if action is "review".
- "reason": required if action is "filter" or "review", short plain-English reason (string)

FILTERING RULES (action = "filter"):
- Law firms, solicitors, chambers, legal recruitment agencies
- Charities, foundations, trusts, CIOs
- Councils and local authorities (borough/county/city/district councils)
- General recruitment/staffing agencies

REGION ASSIGNMENT:
Assign the town/location to exactly one region from this list, using this guidance:
- Scotland, North East, Yorkshire, North West, West Midlands, East Midlands, London, South West, Ireland — standard UK regions/postcode areas
- East Anglia — Norfolk, Suffolk, Cambridgeshire, Essex only (e.g. Cambridge, Norwich, Ipswich, Chelmsford, Colchester, Ely)
  - EXCEPTION: Peterborough is classified as East Midlands, NOT East Anglia, even though it sits in Cambridgeshire. Always route Peterborough to East Midlands.
- Northern Home Counties — Oxfordshire, Buckinghamshire, Bedfordshire, Hertfordshire (e.g. Oxford, Milton Keynes, Luton, St Albans, Watford)
- Southern Home Counties — Surrey, Kent, Sussex, Hampshire, Berkshire (e.g. Reading, Guildford, Brighton, Southampton, Portsmouth)
  - EXCEPTION: Bournemouth, Poole and Christchurch are classified as Southern Home Counties, NOT South West, even though they sit in Dorset. Always route them to Southern Home Counties.
- Other — use this confidently (do NOT send to review) for: Remote, UK-wide, Nationwide, Work From Home, "United Kingdom", or any listing where the location is clearly national/non-specific rather than tied to a real town. These should always be routed to Other, never sent to review.

If the town is genuinely ambiguous, unrecognisable, or missing in a way that ISN'T covered by the Other rule above, use action "review" with a reason instead of guessing.

Respond with ONLY the JSON array. No markdown code fences, no commentary, no explanation before or after.

EMAIL TEXT:
${emailText}`;
}

// ==========================================================================
// NEW LEADS REBUILD
// ==========================================================================
// Full read-clear-rewrite: reads back existing rows, merges in this run's
// new rows, dedupes by Link, sorts newest-first and rewrites the tab. Job
// rows with no Link are intentionally dropped. Every row is written with
// NEW_LEADS_HEADERS' 7 columns; rows from before v19 read back with a blank
// Staff ID and keep it.

function rebuildNewLeadsTab(sheet, newRows) {
  if (!sheet) {
    Logger.log(`rebuildNewLeadsTab called with no sheet — check that CONFIG.NEW_LEADS_SHEET_NAME ("${CONFIG.NEW_LEADS_SHEET_NAME}") matches the tab name exactly.`);
    return;
  }
  newRows = newRows || [];
  const lastRow = sheet.getLastRow();
  const numCols = NEW_LEADS_HEADERS.length;

  const existingRows = [];
  if (lastRow >= 1) {
    const data = sheet.getRange(1, 1, lastRow, numCols).getValues();
    data.forEach(row => {
      // Compares only the first 6 cells so the pre-v19 header (no Staff ID)
      // is recognised too, rather than being carried forward as a job row.
      const isHeaderRow = row.slice(0, TAB_HEADERS.length).join('|') === TAB_HEADERS.join('|');
      if (isHeaderRow || !row[5]) return;
      existingRows.push(row);
    });
  }

  const seen = new Set();
  const combined = existingRows.concat(newRows).filter(row => {
    const link = row[5];
    if (!link) return true;
    if (seen.has(link)) return false;
    seen.add(link);
    return true;
  });
  combined.sort((a, b) => new Date(b[4]) - new Date(a[4]));

  sheet.clear();

  sheet.getRange(1, 1, 1, numCols).setValues([NEW_LEADS_HEADERS]).setFontWeight('bold');

  if (combined.length > 0) {
    const dataStartRow = 2;
    sheet.getRange(dataStartRow, 1, combined.length, numCols).setValues(combined);
    sheet.getRange(dataStartRow, 5, combined.length, 1).setNumberFormat('dd/mm/yyyy hh:mm');
  }

  sheet.autoResizeColumns(1, numCols);
  applyFixedLinkColumnWidth(sheet);
}

// ==========================================================================
// FORMATTING REFRESH (no data changes)
// ==========================================================================

function refreshAllFormatting() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  REBUILD_TABS.forEach(tabName => {
    const sheet = ss.getSheetByName(tabName);
    if (!sheet) return;
    rebuildNewLeadsTab(sheet, []);
    Logger.log(`${tabName}: formatting refreshed.`);
  });

  const otherTabs = [...FLAT_TABS, CONFIG.NEEDS_REVIEW_SHEET_NAME, CONFIG.FILTERED_SHEET_NAME];
  otherTabs.forEach(tabName => {
    const sheet = ss.getSheetByName(tabName);
    if (!sheet) return;
    autoResizeSheet(sheet);
    Logger.log(`${tabName}: formatting refreshed.`);
  });

  Logger.log('Done. All tabs reformatted, no data changed.');
}

// ==========================================================================
// FULL RESET
// ==========================================================================

function resetAllJobData() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  const clearedTabs = [...REBUILD_TABS, ...FLAT_TABS, CONFIG.NEEDS_REVIEW_SHEET_NAME, CONFIG.FILTERED_SHEET_NAME];
  clearedTabs.forEach(tabName => {
    const sheet = ss.getSheetByName(tabName);
    if (!sheet) return;
    const lastRow = sheet.getLastRow();
    if (lastRow > 1) sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).clearContent();
  });

  Logger.log('All job data cleared. Run processJobAlerts() to repopulate fresh.');
}

// ==========================================================================
// CLEANUP — old broken Indeed links
// ==========================================================================

function cleanupBrokenIndeedLinks() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const brokenPatterns = [
    /^https:\/\/uk\.indeed\.com\/rc\/clk\/dl$/i,
    /^https:\/\/uk\.indeed\.com\/pagead\/clk\/dl$/i
  ];
  let removedCount = 0;

  ss.getSheets().forEach(sheet => {
    const lastRow = sheet.getLastRow();
    if (lastRow < 1) return;
    const lastCol = Math.max(sheet.getLastColumn(), 6);
    const data = sheet.getRange(1, 1, lastRow, lastCol).getValues();
    data.forEach((row, idx) => {
      const link = String(row[5] || '');
      if (brokenPatterns.some(p => p.test(link))) {
        sheet.getRange(idx + 1, 1, 1, lastCol).clearContent();
        removedCount++;
        Logger.log(`Cleared broken link row in "${sheet.getName()}" (was: ${link})`);
      }
    });
  });

  Logger.log(`Done. ${removedCount} broken Indeed link row(s) cleared.`);
  Logger.log('Next: run refreshAllFormatting() to tidy up New Leads (drops the now-blank rows on rebuild), then processJobAlerts() to re-fetch these jobs with working links (only if the original email is still within LOOKBACK_DAYS).');
}

// ==========================================================================
// DIAGNOSTIC — Indeed link detection
// ==========================================================================

function debugIndeedLinks() {
  const query = `from:${CONFIG.MARK_EMAIL} newer_than:${CONFIG.LOOKBACK_DAYS}d`;
  const threads = GmailApp.search(query);

  for (const thread of threads) {
    for (const msg of thread.getMessages()) {
      const html = msg.getBody();
      if (detectSource(html) !== 'Indeed') continue;

      const { text: emailText, linkMap } = prepareEmailForApi(html);
      const jobLinkCount = Object.keys(linkMap).length;
      Logger.log(`Indeed email found. JOBLINK markers detected: ${jobLinkCount}`);

      const hrefMatches = [...html.matchAll(/href="([^"]*indeed[^"]*)"/gi)]
        .map(m => m[1])
        .slice(0, 10);
      Logger.log(`Sample of raw hrefs containing "indeed" found in this email (first ${hrefMatches.length}):`);
      hrefMatches.forEach(h => Logger.log(h));
      return;
    }
  }
  Logger.log('No Indeed email found in the current lookback window.');
}

// ==========================================================================
// DIAGNOSTIC
// ==========================================================================

function debugListSheetNames() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ss.getSheets().forEach(sheet => {
    Logger.log(`[${sheet.getName()}]  (length: ${sheet.getName().length})`);
  });
  Logger.log('---');
  Logger.log('Expected working tab names:');
  ALL_TAB_NAMES.forEach(name => Logger.log(`[${name}]  (length: ${name.length})`));
}

// ==========================================================================
// ONE-OFF MIGRATION — v17 consultant tabs -> v18 New Leads
// ==========================================================================
// Run this ONCE after deploying v18. Pulls every job row out of the old
// per-consultant tabs, dedupes by Link (a North West job used to live in
// BOTH Craig's and Alison's tab — this collapses it back to one row), and
// rebuilds New Leads as a flat, newest-first list via the same
// rebuildNewLeadsTab() the daily run uses. Leaves the old tabs in place —
// delete Craig/Alison/Tom/Josh/Ray manually once New Leads looks right.
// Migrated rows get a blank Staff ID, same as any other pre-v19 row.

const OLD_CONSULTANT_TAB_NAMES = ['Craig', 'Alison', 'Tom', 'Josh', 'Ray'];

function migrateConsultantTabsToNewLeads() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const seenLinks = new Set();
  const migratedRows = [];

  OLD_CONSULTANT_TAB_NAMES.forEach(tabName => {
    const sheet = ss.getSheetByName(tabName);
    if (!sheet) {
      Logger.log(`${tabName}: sheet not found, skipping.`);
      return;
    }
    const lastRow = sheet.getLastRow();
    if (lastRow < 1) return;
    const numCols = TAB_HEADERS.length;
    const data = sheet.getRange(1, 1, lastRow, numCols).getValues();

    data.forEach(row => {
      const isHeaderRow = row.join('|') === TAB_HEADERS.join('|');
      const restBlank = row.slice(1).every(cell => cell === '' || cell === null);
      if (isHeaderRow || (restBlank && row[0])) return; // header or region heading row
      if (!row[5] || seenLinks.has(row[5])) return; // no link, or already pulled from another tab
      seenLinks.add(row[5]);
      migratedRows.push([...row, '']);
    });
  });

  const newLeadsSheet = getOrCreateSheet(ss, CONFIG.NEW_LEADS_SHEET_NAME);
  rebuildNewLeadsTab(newLeadsSheet, migratedRows);
  Logger.log(`Migrated ${migratedRows.length} unique job row(s) into ${CONFIG.NEW_LEADS_SHEET_NAME}.`);
  Logger.log('Old consultant tabs left untouched — delete Craig/Alison/Tom/Josh/Ray manually once New Leads looks correct.');
}

// ==========================================================================
// COMPANY BLOCKLIST / JOB TITLE BLOCKLIST
// ==========================================================================
// Single-column tabs: any company (or job title) listed here is
// force-filtered on every run, regardless of what the AI classifies it as.
// Matching is normalizeText() exact match — case and punctuation ignored,
// but the whole value must match. See the blocklist checks in
// processJobAlerts().

function loadBlocklist(sheet) {
  const lastRow = sheet.getLastRow();
  const blocked = new Set();
  if (lastRow < 2) return blocked;
  const data = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  data.forEach(row => {
    const value = String(row[0] || '').trim();
    if (value) blocked.add(normalizeText(value));
  });
  return blocked;
}

// ==========================================================================
// COMPANY REGIONS OVERRIDE
// ==========================================================================
// Two-column tab: Company | Region. A manually maintained override — if a
// company here produces a job the AI classified as "Other" (Remote/
// UK-wide, no real town), it gets redirected to the given Region instead.
// Only fires for action === 'route' && region === 'Other' — see the check
// in processJobAlerts().
//
// Invalid Region values (typos, "Other" itself, blank) are logged and
// skipped rather than causing a misroute or failing the run.

function loadCompanyRegions(sheet) {
  const lastRow = sheet.getLastRow();
  const overrides = new Map();
  if (lastRow < 2) return overrides;
  const data = sheet.getRange(2, 1, lastRow - 1, 2).getValues();
  data.forEach((row, idx) => {
    const company = String(row[0] || '').trim();
    const region = String(row[1] || '').trim();
    if (!company) return;
    if (!region || region === 'Other' || !REGIONS.includes(region)) {
      Logger.log(`Company Regions row ${idx + 2}: invalid Region "${region}" for company "${company}" — skipped. Must be one of: ${REGIONS.filter(r => r !== 'Other').join(', ')}.`);
      return;
    }
    overrides.set(normalizeText(company), region);
  });
  return overrides;
}

// ==========================================================================
// SHEET HELPERS
// ==========================================================================

function getOrCreateSheet(ss, name) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  return sheet;
}

// After inserting a new header row on migration, checks row 2 for a stale
// header row left behind (e.g. an old shorter header version) and clears
// it, instead of leaving it sitting there looking like a real job.
function ensureHeaders(sheet, headers) {
  const firstRow = sheet.getRange(1, 1, 1, headers.length).getValues()[0];
  const isEmpty = firstRow.every(cell => cell === '' || cell === null);
  const matches = firstRow.join('|') === headers.join('|');

  if (isEmpty) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    return;
  }
  if (matches) return;

  sheet.insertRowBefore(1);
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);

  // Guard: a real job row always has a Date object in the Date Found
  // column; a stale header row is all text. If row 2 matches that
  // pattern, it's leftover from the migration — clear it. Skipped for
  // single-column sheets (like the Blocklist) since there's no Date Found
  // column to check against.
  if (headers.length < 5) return;
  const row2 = sheet.getRange(2, 1, 1, headers.length).getValues()[0];
  const dateCol = row2[4];
  const looksLikeHeader = row2.every(cell => typeof cell === 'string' && cell !== '')
    && !(dateCol instanceof Date);
  if (looksLikeHeader) {
    sheet.getRange(2, 1, 1, headers.length).clearContent();
  }
}

// Shared normalizer: lowercases, strips punctuation, collapses whitespace.
// Used both for the composite job-dedup key and for Company / Job Title
// Blocklist matching, so "Acme Ltd." and "acme ltd" are always treated as
// the same.
function normalizeText(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Normalizes title/company/town into a single composite key used to catch
// the same underlying job resent under a different link (e.g. LinkedIn
// reposts/boosted listings). Deliberately exact-match rather than fuzzy,
// so genuinely different roles at the same company never get merged.
function normalizeJobKey(title, company, town) {
  return `${normalizeText(title)}|${normalizeText(company)}|${normalizeText(town)}`;
}

// Returns the Set of existing Links and the Set of existing
// title|company|town keys on a sheet, for dedup.
function loadExistingLinksAndKeys(sheet) {
  const lastRow = sheet.getLastRow();
  const links = new Set();
  const keys = new Set();
  if (lastRow < 1) return { links, keys };
  const data = sheet.getRange(1, 1, lastRow, 6).getValues(); // A:F — Source..Link
  data.forEach(row => {
    const title = row[1], company = row[2], town = row[3], link = row[5];
    if (link) links.add(link);
    if (title && company) keys.add(normalizeJobKey(title, company, town));
  });
  return { links, keys };
}

function formatDateColumn(sheet) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return;
  sheet.getRange(2, 5, lastRow - 1, 1).setNumberFormat('dd/mm/yyyy hh:mm');
}

function sortNewestFirst(sheet) {
  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();
  if (lastRow < 3) return;
  sheet.getRange(2, 1, lastRow - 1, lastCol).sort({ column: 5, ascending: false });
}

function autoResizeSheet(sheet) {
  const lastCol = sheet.getLastColumn();
  if (lastCol < 1) return;
  sheet.autoResizeColumns(1, lastCol);
  applyFixedLinkColumnWidth(sheet);
}

// Link is always column F (6) across every tab layout (New Leads, Other,
// Needs Review, Filtered Out). Auto-resize stretches it to fit
// full URLs, which makes it unreadable — fix it to a set width instead.
const LINK_COLUMN_WIDTH_PX = 150;
const LINK_COLUMN_INDEX = 6;

function applyFixedLinkColumnWidth(sheet) {
  if (sheet.getLastColumn() >= LINK_COLUMN_INDEX) {
    sheet.setColumnWidth(LINK_COLUMN_INDEX, LINK_COLUMN_WIDTH_PX);
    // Clip instead of overflow — otherwise a long URL visually bleeds into
    // empty neighboring columns and LOOKS like the column never resized,
    // even though its actual width is fixed correctly underneath.
    sheet.getRange(1, LINK_COLUMN_INDEX, sheet.getMaxRows(), 1)
      .setWrapStrategy(SpreadsheetApp.WrapStrategy.CLIP);
  }
}

// ==========================================================================
// EMAIL SOURCE DETECTION (unchanged)
// ==========================================================================

function detectSource(html) {
  if (/linkedin\.com/i.test(html) && /job alert/i.test(html)) return 'LinkedIn';
  if (/indeed\.com/i.test(html)) return 'Indeed';
  return null;
}

// ==========================================================================
// SHARED TEXT HELPERS
// ==========================================================================

function stripTags(html) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|td|tr|li)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&#8203;|\u200b/g, '')
    .replace(/͏/g, '')
    .trim();
}

function cleanText(str) { return str.replace(/\s+/g, ' ').trim(); }

function decodeHtmlEntities(str) {
  return str.replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"');
}

// ==========================================================================
// TORY COPY (unchanged)
// ==========================================================================

function sendCopyToTory() {
  if (!CONFIG.TORY_EMAIL) {
    Logger.log('CONFIG.TORY_EMAIL is not set — add Tory\'s email address before running this.');
    return;
  }
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const url = 'https://docs.google.com/spreadsheets/d/' + ss.getId() + '/export?format=xlsx';
  const token = ScriptApp.getOAuthToken();
  const response = UrlFetchApp.fetch(url, { headers: { 'Authorization': 'Bearer ' + token } });
  const blob = response.getBlob().setName(ss.getName() + '.xlsx');
  MailApp.sendEmail({
    to: CONFIG.TORY_EMAIL,
    subject: `Job Alerts Sheet — ${new Date().toLocaleDateString('en-GB')}`,
    body: 'Attached is the latest full copy of the job alerts workbook.',
    attachments: [blob]
  });
  Logger.log('Sent full workbook copy to Tory.');
}

// ==========================================================================
// TEST HELPER — dry run, logs API output, writes nothing
// ==========================================================================

function testParseLatestEmail() {
  const query = `from:${CONFIG.MARK_EMAIL} newer_than:${CONFIG.LOOKBACK_DAYS}d`;
  const threads = GmailApp.search(query);
  if (threads.length === 0) { Logger.log('No matching emails found.'); return; }

  const msg = threads[0].getMessages()[0];
  const html = msg.getBody();
  const source = detectSource(html);
  if (!source) { Logger.log('Could not detect source (LinkedIn/Indeed) for latest email.'); return; }

  const { text: emailText, linkMap } = prepareEmailForApi(html);
  Logger.log(`Source: ${source} | Prepared text length: ${emailText.length} chars | Job links found: ${Object.keys(linkMap).length}`);

  const jobs = callClaudeForJobs(emailText, source);
  if (jobs === null) { Logger.log('API call or JSON parsing failed — see warnings above.'); return; }

  Logger.log(`Jobs returned: ${jobs.length}`);
  jobs.forEach((j, i) => {
    const link = resolveJobLink(linkMap, j.link);
    if (j.action === 'route') {
      const tabs = (REGION_TO_TABS[j.region] || []).join(', ');
      const staffId = REGION_TO_STAFF_ID[j.region] || '(none)';
      Logger.log(`${i + 1}. ${j.title} | ${j.company} | ${j.town} | ${link} -> ROUTE [${j.region} -> ${tabs}, Staff ID ${staffId}]`);
    } else {
      const regionNote = j.action === 'filter' ? ` [region if unfiltered: ${j.region || '(none)'}]` : '';
      Logger.log(`${i + 1}. ${j.title} | ${j.company} | ${j.town} | ${link} -> ${j.action.toUpperCase()} (${j.reason})${regionNote}`);
    }
  });
}

// ==========================================================================
// DAILY SCHEDULE — process ~07:30, email the workbook ~08:30 (UK time)
// ==========================================================================
// Two time-based triggers:
//   processJobAlerts() ~07:30 — pulls the latest alerts into the sheet
//   runDailySend()     ~08:30 — emails the workbook (.xlsx) plus a link to the
//                                live sheet to RECIPIENT_EMAILS
// Google fires these within ±15 minutes of the set minute, so the two runs
// are always at least 30 minutes apart — far longer than processing takes
// (Apps Script stops any run after 6 minutes).
//
// The email is sent even if that morning's processing failed, with a
// warning in the subject and body, so a failure can't go unnoticed.
// processJobAlerts() records the date of its last successful run in
// Script Properties, and runDailySend() checks it.
//
// SETUP (once, from the Apps Script editor):
//   1. Run processJobAlerts(), then runDailySend(). The first run asks for
//      permission to send email; check the email arrives with today's data.
//   2. Run createDailyTriggers(). It deletes any existing schedule triggers
//      first — including the old processJobAlerts / dailyRunAndSend ones —
//      so running it again never leaves duplicates.
//   3. Run listAllTriggers() to confirm exactly two triggers exist.

const DAILY_SEND_CONFIG = {
  RECIPIENT_EMAILS: ['valeriiamuzhchyna@bcllegal.com', 'marklevine@bcllegal.com'],
  TIME_ZONE: 'Europe/London',
  PROCESS_HOUR: 7,
  PROCESS_MINUTE: 30,
  SEND_HOUR: 8,
  SEND_MINUTE: 30,
  SUBJECT_PREFIX: 'Job Alerts Sheet'
};

const LAST_PROCESSING_SUCCESS_KEY = 'LAST_PROCESSING_SUCCESS_DATE';

// Every handler any version of this script has scheduled, so a cleanup
// catches triggers left over from before v20.
const SCHEDULE_HANDLERS = ['processJobAlerts', 'runDailySend', 'dailyRunAndSend'];

function todayInSendTimeZone() {
  return Utilities.formatDate(new Date(), DAILY_SEND_CONFIG.TIME_ZONE, 'yyyy-MM-dd');
}

function runDailySend() {
  const lastSuccess = PropertiesService.getScriptProperties().getProperty(LAST_PROCESSING_SUCCESS_KEY);
  const warning = lastSuccess === todayInSendTimeZone()
    ? null
    : `this morning's processing run did not complete (last successful run: ${lastSuccess || 'never'}).`;
  sendSheetCopy(warning);
}

function sendSheetCopy(warning) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const dateStr = Utilities.formatDate(new Date(), DAILY_SEND_CONFIG.TIME_ZONE, 'dd/MM/yyyy');
  const recipients = DAILY_SEND_CONFIG.RECIPIENT_EMAILS.join(',');

  let blob;
  try {
    const url = 'https://docs.google.com/spreadsheets/d/' + ss.getId() + '/export?format=xlsx';
    const token = ScriptApp.getOAuthToken();
    const response = UrlFetchApp.fetch(url, {
      headers: { 'Authorization': 'Bearer ' + token },
      muteHttpExceptions: true
    });

    if (response.getResponseCode() !== 200) {
      Logger.log(`Spreadsheet export failed with status ${response.getResponseCode()} — nothing sent.`);
      return;
    }
    blob = response.getBlob().setName(`${ss.getName()} — ${dateStr}.xlsx`);
  } catch (err) {
    Logger.log(`Failed to export spreadsheet: ${err} — nothing sent.`);
    return;
  }

  // Viewer access so the live link opens for every recipient. Anyone who
  // already has edit access keeps it (addViewers never downgrades).
  try {
    ss.addViewers(DAILY_SEND_CONFIG.RECIPIENT_EMAILS);
  } catch (err) {
    Logger.log(`Couldn't share the sheet with the recipients (${err}) — the live link may not open for them until it's shared by hand.`);
  }

  const liveLink = `Live sheet (always up to date): ${ss.getUrl()}`;
  let body = `Attached is today's updated job alerts workbook.\n\n${liveLink}\n\nThis is an automated daily send.`;
  if (warning) {
    body = `WARNING: ${warning} This sheet may not include the latest listings.\n\n`
      + `The workbook is attached as it currently stands.\n\n${liveLink}`;
  }

  try {
    MailApp.sendEmail({
      to: recipients,
      subject: `${DAILY_SEND_CONFIG.SUBJECT_PREFIX} — ${dateStr}${warning ? ' (processing error)' : ''}`,
      body: body,
      attachments: [blob]
    });
    Logger.log(`Sent workbook to ${recipients} (${dateStr}).`);
  } catch (err) {
    Logger.log(`Failed to send email: ${err}`);
  }
}

// ==========================================================================
// SCHEDULE SETUP
// ==========================================================================

function createDailyTriggers() {
  const removed = deleteScheduleTriggers();
  if (removed > 0) Logger.log(`Removed ${removed} existing schedule trigger(s) before recreating.`);

  const c = DAILY_SEND_CONFIG;
  ScriptApp.newTrigger('processJobAlerts')
    .timeBased()
    .atHour(c.PROCESS_HOUR)
    .nearMinute(c.PROCESS_MINUTE)
    .everyDays(1)
    .inTimezone(c.TIME_ZONE)
    .create();
  ScriptApp.newTrigger('runDailySend')
    .timeBased()
    .atHour(c.SEND_HOUR)
    .nearMinute(c.SEND_MINUTE)
    .everyDays(1)
    .inTimezone(c.TIME_ZONE)
    .create();

  Logger.log(`Daily triggers created (${c.TIME_ZONE}): processing ~${c.PROCESS_HOUR}:${c.PROCESS_MINUTE}, send ~${c.SEND_HOUR}:${c.SEND_MINUTE} to ${c.RECIPIENT_EMAILS.join(', ')}.`);
}

// Turns off the automated daily processing and send without deleting code.
function removeDailyTriggers() {
  Logger.log(`Removed ${deleteScheduleTriggers()} trigger(s). Automated daily processing and send are now off.`);
}

function deleteScheduleTriggers() {
  const existing = ScriptApp.getProjectTriggers()
    .filter(t => SCHEDULE_HANDLERS.includes(t.getHandlerFunction()));
  existing.forEach(t => ScriptApp.deleteTrigger(t));
  return existing.length;
}

// ==========================================================================
// DIAGNOSTICS
// ==========================================================================

// Copying a Google Sheet copies the bound script but NOT its triggers, so a
// copy starts with none. Run this after setup to confirm exactly what's
// scheduled on this sheet's script.
function listAllTriggers() {
  const triggers = ScriptApp.getProjectTriggers();
  if (triggers.length === 0) {
    Logger.log('No triggers currently set on this script.');
    return;
  }
  Logger.log(`${triggers.length} trigger(s) on this script:`);
  triggers.forEach(t => Logger.log(`  - ${t.getHandlerFunction()} (${t.getEventType()})`));
}
