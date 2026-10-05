/**
 * JOB ALERT AUTOMATION v23
 * ------------------------------------------------------------
 * CHANGES FROM v22:
 *   - New Leads rows are forced to single-line height. Sheets grows a row to
 *     show every line of a multi-line cell regardless of wrap/clip, so
 *     LinkedIn descriptions were making rows very tall. The full text is
 *     still in the cell.
 *   - A failed Apify call now writes Apify's own error message into the
 *     FETCH FAILED cell (not "see logs"), and every collected run logs its
 *     status, result count and result field names.
 *   - Sponsored Indeed jobs now get descriptions too. Their links are
 *     ad-tracking redirects with no job ID, so they used to fail with "Indeed
 *     link has no job ID" (the earlier Apify test skipped them silently).
 *     resolveIndeedJobKeys() reads where each redirect points, without
 *     opening the blocked job page, to get the ID; the row's Link becomes
 *     the clean viewjob link and the job goes to Apify as normal.
 *
 * CHANGES FROM v21 (carried forward):
 *   - NEW "Job Description" column on New Leads (column G). Staff ID moves
 *     from G to H; existing rows are re-laid out automatically on the first
 *     run (ensureNewLeadsLayout()).
 *   - Descriptions are downloaded, never written by the AI:
 *       - LinkedIn: the public guest job page
 *         (jobs-guest/jobs/api/jobPosting/<id>), several in parallel.
 *       - Indeed: blocks direct downloads, so one Apify run
 *         (misceres~indeed-scraper) per batch, matched back by job ID (jk).
 *         Needs Script Property APIFY_TOKEN.
 *     Anything that can't be retrieved says "FETCH FAILED (reason)".
 *   - Only leads found in the last 7 days, and never before 3 Oct 2026, are
 *     filled (DESCRIPTION_CONFIG). FETCH FAILED cells are retried by the
 *     07:30 run while still inside that window.
 *   - Timeouts: Apify takes 1–3 minutes, so the 07:30 run starts it and
 *     moves on (cells say PENDING), and the 08:30 runDailySend() collects
 *     the results before exporting. Both runs stop starting new work near
 *     5 minutes (RUN_TIME_BUDGET_MS); leftovers are picked up next run.
 *   - Emails already processed are skipped (PROCESSED_MESSAGES_KEY), so each
 *     alert goes to Claude once instead of on every run of its 4-day window.
 *   - The daily email says how many recent leads have a description.
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
// Job Description and Staff ID after Link, so Date Found (E) and Link (F)
// stay put.
const TAB_HEADERS = ['Source', 'Job Title', 'Company', 'Town', 'Date Found', 'Link'];
const NEW_LEADS_HEADERS = [...TAB_HEADERS, 'Job Description', 'Staff ID'];
const NL_DESCRIPTION = 6; // 0-based index of Job Description (column G)
const NL_STAFF_ID = 7;    // 0-based index of Staff ID (column H)
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

// ---- Job descriptions ---------------------------------------------------------
const DESCRIPTION_CONFIG = {
  MAX_CHARS: 45000,     // a Sheets cell holds 50,000 characters at most
  FILL_DAYS: 7,         // fill leads found in the last 7 days...
  START_DATE: new Date('2026-10-03T00:00:00+01:00'), // ...but never ones found before 3 Oct 2026
  LINKEDIN_BATCH_SIZE: 5, // LinkedIn pages downloaded in parallel per batch
  APIFY_ACTOR: 'misceres~indeed-scraper',
  APIFY_API: 'https://api.apify.com/v2',
  APIFY_STALE_HOURS: 12,  // give up on an Apify run still unfinished after this long
  SEND_WAIT_SECONDS: 180  // longest the 08:30 send waits for an unfinished Apify run
};
const DESCRIPTION_PENDING = 'PENDING (Indeed description requested from Apify)';
const DESCRIPTION_FAILED = 'FETCH FAILED';
// Apify output field names vary between scraper versions; the first present wins.
const APIFY_DESCRIPTION_FIELDS = ['description', 'descriptionText', 'jobDescription', 'descriptionHTML', 'descriptionHtml'];
const APIFY_RUNS_KEY = 'APIFY_PENDING_RUNS';
const PROCESSED_MESSAGES_KEY = 'PROCESSED_MESSAGE_IDS';
const DAY_MS = 24 * 60 * 60 * 1000;

// Apps Script kills a run at 6 minutes. Each entry point resets the clock;
// work that can wait for the next run stops being started past these marks.
const RUN_TIME_BUDGET_MS = 5 * 60 * 1000;
const EMAIL_TIME_BUDGET_MS = 3.5 * 60 * 1000;
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
  const newLeadsSheet = tabSheets[CONFIG.NEW_LEADS_SHEET_NAME];
  // Before anything appends to New Leads, so every row uses the same layout.
  ensureNewLeadsLayout(newLeadsSheet);
  const lists = loadOverrideLists(ss);
  const { unfilterCompanies, companyRegionOverrides } = lists;

  // Runs before the dedup sets are loaded, so they reflect where rows ended up.
  applyListChanges(sheets, lists);
  runDescriptionStep(() => collectApifyRuns(newLeadsSheet, 0));

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

  let addedCount = 0, filteredCount = 0, reviewCount = 0, skippedEmails = 0, blockedCount = 0, blockedTitleCount = 0, companyRegionOverrideCount = 0, unfilteredCount = 0, deferredEmails = 0;

  // An email is only marked processed once all its jobs are handled, so one
  // that fails (AI error) or is left for time is picked up next run.
  const processed = loadProcessedMessages();

  threads.forEach(thread => {
    thread.getMessages().forEach(msg => {
      const msgId = msg.getId();
      if (processed[msgId]) return;
      if (Date.now() - runStartedAt > EMAIL_TIME_BUDGET_MS) { deferredEmails++; return; }

      const html = msg.getBody();
      const dateFound = msg.getDate();
      const source = detectSource(html);
      if (!source) { processed[msgId] = Date.now(); return; }

      const { text: emailText, linkMap } = prepareEmailForApi(html);
      if (!emailText || emailText.length < 20) { processed[msgId] = Date.now(); return; } // nothing worth sending

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
          // Job Description starts blank; fillJobDescriptions() fills it below.
          if (tabName === CONFIG.NEW_LEADS_SHEET_NAME) row.push('', REGION_TO_STAFF_ID[region]);
          newRowsByTab[tabName].push(row);
          touchedTabs.add(tabName);
          addedCount++;
        });
      });
      processed[msgId] = Date.now();
    });
  });

  REBUILD_TABS.forEach(tabName => {
    rebuildNewLeadsTab(tabSheets[tabName], newRowsByTab[tabName]);
  });

  runDescriptionStep(() => fillJobDescriptions(newLeadsSheet, true));

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

  saveProcessedMessages(processed);

  // Read by runDailySend() to warn if the morning run didn't complete.
  PropertiesService.getScriptProperties().setProperty(LAST_PROCESSING_SUCCESS_KEY, todayInSendTimeZone());

  Logger.log(`Done. ${addedCount} rows written (${companyRegionOverrideCount} redirected from Other via Company Regions, ${unfilteredCount} unfiltered via Unfilter Company). ${reviewCount} sent to Needs Review. ${filteredCount} filtered out (${blockedCount} due to Company Blocklist, ${blockedTitleCount} due to Job Title Blocklist). ${skippedEmails} email(s) skipped due to API/parse errors (retried next run).`
    + (deferredEmails ? ` ${deferredEmails} email(s) left for the next run to stay inside the time limit.` : ''));
}

// Emails already handled, as { messageId: timestampHandled }. Entries older
// than the Gmail lookback (plus margin) are dropped, since those emails no
// longer come back from the search anyway.
function loadProcessedMessages() {
  const raw = PropertiesService.getScriptProperties().getProperty(PROCESSED_MESSAGES_KEY);
  const all = raw ? JSON.parse(raw) : {};
  const cutoff = Date.now() - (CONFIG.LOOKBACK_DAYS + 2) * DAY_MS;
  const kept = {};
  Object.keys(all).forEach(id => { if (all[id] >= cutoff) kept[id] = all[id]; });
  return kept;
}

function saveProcessedMessages(processed) {
  // A Script Property holds ~9KB. If there are ever too many emails to fit,
  // forget the oldest — worst case those get re-read, and dedup catches them.
  const ids = Object.keys(processed).sort((a, b) => processed[b] - processed[a]);
  let json = JSON.stringify(processed);
  while (json.length > 8500 && ids.length) {
    delete processed[ids.pop()];
    json = JSON.stringify(processed);
  }
  PropertiesService.getScriptProperties().setProperty(PROCESSED_MESSAGES_KEY, json);
}

// Descriptions are extra information, never worth failing the main job or
// the daily email over: a failure here is logged and the rows are retried.
function runDescriptionStep(fn) {
  try {
    fn();
  } catch (err) {
    Logger.log(`Job description step failed — affected rows are retried on the next run: ${err}`);
  }
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
  // Job Description starts blank; fillJobDescriptions() fills it if recent.
  const toNewLeads = (r, region) => newLeads.appendRow([...r.slice(0, 6), '', REGION_TO_STAFF_ID[region]]);

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
  runStartedAt = Date.now();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheets = openWorkingSheets(ss);
  const newLeadsSheet = sheets.tabSheets[CONFIG.NEW_LEADS_SHEET_NAME];
  ensureNewLeadsLayout(newLeadsSheet);
  applyListChanges(sheets, loadOverrideLists(ss));
  REBUILD_TABS.forEach(tabName => rebuildNewLeadsTab(sheets.tabSheets[tabName], []));
  // Rows just moved into New Leads get their description now (LinkedIn) or
  // on the next collect (Indeed).
  runDescriptionStep(() => {
    collectApifyRuns(newLeadsSheet, 0);
    fillJobDescriptions(newLeadsSheet, false);
  });
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
  if (kept.length > 0) sheet.getRange(2, 1, kept.length, numCols).setValues(kept);
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
// rows with no Link are intentionally dropped. Every row is written in the
// current 8-column layout (NEW_LEADS_HEADERS). Older layouts are converted
// on read-back: v19–v21 had Staff ID in G and no Job Description; pre-v19
// rows had neither, so both stay blank.

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
    const staffIdInG = data[0][NL_DESCRIPTION] === 'Staff ID'; // v19–v21 header
    data.forEach(row => {
      // Compares only the first 6 cells so older headers (fewer or
      // differently ordered columns after F) are recognised too, rather than
      // being carried forward as a job row.
      const isHeaderRow = row.slice(0, TAB_HEADERS.length).join('|') === TAB_HEADERS.join('|');
      if (isHeaderRow || !row[5]) return;
      existingRows.push(staffIdInG ? [...row.slice(0, 6), '', row[NL_DESCRIPTION]] : row);
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
  // Read-back drops the apostrophe that keeps a description like "=..." from
  // becoming a formula, so it has to be re-applied on every rewrite.
  combined.forEach(row => { row[NL_DESCRIPTION] = safeCellText(row[NL_DESCRIPTION]); });

  sheet.clear();

  sheet.getRange(1, 1, 1, numCols).setValues([NEW_LEADS_HEADERS]).setFontWeight('bold');

  if (combined.length > 0) {
    const dataStartRow = 2;
    sheet.getRange(dataStartRow, 1, combined.length, numCols).setValues(combined);
    sheet.getRange(dataStartRow, 5, combined.length, 1).setNumberFormat('dd/mm/yyyy hh:mm');
    // Sheets grows a row to show every line of a multi-line cell, whatever
    // the wrap setting, so descriptions would make rows very tall. Forcing the
    // height keeps every lead on one line; the full text is still in the cell.
    sheet.setRowHeightsForced(dataStartRow, combined.length, NEW_LEADS_ROW_HEIGHT_PX);
  }

  // Auto-sizing the description column would stretch it to the longest
  // description, so it gets a fixed width and clipped text instead.
  sheet.autoResizeColumns(1, TAB_HEADERS.length);
  sheet.autoResizeColumns(NL_STAFF_ID + 1, 1);
  applyFixedLinkColumnWidth(sheet);
  sheet.setColumnWidth(NL_DESCRIPTION + 1, DESCRIPTION_COLUMN_WIDTH_PX);
  sheet.getRange(1, NL_DESCRIPTION + 1, sheet.getMaxRows(), 1).setWrapStrategy(SpreadsheetApp.WrapStrategy.CLIP);
}

const DESCRIPTION_COLUMN_WIDTH_PX = 300;
const NEW_LEADS_ROW_HEIGHT_PX = 21; // Sheets' default single-line row height

// New Leads in an older layout (Staff ID in G) is converted before anything
// appends rows to it, so new and old rows never end up mixed.
function ensureNewLeadsLayout(sheet) {
  const header = sheet.getRange(1, 1, 1, NEW_LEADS_HEADERS.length).getValues()[0];
  if (header.join('|') !== NEW_LEADS_HEADERS.join('|')) rebuildNewLeadsTab(sheet, []);
}

// A string starting with = + - or @ would be read by Sheets as a formula; the
// leading apostrophe stores it as plain text (and isn't shown or exported).
function safeCellText(value) {
  return typeof value === 'string' && /^[=+\-@]/.test(value) ? `'${value}` : value;
}

// ==========================================================================
// JOB DESCRIPTIONS — downloaded, never written by the AI
// ==========================================================================
// LinkedIn: the public guest job page has the full description; fetched
//   directly, several at a time.
// Indeed: blocks Apps Script (401/403), so one Apify scraper run per batch.
//   Apify takes 1–3 minutes, so a run is started and its jobs marked PENDING;
//   collectApifyRuns() fills them in later (start of the next 07:30 run, and
//   before the 08:30 send, which waits for it if needed). Started runs are
//   remembered in Script Properties (APIFY_RUNS_KEY).
// Anything that can't be retrieved says "FETCH FAILED (reason)". Only leads
// inside the fill window (inDescriptionWindow()) are ever fetched.

function inDescriptionWindow(dateFound) {
  return dateFound instanceof Date
    && dateFound >= DESCRIPTION_CONFIG.START_DATE
    && Date.now() - dateFound.getTime() <= DESCRIPTION_CONFIG.FILL_DAYS * DAY_MS;
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

// Fills the Job Description cell of New Leads rows inside the fill window
// that are blank — or, with retryFailed, say FETCH FAILED — plus any PENDING
// row whose Apify run is no longer being tracked. LinkedIn rows are fetched
// now; Indeed rows go into one new Apify run and are marked PENDING.
function fillJobDescriptions(sheet, retryFailed) {
  const rows = readRows(sheet);
  const trackedJks = new Set(loadApifyRuns().flatMap(run => run.jks));
  const updates = new Map(); // row index -> new cell text
  const linkedIn = [];
  const indeedRowsByJk = new Map();
  const sponsoredIndeed = []; // Indeed rows whose link has no job ID
  const queueIndeed = (i, jk) => {
    if (trackedJks.has(jk)) { updates.set(i, DESCRIPTION_PENDING); return; } // already in a running Apify run
    if (!indeedRowsByJk.has(jk)) indeedRowsByJk.set(jk, []);
    indeedRowsByJk.get(jk).push(i);
  };

  rows.forEach((row, i) => {
    if (!inDescriptionWindow(row[4])) return;
    const current = String(row[NL_DESCRIPTION] || '');
    const jk = indeedJobKey(row[5]);
    const needed = current === ''
      || (retryFailed && current.startsWith(DESCRIPTION_FAILED))
      || (current === DESCRIPTION_PENDING && !trackedJks.has(jk));
    if (!needed) return;

    if (linkedInJobId(row[5])) {
      linkedIn.push(i);
    } else if (jk) {
      queueIndeed(i, jk);
    } else if (/indeed\.com/i.test(String(row[5]))) {
      sponsoredIndeed.push(i);
    } else {
      updates.set(i, `${DESCRIPTION_FAILED} (no LinkedIn or Indeed job link)`);
    }
  });

  // LinkedIn in parallel batches. Rows left over when time runs short stay
  // blank and are fetched by the next run.
  const batchSize = DESCRIPTION_CONFIG.LINKEDIN_BATCH_SIZE;
  for (let b = 0; b < linkedIn.length; b += batchSize) {
    if (timeLeftMs() < 60 * 1000) {
      Logger.log(`${linkedIn.length - b} LinkedIn description(s) left for the next run to stay inside the time limit.`);
      break;
    }
    const batch = linkedIn.slice(b, b + batchSize);
    const texts = fetchLinkedInDescriptions(batch.map(i => rows[i][5]));
    batch.forEach((i, k) => updates.set(i, texts[k]));
  }

  // Sponsored Indeed links are ad-tracking redirects with no job ID in them.
  // Indeed's redirect points at the job page, which does carry the ID, so
  // read where it points (without following it to the blocked page). The
  // row's Link is replaced with the clean job link, so the Apify result can
  // be matched back to it and the CRM gets a link that doesn't expire.
  const linkUpdates = new Map(); // row index -> clean Indeed job link
  if (sponsoredIndeed.length && timeLeftMs() >= 60 * 1000) {
    const resolved = resolveIndeedJobKeys(sponsoredIndeed.map(i => rows[i][5]));
    sponsoredIndeed.forEach((i, k) => {
      const r = resolved[k];
      if (!r.jk) { updates.set(i, `${DESCRIPTION_FAILED} (${r.reason})`); return; }
      linkUpdates.set(i, indeedViewUrl(r.jk));
      queueIndeed(i, r.jk);
    });
  }

  if (indeedRowsByJk.size > 0) {
    const started = startApifyRun([...indeedRowsByJk.keys()]);
    const text = started.error ? `${DESCRIPTION_FAILED} (${started.error})` : DESCRIPTION_PENDING;
    indeedRowsByJk.forEach(indexes => indexes.forEach(i => updates.set(i, text)));
  }

  linkUpdates.forEach((link, i) => sheet.getRange(i + 2, 6).setValue(link));
  writeDescriptions(sheet, updates);
}

// For Indeed links with no job ID (sponsored ad-tracking links), reads each
// redirect's destination — up to 3 hops, never downloading the job page
// itself, which Indeed blocks — and returns [{ jk } or { reason }] in order.
function resolveIndeedJobKeys(links) {
  const current = links.slice();
  const results = links.map(() => null);
  for (let hop = 0; hop < 3; hop++) {
    const open = current.map((url, k) => k).filter(k => !results[k]);
    if (!open.length) break;
    const responses = fetchAllSafely(open.map(k => ({ url: current[k], followRedirects: false, muteHttpExceptions: true })), 'Indeed redirect');
    open.forEach((k, n) => {
      const res = responses[n];
      if (!res) { results[k] = { reason: 'Indeed sponsored link could not be opened — see logs' }; return; }
      const code = res.getResponseCode();
      const headers = res.getAllHeaders();
      let next = String(headers.Location || headers.location || '');
      if (next.startsWith('/')) next = `https://uk.indeed.com${next}`;
      if (code >= 300 && code < 400 && next) {
        const jk = indeedJobKey(next);
        if (jk) results[k] = { jk: jk };
        else if (/indeed\.com/i.test(next)) current[k] = next; // another Indeed redirect — follow it
        else results[k] = { reason: "Indeed sponsored link goes to the employer's own site, not an Indeed job page" };
      } else {
        const inBody = code === 200 ? res.getContentText().match(/[?&]v?jk=([0-9a-f]{16})/) : null;
        results[k] = inBody ? { jk: inBody[1] } : { reason: `Indeed sponsored link has no job ID, and Indeed returned status ${code} when it was opened` };
      }
    });
  }
  return results.map(r => r || { reason: 'Indeed sponsored link has no job ID (too many redirects)' });
}

// UrlFetchApp.fetchAll throws if any one request fails outright, so on
// failure retry one by one; a request that still fails comes back as null.
function fetchAllSafely(requests, label) {
  try {
    return UrlFetchApp.fetchAll(requests);
  } catch (err) {
    return requests.map(req => {
      try {
        return UrlFetchApp.fetch(req.url, req);
      } catch (e) {
        Logger.log(`${label} request failed for ${req.url}: ${e}`);
        return null;
      }
    });
  }
}

function writeDescriptions(sheet, updates) {
  updates.forEach((text, i) => {
    sheet.getRange(i + 2, NL_DESCRIPTION + 1).setValue(safeCellText(text));
  });
}

// ---- LinkedIn ----

function fetchLinkedInDescriptions(links) {
  const requests = links.map(link => ({
    url: `https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${linkedInJobId(link)}`,
    muteHttpExceptions: true,
    followRedirects: true
  }));
  return fetchAllSafely(requests, 'LinkedIn download').map(linkedInDescriptionFromResponse);
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

// ---- Indeed via Apify ----

function loadApifyRuns() {
  const raw = PropertiesService.getScriptProperties().getProperty(APIFY_RUNS_KEY);
  return raw ? JSON.parse(raw) : [];
}

function saveApifyRuns(runs) {
  PropertiesService.getScriptProperties().setProperty(APIFY_RUNS_KEY, JSON.stringify(runs));
}

function indeedViewUrl(jk) {
  return `https://uk.indeed.com/viewjob?jk=${jk}`;
}

// Starts one scraper run for all the given Indeed job IDs and remembers it.
// Returns {} or { error }.
function startApifyRun(jks) {
  const token = PropertiesService.getScriptProperties().getProperty('APIFY_TOKEN');
  if (!token) return { error: 'APIFY_TOKEN not set in Script Properties' };
  const res = apifyRequest(token, 'post', `/acts/${DESCRIPTION_CONFIG.APIFY_ACTOR}/runs`, {
    startUrls: jks.map(jk => ({ url: indeedViewUrl(jk) })),
    maxItems: jks.length
  });
  if (res.error) return res;
  const runs = loadApifyRuns();
  runs.push({ runId: res.data.id, datasetId: res.data.defaultDatasetId, jks: jks, startedAt: Date.now() });
  saveApifyRuns(runs);
  Logger.log(`Apify run ${res.data.id} started for ${jks.length} Indeed job(s).`);
  return {};
}

// Writes the results of every finished Apify run into the PENDING rows they
// belong to. Waits up to maxWaitMs for runs still going; runs that are still
// going after that stay tracked for the next collect.
function collectApifyRuns(sheet, maxWaitMs) {
  const runs = loadApifyRuns();
  if (runs.length === 0) return;
  const token = PropertiesService.getScriptProperties().getProperty('APIFY_TOKEN');
  const deadline = Date.now() + Math.max(0, maxWaitMs);
  const results = new Map(); // jk -> cell text
  const stillRunning = [];
  runs.forEach(run => {
    const outcome = finishApifyRun(token, run, deadline);
    if (outcome === null) stillRunning.push(run);
    else outcome.forEach((text, jk) => results.set(jk, text));
  });
  saveApifyRuns(stillRunning);
  if (results.size === 0) return;

  const updates = new Map();
  readRows(sheet).forEach((row, i) => {
    const jk = indeedJobKey(row[5]);
    if (row[NL_DESCRIPTION] === DESCRIPTION_PENDING && results.has(jk)) updates.set(i, results.get(jk));
  });
  writeDescriptions(sheet, updates);
  Logger.log(`Apify results written for ${updates.size} Indeed lead(s)${stillRunning.length ? `; ${stillRunning.length} run(s) still going` : ''}.`);
}

// Returns Map(jk -> cell text) once the run has finished (or has to be given
// up on), or null if it's still going and should be checked again later.
function finishApifyRun(token, run, deadline) {
  const failAll = reason => new Map(run.jks.map(jk => [jk, `${DESCRIPTION_FAILED} (${reason})`]));
  if (!token) return failAll('APIFY_TOKEN not set in Script Properties');
  const stale = Date.now() - run.startedAt > DESCRIPTION_CONFIG.APIFY_STALE_HOURS * 60 * 60 * 1000;

  const res = apifyRunItems(token, run, deadline);
  if (res === null) {
    return stale ? failAll(`Apify run still unfinished after ${DESCRIPTION_CONFIG.APIFY_STALE_HOURS} hours`) : null;
  }
  if (res.error) return stale ? failAll(res.error) : null;
  const status = res.status;
  const list = res.items;
  const runNote = status === 'SUCCEEDED' ? '' : `; Apify run ${status}`;
  Logger.log(`Apify run ${run.runId} ${status}: ${list.length} result(s) for ${run.jks.length} job(s).`
    + (list.length ? ` Fields in first result: ${Object.keys(list[0]).join(', ')}` : ''));

  return new Map(run.jks.map(jk => {
    // The field holding the job ID varies, so match on the whole result.
    const item = list.find(it => JSON.stringify(it).indexOf(jk) !== -1);
    if (!item) return [jk, `${DESCRIPTION_FAILED} (Apify returned no result for this job${runNote})`];
    const field = APIFY_DESCRIPTION_FIELDS.find(name => item[name]);
    if (!field) return [jk, `${DESCRIPTION_FAILED} (Apify result had no description)`];
    const value = item[field];
    const html = typeof value === 'object' ? (value.html || value.text || JSON.stringify(value)) : value;
    return [jk, finishDescription(descriptionHtmlToText(html), 'Indeed')];
  }));
}

// Waits (until deadline, within the run's time budget) for an Apify run to
// finish, then reads its results. Returns { status, items }, { error }, or
// null if it's still going.
function apifyRunItems(token, run, deadline) {
  const unfinished = s => s === 'READY' || s === 'RUNNING';
  let status = 'RUNNING';
  do {
    // waitForFinish holds the request open (max 45s, inside UrlFetchApp's limit).
    const wait = Math.max(0, Math.min(45, Math.floor((deadline - Date.now()) / 1000)));
    const poll = apifyRequest(token, 'get', `/actor-runs/${run.runId}?waitForFinish=${wait}`);
    if (poll.error) return { error: poll.error };
    status = poll.data.status;
  } while (unfinished(status) && Date.now() < deadline && timeLeftMs() > 60 * 1000);
  if (unfinished(status)) return null;

  // A failed or timed-out run may still have scraped some jobs, so read what's there.
  const items = apifyRequest(token, 'get', `/datasets/${run.datasetId}/items?clean=true&format=json`);
  if (items.error) return { error: items.error };
  return { status: status, items: Array.isArray(items.data) ? items.data : [] };
}

// Calls the Apify API. Returns { data } or { error } (details logged).
// Run endpoints wrap their payload in { data }, dataset items are a bare array.
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
    // 401 = bad token; 402/403 usually = out of credit, the scraper's free
    // trial has ended, or it hasn't been added to the Apify account yet.
    // Apify's own message goes into the cell so the cause is visible there.
    Logger.log(`Apify returned status ${code} for ${path}: ${body.substring(0, 500)}`);
    let message = '';
    try { message = JSON.parse(body).error.message || ''; } catch (e) { message = body; }
    return { error: `Apify returned status ${code}: ${String(message).substring(0, 150)}` };
  }
  try {
    const parsed = JSON.parse(body);
    return { data: Array.isArray(parsed) ? parsed : parsed.data };
  } catch (err) {
    Logger.log(`Couldn't read Apify response for ${path}: ${err}`);
    return { error: 'Unreadable Apify response — see logs' };
  }
}

// ---- Manual tools + email summary ----

// Run by hand to fill descriptions straight away (e.g. the first time),
// waiting for Apify where needed. Doesn't fetch new emails.
function fillJobDescriptionsNow() {
  runStartedAt = Date.now();
  const sheet = getOrCreateSheet(SpreadsheetApp.getActiveSpreadsheet(), CONFIG.NEW_LEADS_SHEET_NAME);
  ensureNewLeadsLayout(sheet);
  collectApifyRuns(sheet, 0);
  fillJobDescriptions(sheet, true);
  collectApifyRuns(sheet, Math.min(DESCRIPTION_CONFIG.SEND_WAIT_SECONDS * 1000, timeLeftMs() - 30 * 1000));
  Logger.log(descriptionStatusLine(sheet) || 'No leads inside the description window.');
}

// Dry run for the Apify route (not yet confirmed on a real run): sends up to
// three Indeed leads from New Leads to Apify, logs what comes back, and
// writes nothing to the sheet.
function debugIndeedDescriptions() {
  runStartedAt = Date.now();
  const token = PropertiesService.getScriptProperties().getProperty('APIFY_TOKEN');
  if (!token) { Logger.log('APIFY_TOKEN not set in Script Properties.'); return; }
  const sheet = getOrCreateSheet(SpreadsheetApp.getActiveSpreadsheet(), CONFIG.NEW_LEADS_SHEET_NAME);
  const jks = [...new Set(readRows(sheet).map(r => indeedJobKey(r[5])).filter(Boolean))].slice(0, 3);
  if (!jks.length) { Logger.log('No Indeed leads with a job ID in New Leads.'); return; }

  const start = apifyRequest(token, 'post', `/acts/${DESCRIPTION_CONFIG.APIFY_ACTOR}/runs`, {
    startUrls: jks.map(jk => ({ url: indeedViewUrl(jk) })), maxItems: jks.length
  });
  if (start.error) { Logger.log(`Couldn't start Apify: ${start.error}`); return; }
  const run = { runId: start.data.id, datasetId: start.data.defaultDatasetId, jks: jks, startedAt: Date.now() };
  Logger.log(`Apify run ${run.runId} started for: ${jks.join(', ')}. Waiting...`);

  const results = finishApifyRun(token, run, Date.now() + 240 * 1000);
  if (results === null) { Logger.log(`Run ${run.runId} still going — check it in the Apify console.`); return; }
  const items = apifyRequest(token, 'get', `/datasets/${run.datasetId}/items?clean=true&format=json`);
  if (items.data && items.data.length) Logger.log(`Fields in first result: ${Object.keys(items.data[0]).join(', ')}`);
  results.forEach((text, jk) => Logger.log(`${indeedViewUrl(jk)}\n  -> ${text.substring(0, 300)}`));
}

// One-off experiment for sponsored Indeed jobs, whose ad links carry no job
// ID and which Indeed won't open (403), even via Apify. Searching Indeed via
// Apify does find them, so this compares three ways of searching on up to
// three sponsored leads from New Leads, all run side by side, and logs which
// finds each job. Writes nothing to the sheet; costs well under £1.
//   company+town   — the company's name, in the job's town
//   title+town     — the job title (minus any bracketed extras), in the town
//   title+company  — both together, anywhere in the UK
// A match is "exact" if company and title match after normalising case and
// punctuation, "loose" if they still match ignoring Ltd/Limited/PLC/LLP and
// bracketed extras, or one title contains the other.
function debugSponsoredIndeed() {
  runStartedAt = Date.now();
  const token = PropertiesService.getScriptProperties().getProperty('APIFY_TOKEN');
  if (!token) { Logger.log('APIFY_TOKEN not set in Script Properties.'); return; }
  const sheet = getOrCreateSheet(SpreadsheetApp.getActiveSpreadsheet(), CONFIG.NEW_LEADS_SHEET_NAME);
  const leads = readRows(sheet).filter(r => /indeed\.com\/pagead\//i.test(String(r[5]))).slice(0, 3);
  if (!leads.length) { Logger.log('No sponsored Indeed leads (pagead links) in New Leads.'); return; }
  leads.forEach((r, i) => Logger.log(`Lead ${i + 1}: ${r[1]} | ${r[2]} | ${r[3]}`));

  const pick = (item, names) => { const n = names.find(k => item[k]); return n ? String(item[n]) : ''; };
  const titleOf = item => pick(item, ['positionName', 'title', 'jobTitle', 'displayTitle']);
  const companyOf = item => pick(item, ['company', 'companyName', 'employer']);
  const descLength = item => { const f = APIFY_DESCRIPTION_FIELDS.find(k => item[k]); return f ? String(item[f]).length : 0; };
  const shortTitle = t => String(t).replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
  const looseCompany = c => normalizeText(c).replace(/\b(ltd|limited|plc|llp|inc)\b/g, '').replace(/\s+/g, ' ').trim();
  const looseTitle = t => normalizeText(shortTitle(t));
  const town = r => (/remote|uk-?wide|nationwide|united kingdom/i.test(String(r[3])) ? '' : String(r[3] || ''));
  const search = (q, l) => `https://uk.indeed.com/jobs?q=${encodeURIComponent(q)}${l ? `&l=${encodeURIComponent(l)}` : ''}`;

  const variants = [
    { name: 'company+town', url: r => search(r[2], town(r)) },
    { name: 'title+town', url: r => search(shortTitle(r[1]), town(r)) },
    { name: 'title+company', url: r => search(`${shortTitle(r[1])} ${r[2]}`, '') }
  ];
  variants.forEach(v => {
    const urls = leads.map(v.url);
    const res = apifyRequest(token, 'post', `/acts/${DESCRIPTION_CONFIG.APIFY_ACTOR}/runs`, { startUrls: urls.map(u => ({ url: u })), maxItems: leads.length * 15 });
    if (res.error) { Logger.log(`${v.name}: couldn't start Apify — ${res.error}`); return; }
    v.run = { runId: res.data.id, datasetId: res.data.defaultDatasetId };
    Logger.log(`${v.name}: Apify run ${v.run.runId} started. Searches: ${urls.join(' , ')}`);
  });

  const deadline = Date.now() + 240 * 1000;
  variants.filter(v => v.run).forEach(v => {
    const res = apifyRunItems(token, v.run, deadline);
    if (!res) { Logger.log(`${v.name}: still running after 4 minutes — check it in the Apify console.`); return; }
    if (res.error) { Logger.log(`${v.name}: ${res.error}`); return; }
    Logger.log(`${v.name}: run ${res.status}, ${res.items.length} result(s).`);
    leads.forEach((r, i) => {
      const exact = res.items.find(it => normalizeText(titleOf(it)) === normalizeText(r[1]) && normalizeText(companyOf(it)) === normalizeText(r[2]));
      const sameCompany = res.items.filter(it => looseCompany(companyOf(it)) === looseCompany(r[2]));
      const loose = sameCompany.find(it => {
        const a = looseTitle(titleOf(it)), b = looseTitle(r[1]);
        return a === b || (a && b && (a.includes(b) || b.includes(a)));
      });
      const outcome = exact ? `EXACT match, description ${descLength(exact)} chars`
        : loose ? `LOOSE match "${titleOf(loose)} | ${companyOf(loose)}", description ${descLength(loose)} chars`
        : `no match (${sameCompany.length} result(s) from the same company${sameCompany.length ? `: ${sameCompany.slice(0, 3).map(titleOf).join(' / ')}` : ''})`;
      Logger.log(`${v.name} — lead ${i + 1}: ${outcome}`);
    });
  });
}

// One line for the daily email about leads inside the description window.
function descriptionStatusLine(sheet) {
  const recent = readRows(sheet).filter(r => inDescriptionWindow(r[4]));
  if (!recent.length) return '';
  let filled = 0, pending = 0, failed = 0, blank = 0;
  recent.forEach(r => {
    const d = String(r[NL_DESCRIPTION] || '');
    if (d === '') blank++;
    else if (d === DESCRIPTION_PENDING) pending++;
    else if (d.startsWith(DESCRIPTION_FAILED)) failed++;
    else filled++;
  });
  let line = `Job descriptions for leads from the last ${DESCRIPTION_CONFIG.FILL_DAYS} days: ${filled} of ${recent.length} filled`;
  if (pending) line += `, ${pending} still pending from Indeed (filled on the next run)`;
  if (failed) line += `, ${failed} couldn't be retrieved (marked FETCH FAILED)`;
  if (blank) line += `, ${blank} not fetched yet`;
  return line + '.';
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
// Migrated rows get a blank Job Description and Staff ID, like any pre-v19 row.

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
      migratedRows.push([...row, '', '']);
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
// Job descriptions are split across the two runs to stay inside Apps
// Script's 6-minute limit: the 07:30 run fills LinkedIn and starts Apify for
// Indeed; runDailySend() collects the Indeed results (waiting up to
// SEND_WAIT_SECONDS if needed) before it exports.
//
// SETUP (once, from the Apps Script editor):
//   0. Project Settings > Script Properties: add APIFY_TOKEN (Apify >
//      Settings > API & Integrations), and click "Try for free" on the
//      misceres~indeed-scraper page in Apify.
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
  runStartedAt = Date.now();
  const lastSuccess = PropertiesService.getScriptProperties().getProperty(LAST_PROCESSING_SUCCESS_KEY);
  const warning = lastSuccess === todayInSendTimeZone()
    ? null
    : `this morning's processing run did not complete (last successful run: ${lastSuccess || 'never'}).`;

  // Finish descriptions before exporting: collect the Indeed results the 07:30
  // run asked Apify for (waiting if it's somehow still going), and fetch any
  // that are still blank. Never allowed to stop the email going out.
  let descriptionNote = '';
  try {
    const sheet = getOrCreateSheet(SpreadsheetApp.getActiveSpreadsheet(), CONFIG.NEW_LEADS_SHEET_NAME);
    ensureNewLeadsLayout(sheet);
    fillJobDescriptions(sheet, false);
    // Leaves ~90s of the time budget for the export and send.
    collectApifyRuns(sheet, Math.min(DESCRIPTION_CONFIG.SEND_WAIT_SECONDS * 1000, timeLeftMs() - 90 * 1000));
    descriptionNote = descriptionStatusLine(sheet);
  } catch (err) {
    Logger.log(`Job description step failed before the send: ${err}`);
    descriptionNote = 'Job descriptions: the description step failed this morning (see the script log), so some may be missing.';
  }
  // Writes from this run must be saved before the export reads the sheet.
  SpreadsheetApp.flush();
  sendSheetCopy(warning, descriptionNote);
}

function sendSheetCopy(warning, descriptionNote) {
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
  const note = descriptionNote ? `\n\n${descriptionNote}` : '';
  let body = `Attached is today's updated job alerts workbook.${note}\n\n${liveLink}\n\nThis is an automated daily send.`;
  if (warning) {
    body = `WARNING: ${warning} This sheet may not include the latest listings.\n\n`
      + `The workbook is attached as it currently stands.${note}\n\n${liveLink}`;
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
