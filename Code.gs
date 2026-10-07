/**
 * JOB ALERT AUTOMATION v24
 * ------------------------------------------------------------
 * CHANGES FROM v21 (v22 and v23 were abandoned; this is v21 plus job
 * descriptions, built afresh. The old versions are in git history):
 *   - NEW "Job Description" column on New Leads, column H, after Staff ID.
 *     Columns A–G are unchanged, so the CRM import mapping still works.
 *   - Descriptions are downloaded, never written by the AI, for the rows
 *     each run adds to New Leads from the emails (found on or after 5 Oct
 *     2026, DESCRIPTION_CONFIG.START_DATE), all in the same run:
 *       - LinkedIn: LinkedIn's public job page (no API, no Apify, no AI).
 *       - Indeed (ordinary jobs, with a job ID in the link): Apify's Indeed
 *         scraper (misceres~indeed-scraper; Script Property APIFY_TOKEN).
 *         Started as soon as each Indeed email's new leads are known, so it
 *         runs while the remaining emails are processed, then collected
 *         before the run ends.
 *       - Indeed sponsored jobs (ad links, no job ID): not fetched; the
 *         cell says "No description (sponsored Indeed ad)". Apify's Indeed
 *         scraper rejects ad links and Indeed blocks Apps Script.
 *     Anything that can't be retrieved says "FETCH FAILED (reason)".
 *   - Apps Script stops a run at 6 minutes, so descriptions use only the
 *     time left (RUN_TIME_BUDGET_MS); an Apify run that hasn't finished by
 *     then is stopped (so it isn't charged further) and its leads are marked
 *     FETCH FAILED. New leads are written to the sheet BEFORE descriptions
 *     are fetched, so a description problem can never lose a lead.
 *   - The description column has a fixed width with clipped text, and New
 *     Leads rows are forced to one line high, so the tab stays neat however
 *     long a description is. The cell holds the full text (up to 45,000
 *     characters), which goes into the .xlsx / CRM import.
 *
 * CHANGES FROM v20 (carried forward):
 *   - List changes now apply to rows ALREADY in the sheet, not just to new
 *     jobs. At the start of every processJobAlerts() run (and on demand via
 *     applyListsNow()), applyListChanges() re-checks existing rows:
 *       - Company Blocklist / Job Title Blocklist: matching rows in New
 *         Leads, Other and Needs Review move to Filtered Out.
 *       - Unfilter Company: rows in Filtered Out that the AI filtered (not
 *         the blocklists) move out. Filtered Out stores no region, so one
 *         batched AI call places their towns; they then route as normal
 *         (New Leads + Staff ID, or Other / Needs Review). If that AI call
 *         fails, they stay put and are retried next run.
 *       - Company Regions: matching rows in Other move to New Leads with
 *         that region's Staff ID. Rows already in New Leads are left alone.
 *   - Moved rows leave their old tab — each job is in exactly one tab. This
 *     replaces v20's "rescued job skips the Filtered Out dedup and keeps
 *     its old row" behaviour.
 *   - Removing an entry from a list does NOT move rows back; it only stops
 *     future jobs being affected.
 *   - The region rules in the prompt are now one shared REGION_RULES block,
 *     used by both the job-extraction prompt and the new region lookup.
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
// Staff ID (G) and Job Description (H) appended at the end, so Date Found (E)
// and Link (F) stay put. New Leads feeds the CRM import: new columns go at
// the end, never in between.
const TAB_HEADERS = ['Source', 'Job Title', 'Company', 'Town', 'Date Found', 'Link'];
const NEW_LEADS_HEADERS = [...TAB_HEADERS, 'Staff ID', 'Job Description'];
const NL_STAFF_ID = 6;    // 0-based index of Staff ID (column G)
const NL_DESCRIPTION = 7; // 0-based index of Job Description (column H)
const REVIEW_HEADERS = ['Source', 'Job Title', 'Company', 'Town', 'Date Found', 'Link', 'Reason'];
const FILTERED_HEADERS = ['Source', 'Job Title', 'Company', 'Town', 'Date Found', 'Link', 'Filtered Reason'];
const BLOCKLIST_HEADERS = ['Company'];
const TITLE_BLOCKLIST_HEADERS = ['Job Title'];
const UNFILTER_HEADERS = ['Company'];

// Dorset towns BCL treats as Southern Home Counties rather than South West.
// Mirrors the prompt's exception; applied in code when the AI says South West.
const SOUTHERN_HOME_COUNTIES_TOWNS = /\b(bournemouth|poole|christchurch)\b/i;
const COMPANY_REGIONS_HEADERS = ['Company', 'Region'];

// Filtered Out / Needs Review reasons the script writes itself. Rows filtered
// for a blocklist reason are never unfiltered by Unfilter Company, which only
// reverses the AI's own decision.
const REASON_COMPANY_BLOCKLIST = 'Company on blocklist';
const REASON_TITLE_BLOCKLIST = 'Job title on blocklist';
const REASON_UNFILTER_NO_REGION = 'Unfilter Company, but AI gave no usable region';

// ---- Job descriptions (New Leads column H) ------------------------------------
const DESCRIPTION_CONFIG = {
  // Leads found before this are never given a description (left blank), so
  // the first run doesn't reach back into jobs from before descriptions began.
  START_DATE: new Date('2026-10-05T00:00:00+01:00'),
  MAX_CHARS: 45000,          // a Sheets cell holds 50,000 characters at most
  LINKEDIN_BATCH_SIZE: 5,    // LinkedIn pages downloaded in parallel per batch
  APIFY_ACTOR: 'misceres~indeed-scraper',
  APIFY_API: 'https://api.apify.com/v2',
  COLUMN_WIDTH_PX: 300,      // fixed width of the description column
  ROW_HEIGHT_PX: 21          // Sheets' default single-line row height
};
const DESCRIPTION_FAILED = 'FETCH FAILED';
const DESCRIPTION_SPONSORED = 'No description (sponsored Indeed ad)';
// Apify output field names vary between scraper versions; the first present wins.
const APIFY_DESCRIPTION_FIELDS = ['description', 'descriptionText', 'jobDescription', 'descriptionHTML', 'descriptionHtml'];

// Apps Script stops a run at 6 minutes. Description work only uses the time
// left before RUN_TIME_BUDGET_MS, so the run always finishes cleanly.
const RUN_TIME_BUDGET_MS = 5 * 60 * 1000;
let runStartedAt = Date.now();
function timeLeftMs() { return RUN_TIME_BUDGET_MS - (Date.now() - runStartedAt); }

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
  runStartedAt = Date.now();
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  const sheets = openWorkingSheets(ss);
  const { tabSheets, reviewSheet, filteredSheet } = sheets;
  const lists = loadOverrideLists(ss);
  const { unfilterCompanies, companyRegionOverrides } = lists;

  // Runs before the dedup sets are loaded, so they reflect where rows ended up.
  applyListChanges(sheets, lists);

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

  // Indeed scraper runs started during the email loop (see startIndeedDescriptions()).
  const indeedRuns = [];

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
      const newLeadsBefore = newRowsByTab[CONFIG.NEW_LEADS_SHEET_NAME].length;

      jobs.forEach(job => {
        if (!job || !job.title || !job.company || !job.action) return;

        // Unfilter Company reverses the AI's own "filter" so the job routes
        // as normal, using the region the AI still gives for filtered jobs.
        // Runs before the blocklists so those manual lists still win.
        const aiFilteredUnfilterCompany = job.action === 'filter' && unfilterCompanies.has(normalizeText(job.company));
        if (aiFilteredUnfilterCompany) {
          job.action = 'route';
          job.reason = REASON_UNFILTER_NO_REGION;
        }

        // Code-level blocklist enforcement — overrides whatever the AI
        // decided. A blocklisted company is ALWAYS filtered, regardless
        // of whether the AI recognised it as an agency/law firm/etc.
        // Job Title Blocklist works the same way; only checked when the
        // company isn't already blocked, so each job counts once.
        const blockReason = blocklistReason(job.company, job.title, lists);
        if (blockReason) {
          job.action = 'filter';
          job.reason = blockReason;
          if (blockReason === REASON_COMPANY_BLOCKLIST) blockedCount++;
          else blockedTitleCount++;
        }

        if (aiFilteredUnfilterCompany && job.action === 'route') unfilteredCount++;

        if (job.action === 'route') job.region = applyTownRegionRules(job.region, job.town);

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
        // Out / Needs Review is never reprocessed here. Jobs that should
        // leave Filtered Out because of a list change are moved by
        // applyListChanges() at the start of the run instead.
        if (link && (filteredLinks.has(link) || reviewLinks.has(link))) return;
        if (filteredKeys.has(jobKey) || reviewKeys.has(jobKey)) return;

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
          if (tabName === CONFIG.NEW_LEADS_SHEET_NAME) row.push(REGION_TO_STAFF_ID[region], ''); // description filled after the rebuild
          newRowsByTab[tabName].push(row);
          touchedTabs.add(tabName);
          addedCount++;
        });
      });

      // Start Apify for this email's new Indeed leads now, so it works while
      // the remaining emails go through the AI.
      if (source === 'Indeed') {
        const newLinks = newRowsByTab[CONFIG.NEW_LEADS_SHEET_NAME].slice(newLeadsBefore).filter(wantsDescription).map(r => r[5]);
        runDescriptionStep('starting Indeed descriptions', () => startIndeedDescriptions(newLinks, indeedRuns));
      }
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

  // Read by runDailySend() to warn if the morning run didn't complete. Set
  // before descriptions: the leads are saved, and description problems
  // are caught and logged, never treated as a failed run.
  PropertiesService.getScriptProperties().setProperty(LAST_PROCESSING_SUCCESS_KEY, todayInSendTimeZone());

  const newLeadLinks = newRowsByTab[CONFIG.NEW_LEADS_SHEET_NAME].filter(wantsDescription).map(r => r[5]);
  runDescriptionStep('filling job descriptions', () => fillJobDescriptions(tabSheets[CONFIG.NEW_LEADS_SHEET_NAME], newLeadLinks, indeedRuns));

  Logger.log(`Done. ${addedCount} rows written (${companyRegionOverrideCount} redirected from Other via Company Regions, ${unfilteredCount} unfiltered via Unfilter Company). ${reviewCount} sent to Needs Review. ${filteredCount} filtered out (${blockedCount} due to Company Blocklist, ${blockedTitleCount} due to Job Title Blocklist). ${skippedEmails} email(s) skipped due to API/parse errors.`);
}

// ==========================================================================
// SHEETS + OVERRIDE LISTS
// ==========================================================================

function openWorkingSheets(ss) {
  const tabSheets = {};
  ALL_TAB_NAMES.forEach(tabName => { tabSheets[tabName] = getOrCreateSheet(ss, tabName); });
  FLAT_TABS.forEach(tabName => ensureHeaders(tabSheets[tabName], TAB_HEADERS));
  const reviewSheet = getOrCreateSheet(ss, CONFIG.NEEDS_REVIEW_SHEET_NAME);
  ensureHeaders(reviewSheet, REVIEW_HEADERS);
  const filteredSheet = getOrCreateSheet(ss, CONFIG.FILTERED_SHEET_NAME);
  ensureHeaders(filteredSheet, FILTERED_HEADERS);
  return { tabSheets, reviewSheet, filteredSheet };
}

function loadOverrideLists(ss) {
  const listSheet = (name, headers) => {
    const sheet = getOrCreateSheet(ss, name);
    ensureHeaders(sheet, headers);
    return sheet;
  };
  return {
    blockedCompanies: loadBlocklist(listSheet(CONFIG.BLOCKLIST_SHEET_NAME, BLOCKLIST_HEADERS)),
    blockedTitles: loadBlocklist(listSheet(CONFIG.TITLE_BLOCKLIST_SHEET_NAME, TITLE_BLOCKLIST_HEADERS)),
    unfilterCompanies: loadBlocklist(listSheet(CONFIG.UNFILTER_SHEET_NAME, UNFILTER_HEADERS)),
    companyRegionOverrides: loadCompanyRegions(listSheet(CONFIG.COMPANY_REGIONS_SHEET_NAME, COMPANY_REGIONS_HEADERS))
  };
}

// The Filtered Out reason if a company/title is on a blocklist, else null.
// Company is checked first so each job is counted against one list only.
function blocklistReason(company, title, lists) {
  if (lists.blockedCompanies.has(normalizeText(company))) return REASON_COMPANY_BLOCKLIST;
  if (lists.blockedTitles.has(normalizeText(title))) return REASON_TITLE_BLOCKLIST;
  return null;
}

// Region exceptions enforced in code on top of the AI's answer.
function applyTownRegionRules(region, town) {
  if (region === 'South West' && SOUTHERN_HOME_COUNTIES_TOWNS.test(town || '')) return 'Southern Home Counties';
  return region;
}

// ==========================================================================
// LIST CHANGES — re-apply the override lists to rows already in the sheet
// ==========================================================================
// Runs at the start of every processJobAlerts(), and on demand via
// applyListsNow(). Moves rows so the sheet reflects the lists as they are
// now, not as they were when each job first arrived:
//   1. Company / Job Title Blocklist: matching rows in New Leads, Other and
//      Needs Review move to Filtered Out.
//   2. Unfilter Company: rows in Filtered Out that the AI filtered (not the
//      blocklists) move out. Filtered Out stores no region, so
//      lookupRegionsForRows() asks the AI to place them; then they route as
//      normal. If that lookup fails they stay put and are retried next run.
//   3. Company Regions: matching rows in Other move to New Leads with the
//      region's Staff ID (run last, so it also catches step 2's Other rows).
// A moved row leaves its old tab. Removing an entry from a list moves
// nothing back — it only stops future jobs being affected.

function applyListChanges(sheets, lists) {
  const newLeads = sheets.tabSheets[CONFIG.NEW_LEADS_SHEET_NAME];
  const other = sheets.tabSheets[CONFIG.OTHER_SHEET_NAME];
  const review = sheets.reviewSheet;
  const filtered = sheets.filteredSheet;
  const toNewLeads = (r, region) => newLeads.appendRow([...r.slice(0, 6), REGION_TO_STAFF_ID[region]]);

  // 1. Blocklists
  let blocked = 0;
  [newLeads, other, review].forEach(sheet => {
    takeRows(sheet, r => blocklistReason(r[2], r[1], lists) !== null).forEach(r => {
      filtered.appendRow([...r.slice(0, 6), blocklistReason(r[2], r[1], lists)]);
      blocked++;
    });
  });

  // 2. Unfilter Company
  let unfiltered = 0, unfilterPending = 0;
  const isUnfilterRow = r =>
    lists.unfilterCompanies.has(normalizeText(r[2]))
    && r[6] !== REASON_COMPANY_BLOCKLIST && r[6] !== REASON_TITLE_BLOCKLIST
    && blocklistReason(r[2], r[1], lists) === null;
  const unfilterRows = readRows(filtered).filter(isUnfilterRow);
  if (unfilterRows.length > 0) {
    const regions = lookupRegionsForRows(unfilterRows);
    if (regions === null) {
      unfilterPending = unfilterRows.length;
    } else {
      takeRows(filtered, isUnfilterRow);
      unfilterRows.forEach((r, i) => {
        const region = applyTownRegionRules(regions[i], r[3]);
        if (region === 'Other') other.appendRow(r.slice(0, 6));
        else if (REGION_TO_STAFF_ID[region]) toNewLeads(r, region);
        else review.appendRow([...r.slice(0, 6), REASON_UNFILTER_NO_REGION]);
        unfiltered++;
      });
    }
  }

  // 3. Company Regions
  let redirected = 0;
  takeRows(other, r => lists.companyRegionOverrides.has(normalizeText(r[2]))).forEach(r => {
    toNewLeads(r, lists.companyRegionOverrides.get(normalizeText(r[2])));
    redirected++;
  });

  if (blocked || unfiltered || unfilterPending || redirected) {
    Logger.log(`List changes applied to existing rows: ${blocked} moved to Filtered Out (blocklists), ${unfiltered} moved out of Filtered Out (Unfilter Company), ${redirected} moved from Other to New Leads (Company Regions).`
      + (unfilterPending ? ` ${unfilterPending} Unfilter Company row(s) left in Filtered Out because the AI region lookup failed — retried next run.` : ''));
  }
}

// Run by hand after editing a list to apply it straight away, without
// waiting for the next daily run. Doesn't fetch any new emails.
function applyListsNow() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheets = openWorkingSheets(ss);
  applyListChanges(sheets, loadOverrideLists(ss));
  REBUILD_TABS.forEach(tabName => rebuildNewLeadsTab(sheets.tabSheets[tabName], []));
  [...FLAT_TABS.map(t => sheets.tabSheets[t]), sheets.reviewSheet, sheets.filteredSheet].forEach(sheet => {
    formatDateColumn(sheet);
    sortNewestFirst(sheet);
    autoResizeSheet(sheet);
  });
  Logger.log('Done. Lists applied to existing rows.');
}

// Data rows (below the header) of a tab that has a single header row.
function readRows(sheet) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  return sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();
}

// Removes the data rows matching `predicate` from the tab, keeping the rest
// in order, and returns the removed rows.
function takeRows(sheet, predicate) {
  const rows = readRows(sheet);
  const taken = rows.filter(predicate);
  if (taken.length === 0) return [];
  const kept = rows.filter(r => !predicate(r));
  const numCols = rows[0].length;
  sheet.getRange(2, 1, rows.length, numCols).clearContent();
  if (kept.length > 0) sheet.getRange(2, 1, kept.length, numCols).setValues(kept.map(r => r.map(safeCellText)));
  return taken;
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
  return callClaude(buildPrompt(emailText, source));
}

// Sends one prompt to Claude and returns the JSON array it replies with, or
// null on any failure (already logged), so callers can skip and retry later.
function callClaude(prompt) {
  const apiKey = PropertiesService.getScriptProperties().getProperty('CLAUDE_API_KEY');
  if (!apiKey) {
    Logger.log('CLAUDE_API_KEY not set in Script Properties — skipping this AI call. Project Settings > Script Properties > add CLAUDE_API_KEY.');
    return null;
  }

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

// Shared by the job-extraction prompt and the region lookup, so the region
// rules (and their exceptions) only live in one place.
const REGION_RULES = `Assign the town/location to exactly one region from this list, using this guidance:
- Scotland, North East, Yorkshire, North West, West Midlands, East Midlands, London, South West, Ireland — standard UK regions/postcode areas
- East Anglia — Norfolk, Suffolk, Cambridgeshire, Essex only (e.g. Cambridge, Norwich, Ipswich, Chelmsford, Colchester, Ely)
  - EXCEPTION: Peterborough is classified as East Midlands, NOT East Anglia, even though it sits in Cambridgeshire. Always route Peterborough to East Midlands.
- Northern Home Counties — Oxfordshire, Buckinghamshire, Bedfordshire, Hertfordshire (e.g. Oxford, Milton Keynes, Luton, St Albans, Watford)
- Southern Home Counties — Surrey, Kent, Sussex, Hampshire, Berkshire (e.g. Reading, Guildford, Brighton, Southampton, Portsmouth)
  - EXCEPTION: Bournemouth, Poole and Christchurch are classified as Southern Home Counties, NOT South West, even though they sit in Dorset. Always route them to Southern Home Counties.
- Other — use this confidently for: Remote, UK-wide, Nationwide, Work From Home, "United Kingdom", or any listing where the location is clearly national/non-specific rather than tied to a real town.`;

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
${REGION_RULES}
Listings that fit the Other rule should always be routed to Other, never sent to review.

If the town is genuinely ambiguous, unrecognisable, or missing in a way that ISN'T covered by the Other rule above, use action "review" with a reason instead of guessing.

Respond with ONLY the JSON array. No markdown code fences, no commentary, no explanation before or after.

EMAIL TEXT:
${emailText}`;
}

// Places existing sheet rows ([source, title, company, town, ...]) in a
// region, for rows that never had one stored (e.g. Filtered Out). Returns an
// array of regions in row order ('' where the AI couldn't place it), or null
// if any AI call failed — callers leave those rows alone and retry next run.
const REGION_LOOKUP_BATCH_SIZE = 50;

function lookupRegionsForRows(rows) {
  const regions = [];
  for (let start = 0; start < rows.length; start += REGION_LOOKUP_BATCH_SIZE) {
    const batch = rows.slice(start, start + REGION_LOOKUP_BATCH_SIZE);
    const listings = batch
      .map((r, i) => `${i + 1}. Job title: ${r[1]} | Company: ${r[2]} | Location: ${r[3] || '(not shown)'}`)
      .join('\n');
    const result = callClaude(`You are assigning UK job listings for a legal recruitment company (BCL Legal) to regions.

For each numbered listing below, return a JSON array with one object per listing: {"id": <the listing's number>, "region": <string>}.
"region" must be exactly one of: ${REGIONS.join(', ')} — or an empty string if the location is missing, ambiguous or unrecognisable in a way the Other rule doesn't cover.

${REGION_RULES}

Respond with ONLY the JSON array. No markdown code fences, no commentary.

LISTINGS:
${listings}`);
    if (result === null) return null;

    const batchRegions = batch.map(() => '');
    result.forEach(item => {
      const idx = Number(item && item.id) - 1;
      if (idx >= 0 && idx < batch.length && REGIONS.includes(item.region)) batchRegions[idx] = item.region;
    });
    regions.push(...batchRegions);
  }
  return regions;
}

// ==========================================================================
// NEW LEADS REBUILD
// ==========================================================================
// Full read-clear-rewrite: reads back existing rows, merges in this run's
// new rows, dedupes by Link, sorts newest-first and rewrites the tab. Job
// rows with no Link are intentionally dropped. Every row is written with
// NEW_LEADS_HEADERS' 8 columns; older rows read back with a blank Staff ID
// (before v19) or Job Description (before v24) and keep it.

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
    // Reading back drops the apostrophe that keeps formula-like text as text, so it's re-applied.
    sheet.getRange(dataStartRow, 1, combined.length, numCols).setValues(combined.map(r => r.map(safeCellText)));
    sheet.getRange(dataStartRow, 5, combined.length, 1).setNumberFormat('dd/mm/yyyy hh:mm');
  }
  formatNewLeadsLayout(sheet);
}

// Keeps New Leads neat whatever is in the description column: A–G sized to
// fit, Link (F) and Job Description (H) at a fixed width with clipped text,
// and every row one line high. (Sheets grows a row to show every line of a
// multi-line cell regardless of the wrap setting, so the height is forced.)
function formatNewLeadsLayout(sheet) {
  sheet.autoResizeColumns(1, NL_STAFF_ID + 1);
  applyFixedLinkColumnWidth(sheet);
  sheet.setColumnWidth(NL_DESCRIPTION + 1, DESCRIPTION_CONFIG.COLUMN_WIDTH_PX);
  sheet.getRange(1, NL_DESCRIPTION + 1, sheet.getMaxRows(), 1).setWrapStrategy(SpreadsheetApp.WrapStrategy.CLIP);
  if (sheet.getLastRow() >= 2) sheet.setRowHeightsForced(2, sheet.getLastRow() - 1, DESCRIPTION_CONFIG.ROW_HEIGHT_PX);
}

// A string starting with = + - or @ would be read by Sheets as a formula; the
// leading apostrophe stores it as plain text (and isn't shown or exported).
function safeCellText(value) {
  return typeof value === 'string' && /^[=+\-@]/.test(value) ? `'${value}` : value;
}

// ==========================================================================
// JOB DESCRIPTIONS — downloaded, never written by the AI
// ==========================================================================
// For the rows a run adds to New Leads from the emails, in that same run:
// - LinkedIn: the public guest job page has the full description; fetched
//   directly, several at a time. (Claude's own web fetch is blocked by
//   LinkedIn, so it isn't used.)
// - Indeed, ordinary jobs (job ID "jk" in the link): Indeed blocks Apps
//   Script, so Apify's Indeed scraper fetches them. One scraper run per
//   Indeed email is started during the email loop (startIndeedDescriptions())
//   and collected at the end (fillJobDescriptions()), so the 1–3 minutes it
//   takes overlap with the rest of the run.
// - Indeed, sponsored jobs (pagead ad links, no job ID): not fetched — the
//   scraper rejects ad links. The cell says DESCRIPTION_SPONSORED.
// Anything that can't be retrieved says "FETCH FAILED (reason)", never a
// guess. Rows moved into New Leads by applyListChanges() aren't fetched, and
// neither are leads found before DESCRIPTION_CONFIG.START_DATE (5 Oct 2026).

// True for a New Leads row found on/after DESCRIPTION_CONFIG.START_DATE.
// Earlier rows keep a blank description.
function wantsDescription(row) {
  return row[4] instanceof Date && row[4] >= DESCRIPTION_CONFIG.START_DATE;
}

// Runs a description step so that any failure is logged and can never stop
// processJobAlerts() — the leads themselves are already saved.
function runDescriptionStep(label, fn) {
  try {
    fn();
  } catch (err) {
    Logger.log(`Job descriptions: error while ${label} (leads are unaffected): ${err && err.stack ? err.stack : err}`);
  }
}

function linkedInJobId(link) {
  const m = String(link || '').match(/linkedin\.com\/(?:comm\/)?jobs\/view\/(?:[^\/?#]*-)?(\d+)/i);
  return m ? m[1] : null;
}

function indeedJobKey(link) {
  const s = String(link || '');
  if (!/indeed\.com/i.test(s)) return null;
  const m = s.match(/[?&]v?jk=([^&#]+)/);
  return m ? m[1] : null;
}

function indeedViewUrl(jk) {
  return `https://uk.indeed.com/viewjob?jk=${jk}`;
}

// Starts one Apify Indeed scraper run for these new leads' ordinary Indeed
// jobs and adds it to `indeedRuns` (or adds the reason it couldn't start).
function startIndeedDescriptions(links, indeedRuns) {
  const jks = [...new Set(links.map(indeedJobKey).filter(Boolean))];
  if (jks.length === 0) return;
  const token = PropertiesService.getScriptProperties().getProperty('APIFY_TOKEN');
  if (!token) { indeedRuns.push({ jks: jks, error: 'APIFY_TOKEN not set in Script Properties' }); return; }
  const secondsLeft = Math.floor(timeLeftMs() / 1000);
  if (secondsLeft < 90) { indeedRuns.push({ jks: jks, error: 'not enough time left in this run to ask Apify' }); return; }

  // Apify's own timeout stops (and stops charging for) the run if this script can't wait for it.
  const res = apifyRequest(token, 'post', `/acts/${DESCRIPTION_CONFIG.APIFY_ACTOR}/runs?timeout=${secondsLeft}`, {
    startUrls: jks.map(jk => ({ url: indeedViewUrl(jk) })),
    maxItems: jks.length
  });
  if (res.error) { indeedRuns.push({ jks: jks, error: res.error }); return; }
  indeedRuns.push({ jks: jks, runId: res.data.id, datasetId: res.data.defaultDatasetId });
  Logger.log(`Apify run ${res.data.id} started for ${jks.length} Indeed job(s).`);
}

// Fetches and writes the descriptions for this run's new New Leads rows
// (identified by Link), collecting the Indeed runs started earlier.
function fillJobDescriptions(sheet, newLinks, indeedRuns) {
  if (newLinks.length === 0) return;
  const results = new Map(); // link -> cell text
  const linkedIn = [];
  newLinks.forEach(link => {
    if (linkedInJobId(link)) linkedIn.push(link);
    else if (indeedJobKey(link)) return; // from Apify, below
    else if (/indeed\.com/i.test(String(link))) results.set(link, DESCRIPTION_SPONSORED);
    else results.set(link, `${DESCRIPTION_FAILED} (no LinkedIn or Indeed job link)`);
  });

  // LinkedIn, a few pages at a time, while there's time left.
  for (let i = 0; i < linkedIn.length; i += DESCRIPTION_CONFIG.LINKEDIN_BATCH_SIZE) {
    const batch = linkedIn.slice(i, i + DESCRIPTION_CONFIG.LINKEDIN_BATCH_SIZE);
    if (timeLeftMs() < 60 * 1000) {
      batch.forEach(link => results.set(link, `${DESCRIPTION_FAILED} (run out of time)`));
      continue;
    }
    fetchLinkedInDescriptions(batch).forEach((text, k) => results.set(batch[k], text));
  }

  // Indeed: wait for the Apify runs, leaving 30s to write everything.
  const token = PropertiesService.getScriptProperties().getProperty('APIFY_TOKEN');
  const deadline = Date.now() + Math.max(0, timeLeftMs() - 30 * 1000);
  const indeedTexts = new Map(); // jk -> cell text
  indeedRuns.forEach(run => {
    const texts = run.error
      ? new Map(run.jks.map(jk => [jk, `${DESCRIPTION_FAILED} (Indeed: ${run.error})`]))
      : collectIndeedRun(token, run, deadline);
    texts.forEach((text, jk) => indeedTexts.set(jk, text));
  });
  newLinks.forEach(link => {
    const jk = indeedJobKey(link);
    if (jk) results.set(link, indeedTexts.get(jk) || `${DESCRIPTION_FAILED} (Indeed: not sent to Apify — see logs)`);
  });

  writeDescriptions(sheet, results);

  const texts = [...results.values()];
  const failed = texts.filter(t => String(t).startsWith(DESCRIPTION_FAILED)).length;
  const sponsored = texts.filter(t => t === DESCRIPTION_SPONSORED).length;
  Logger.log(`Job descriptions: ${texts.length - failed - sponsored} filled, ${sponsored} sponsored Indeed (skipped), ${failed} FETCH FAILED.`);
}

// Writes cell texts into New Leads column H for the rows with these links,
// in one write. Only fills cells that are still blank.
function writeDescriptions(sheet, results) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2 || results.size === 0) return;
  const links = sheet.getRange(2, 6, lastRow - 1, 1).getValues();
  const column = sheet.getRange(2, NL_DESCRIPTION + 1, lastRow - 1, 1).getValues();
  let changed = false;
  links.forEach((cell, i) => {
    const text = results.get(cell[0]);
    if (text !== undefined && column[i][0] === '') { column[i][0] = text; changed = true; }
  });
  if (changed) sheet.getRange(2, NL_DESCRIPTION + 1, lastRow - 1, 1).setValues(column.map(r => r.map(safeCellText)));
  formatNewLeadsLayout(sheet);
}

// ---- LinkedIn ----

function fetchLinkedInDescriptions(links) {
  const requests = links.map(link => ({
    url: `https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${linkedInJobId(link)}`,
    muteHttpExceptions: true,
    followRedirects: true
  }));
  let responses;
  try {
    responses = UrlFetchApp.fetchAll(requests);
  } catch (err) {
    // fetchAll throws if any one request fails outright, so retry one by one.
    responses = requests.map(req => {
      try {
        return UrlFetchApp.fetch(req.url, req);
      } catch (e) {
        Logger.log(`LinkedIn download failed for ${req.url}: ${e}`);
        return null;
      }
    });
  }
  return responses.map(linkedInDescriptionFromResponse);
}

function linkedInDescriptionFromResponse(response) {
  if (!response) return `${DESCRIPTION_FAILED} (LinkedIn download error — see logs)`;
  const code = response.getResponseCode();
  if (code !== 200) return `${DESCRIPTION_FAILED} (LinkedIn returned status ${code})`;
  const block = divContents(response.getContentText(), /show-more-less-html__markup/);
  if (block === null) return `${DESCRIPTION_FAILED} (no description on the LinkedIn page — likely a block or login page)`;
  return finishDescription(descriptionHtmlToText(block), 'LinkedIn');
}

// Inner HTML of the first <div> whose opening tag matches marker, counting
// nested <div>s so the whole block is kept (a non-greedy regex would stop at
// the first inner </div>). null if the marker isn't on the page.
function divContents(html, marker) {
  const m = marker.exec(html);
  if (!m) return null;
  const start = html.indexOf('>', m.index) + 1;
  const divTag = /<(\/?)div\b[^>]*>/gi;
  divTag.lastIndex = start;
  let depth = 1, tag;
  while ((tag = divTag.exec(html))) {
    depth += tag[1] ? -1 : 1;
    if (depth === 0) return html.substring(start, tag.index);
  }
  return html.substring(start);
}

// ---- Indeed via Apify ----

// Waits (until deadline) for an Apify run and returns Map(jk -> cell text).
// A run still going at the deadline is aborted, so it isn't charged further.
function collectIndeedRun(token, run, deadline) {
  const failAll = reason => new Map(run.jks.map(jk => [jk, `${DESCRIPTION_FAILED} (Indeed: ${reason})`]));
  let status = 'RUNNING';
  while (status === 'READY' || status === 'RUNNING') {
    const wait = Math.floor((deadline - Date.now()) / 1000);
    if (wait <= 0) break;
    // waitForFinish holds the request open until the run ends (max 45s, inside UrlFetchApp's limit).
    const poll = apifyRequest(token, 'get', `/actor-runs/${run.runId}?waitForFinish=${Math.min(45, wait)}`);
    if (poll.error) return failAll(poll.error);
    status = poll.data.status;
  }
  if (status === 'READY' || status === 'RUNNING') {
    apifyRequest(token, 'post', `/actor-runs/${run.runId}/abort`);
    Logger.log(`Apify run ${run.runId} didn't finish in time and was stopped.`);
    return failAll('Apify didn\'t finish within this run\'s time limit');
  }

  // A failed or timed-out run may still have scraped some jobs, so read what's there.
  const res = apifyRequest(token, 'get', `/datasets/${run.datasetId}/items?clean=true&format=json`);
  if (res.error) return failAll(res.error);
  const items = Array.isArray(res.data) ? res.data : [];
  Logger.log(`Apify run ${run.runId} ${status}: ${items.length} result(s) for ${run.jks.length} job(s).`
    + (items.length ? ` Fields in first result: ${Object.keys(items[0]).join(', ')}` : ''));
  const runNote = status === 'SUCCEEDED' ? '' : `; Apify run ${status}`;

  return new Map(run.jks.map(jk => {
    // The field holding the job ID varies, so match on the whole result.
    const item = items.find(it => JSON.stringify(it).indexOf(jk) !== -1);
    if (!item) return [jk, `${DESCRIPTION_FAILED} (Indeed: Apify returned no result for this job${runNote})`];
    const field = APIFY_DESCRIPTION_FIELDS.find(name => item[name]);
    if (!field) return [jk, `${DESCRIPTION_FAILED} (Indeed: Apify's result had no description)`];
    const value = item[field];
    const html = typeof value === 'object' ? (value.html || value.text || JSON.stringify(value)) : value;
    return [jk, finishDescription(descriptionHtmlToText(html), 'Indeed')];
  }));
}

// Calls the Apify API. Returns { data } or { error } with Apify's own
// message (full reply logged). Run endpoints wrap their payload in { data };
// dataset items are a bare array.
function apifyRequest(token, method, path, payload) {
  const options = { method: method, headers: { Authorization: `Bearer ${token}` }, muteHttpExceptions: true };
  if (payload) {
    options.contentType = 'application/json';
    options.payload = JSON.stringify(payload);
  }
  let response;
  try {
    response = UrlFetchApp.fetch(DESCRIPTION_CONFIG.APIFY_API + path, options);
  } catch (err) {
    Logger.log(`Apify request failed (${path}): ${err}`);
    return { error: `Apify request failed: ${String(err).substring(0, 150)}` };
  }
  const code = response.getResponseCode();
  const body = response.getContentText();
  if (code < 200 || code >= 300) {
    // 401 = bad token; 402/403 usually = out of credit or a permissions problem.
    Logger.log(`Apify returned status ${code} for ${path}: ${body.substring(0, 500)}`);
    let message = body;
    try { message = JSON.parse(body).error.message || body; } catch (e) { /* keep the raw reply */ }
    return { error: `Apify returned status ${code}: ${String(message).substring(0, 150)}` };
  }
  try {
    const parsed = JSON.parse(body);
    return { data: Array.isArray(parsed) ? parsed : parsed.data };
  } catch (err) {
    Logger.log(`Couldn't read Apify response for ${path}: ${err}`);
    return { error: 'unreadable reply from Apify — see logs' };
  }
}

// ---- Shared ----

// HTML to readable text, keeping bullets and line breaks. Plain-text input
// (some Apify results) passes through apart from tidying.
function descriptionHtmlToText(html) {
  return String(html)
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
    .replace(/[​͏]/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

function finishDescription(text, site) {
  if (text.length < 50) return `${DESCRIPTION_FAILED} (${site} description was empty)`;
  if (text.length > DESCRIPTION_CONFIG.MAX_CHARS) text = text.substring(0, DESCRIPTION_CONFIG.MAX_CHARS) + ' …(truncated)';
  return text;
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
      migratedRows.push([...row, '', '']); // blank Staff ID and Job Description
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
