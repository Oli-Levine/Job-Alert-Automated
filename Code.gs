/**
 * JOB ALERT AUTOMATION v18
 * ------------------------------------------------------------
 * CHANGES FROM v17:
 *   - REMOVED the 5 per-consultant tabs (Craig, Alison, Tom, Josh, Ray).
 *     Every job that used to route to a consultant tab now writes to a
 *     single flat "New Leads" tab instead — no Consultant column, no
 *     Region column, no section headings, sorted newest-first.
 *   - A region that used to fan out to two consultant tabs (North West ->
 *     Craig AND Alison) now collapses to exactly one row in New Leads,
 *     since REGION_TO_TABS maps every non-"Other" region to the same
 *     single target tab.
 *   - Dedup (composite title+company+town key), the 30-day resurfacing
 *     window, and the 84-day retention purge all now run against New
 *     Leads as a single tab instead of being split per-consultant.
 *   - New Leads keeps the resurfacing behaviour consultant tabs had
 *     (bold + amber HIGH_PRIORITY_BG on a job that reappears after
 *     RESURFACE_WINDOW_DAYS, old link dropped, carried forward across
 *     rebuilds) via a new rebuildNewLeadsTab() — a flat version of the
 *     old rebuildConsultantTab() with the region-sectioning removed.
 *     This is different from Other's simpler always-append pattern,
 *     which New Leads deliberately does NOT use.
 *   - Company Blocklist, Company Regions, Needs Review, Filtered Out,
 *     and Other are untouched — same schema, same logic.
 *   - Added migrateConsultantTabsToNewLeads(), a one-off migration to
 *     pull existing rows out of the old consultant tabs (deduped by
 *     Link) into New Leads. Run it once after deploying v18; it leaves
 *     the old tabs in place for you to delete manually once New Leads
 *     looks right.
 *
 * CHANGES FROM v16 (carried forward):
 *   - NEW "Company Regions" tab added: Company | Region. A manually
 *     maintained override list — if a company on this list produces a
 *     job the AI classified as region "Other" (i.e. Remote/UK-wide
 *     listings with no real town), that job gets rerouted to the
 *     Region you've locked in for that company instead of landing in
 *     Other.
 *   - Scoped deliberately narrow: the override ONLY fires when
 *     job.region === 'Other'. A job from the same company with a real,
 *     AI-classified town is left completely alone — this can never
 *     hijack a normally-routed job, it only resolves the ambiguous
 *     "Other" case.
 *   - The job's Town field is NOT overwritten — it still shows whatever
 *     the email said (e.g. "Remote"), exactly as before. Only the
 *     destination (region/tab) changes.
 *   - Runs after the blocklist check, so a blocklisted company is
 *     already filtered before this logic is ever reached — no
 *     conflict-handling needed between the two lists.
 *   - Invalid Region values in the tab (typos, "Other" itself, etc.) are
 *     logged as a warning and that row is skipped — never causes a
 *     misroute or a failed run.
 *   - Company Regions is a standing reference list, like Company
 *     Blocklist — NOT subject to the 84-day purge.
 */

const CONFIG = {
  MARK_EMAIL: 'marklevine@bcllegal.com',
  NEW_LEADS_SHEET_NAME: 'New Leads',
  NEEDS_REVIEW_SHEET_NAME: 'Needs Review',
  FILTERED_SHEET_NAME: 'Filtered Out',
  OTHER_SHEET_NAME: 'Other',
  BLOCKLIST_SHEET_NAME: 'Company Blocklist',
  COMPANY_REGIONS_SHEET_NAME: 'Company Regions',
  TORY_EMAIL: '', // TODO: add Tory's email address
  LOOKBACK_DAYS: 4,
  RESURFACE_WINDOW_DAYS: 30, // shared with Part 2's resurfacing threshold
  PURGE_WINDOW_DAYS: 84, // 12-week data retention purge, based on Date Found
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

// Tabs that get the full rebuild-and-replace treatment (resurface flagging,
// stale-link removal, purge folded into read-back) rather than Other's
// simpler always-append pattern.
const REBUILD_TABS = [CONFIG.NEW_LEADS_SHEET_NAME];
const FLAT_TABS = [CONFIG.OTHER_SHEET_NAME];
const ALL_TAB_NAMES = [...new Set(Object.values(REGION_TO_TABS).flat())];

// ---- Headers ------------------------------------------------------------------
const TAB_HEADERS = ['Source', 'Job Title', 'Company', 'Town', 'Date Found', 'Link'];
const REVIEW_HEADERS = ['Source', 'Job Title', 'Company', 'Town', 'Date Found', 'Link', 'Reason'];
const FILTERED_HEADERS = ['Source', 'Job Title', 'Company', 'Town', 'Date Found', 'Link', 'Filtered Reason'];
const BLOCKLIST_HEADERS = ['Company'];
const COMPANY_REGIONS_HEADERS = ['Company', 'Region'];

// ---- Job link detection (kept deterministic — not handed to the AI) ----------
const JOB_LINK_PATTERNS = [
  /indeed\.com\/rc\/clk\/dl/i, /indeed\.com\/pagead\/clk\/dl/i,
  /indeed\.com\/viewjob/i, /linkedin\.com\/comm\/jobs\/view/i,
  /linkedin\.com\/jobs\/view/i
];

// ---- High-priority (resurfaced job) formatting --------------------------
// Applied to a whole row when a job resurfaces after 30+ days. Also used
// to DETECT already-flagged rows on read-back, so the flag survives the
// full tab rebuild on every run.
const HIGH_PRIORITY_BG = '#ffe599';

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

  const companyRegionsSheet = getOrCreateSheet(ss, CONFIG.COMPANY_REGIONS_SHEET_NAME);
  ensureHeaders(companyRegionsSheet, COMPANY_REGIONS_HEADERS);
  const companyRegionOverrides = loadCompanyRegions(companyRegionsSheet);

  const existingLinksByTab = {};
  const existingKeyInfoByTab = {};
  ALL_TAB_NAMES.forEach(tabName => {
    const { links, keyInfo } = loadExistingLinksAndKeys(tabSheets[tabName]);
    existingLinksByTab[tabName] = links;
    existingKeyInfoByTab[tabName] = keyInfo;
  });
  const { links: reviewLinks, keyInfo: reviewKeyInfo } = loadExistingLinksAndKeys(reviewSheet);
  const { links: filteredLinks, keyInfo: filteredKeyInfo } = loadExistingLinksAndKeys(filteredSheet);

  // Tracks, per rebuild tab (New Leads), which OLD links need to be dropped
  // during rebuild because their job just resurfaced under a new link.
  const staleLinksByTab = {};
  // Tracks, per rebuild tab (New Leads), which NEW links should be flagged
  // as high priority during rebuild (i.e. the resurfaced job's new link).
  const highPriorityLinksByTab = {};
  REBUILD_TABS.forEach(tabName => {
    staleLinksByTab[tabName] = new Set();
    highPriorityLinksByTab[tabName] = new Set();
  });

  const query = `from:${CONFIG.MARK_EMAIL} newer_than:${CONFIG.LOOKBACK_DAYS}d`;
  const threads = GmailApp.search(query);

  const newRowsByTab = {};
  ALL_TAB_NAMES.forEach(tabName => { newRowsByTab[tabName] = []; });
  const touchedTabs = new Set();

  let addedCount = 0, filteredCount = 0, reviewCount = 0, skippedEmails = 0, resurfacedCount = 0, blockedCount = 0, companyRegionOverrideCount = 0;

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

        // Code-level blocklist enforcement — overrides whatever the AI
        // decided. A blocklisted company is ALWAYS filtered, regardless
        // of whether the AI recognised it as an agency/law firm/etc.
        if (blockedCompanies.has(normalizeText(job.company))) {
          job.action = 'filter';
          job.reason = 'Company on blocklist';
          blockedCount++;
        }

        // Company Regions override — only applies to jobs the AI already
        // classified as "Other" (Remote/UK-wide, no real town). A
        // blocklisted company never reaches here with action still
        // 'filter', so no conflict-handling needed against the blocklist.
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

        // Filtered/Review dedup stays PERMANENT within the purge window —
        // not time-aware itself. Once entries age past PURGE_WINDOW_DAYS
        // they're removed by the purge pass below, at which point a
        // reappearing job would no longer match here and gets
        // reprocessed fresh (accepted tradeoff, see header notes).
        if (link && (filteredLinks.has(link) || reviewLinks.has(link))) return;
        if (filteredKeyInfo.has(jobKey) || reviewKeyInfo.has(jobKey)) return;

        if (job.action === 'filter') {
          filteredSheet.appendRow([source, job.title, job.company, town, dateFound, link, job.reason || 'Filtered by AI']);
          if (link) filteredLinks.add(link);
          filteredKeyInfo.set(jobKey, { date: dateFound, link: link });
          touchedTabs.add(CONFIG.FILTERED_SHEET_NAME);
          filteredCount++;
          return;
        }

        if (job.action === 'review' || !REGIONS.includes(job.region)) {
          reviewSheet.appendRow([source, job.title, job.company, town, dateFound, link, job.reason || 'AI uncertain of region']);
          if (link) reviewLinks.add(link);
          reviewKeyInfo.set(jobKey, { date: dateFound, link: link });
          touchedTabs.add(CONFIG.NEEDS_REVIEW_SHEET_NAME);
          reviewCount++;
          return;
        }

        // action === 'route'
        const region = job.region;
        const targetTabs = REGION_TO_TABS[region] || [];
        targetTabs.forEach(tabName => {
          const linkSet = existingLinksByTab[tabName];
          const keyInfo = existingKeyInfoByTab[tabName];

          if (link && linkSet.has(link)) return; // exact same link already present

          if (keyInfo.has(jobKey)) {
            const existing = keyInfo.get(jobKey);
            if (!isKeyStale(existing.date)) return; // within window — genuine duplicate, drop
            // Past the window: treat as a resurfaced job. Mark the old
            // link for removal, and the new link for high-priority
            // flagging, on this tab's rebuild.
            if (REBUILD_TABS.includes(tabName)) {
              if (existing.link) staleLinksByTab[tabName].add(existing.link);
              if (link) highPriorityLinksByTab[tabName].add(link);
            }
            resurfacedCount++;
          }

          if (link) linkSet.add(link);
          keyInfo.set(jobKey, { date: dateFound, link: link });
          newRowsByTab[tabName].push([source, job.title, job.company, town, dateFound, link]);
          touchedTabs.add(tabName);
          addedCount++;
        });
      });
    });
  });

  // New Leads ALWAYS rebuilds, every run — not gated on touchedTabs. This is
  // what makes the 84-day purge (folded into rebuildNewLeadsTab) actually
  // run daily, even on a run with no new jobs.
  let rebuildPurgedTotal = 0;
  REBUILD_TABS.forEach(tabName => {
    rebuildPurgedTotal += rebuildNewLeadsTab(
      tabSheets[tabName],
      newRowsByTab[tabName],
      staleLinksByTab[tabName],
      highPriorityLinksByTab[tabName]
    );
  });

  // Flat tabs: append new rows only if touched, but ALWAYS run the purge
  // pass so old rows get cleared out even on a quiet run.
  FLAT_TABS.forEach(tabName => {
    const sheet = tabSheets[tabName];
    if (touchedTabs.has(tabName)) {
      newRowsByTab[tabName].forEach(row => sheet.appendRow(row));
    }
    const purged = purgeExpiredRows(sheet);
    if (purged > 0) Logger.log(`${tabName}: purged ${purged} row(s) older than ${CONFIG.PURGE_WINDOW_DAYS} days.`);
    formatDateColumn(sheet);
    sortNewestFirst(sheet);
    autoResizeSheet(sheet);
  });

  // Needs Review / Filtered Out: same pattern — purge always runs,
  // regardless of whether new rows were added this cycle.
  [reviewSheet, filteredSheet].forEach(sheet => {
    const purged = purgeExpiredRows(sheet);
    if (purged > 0) Logger.log(`${sheet.getName()}: purged ${purged} row(s) older than ${CONFIG.PURGE_WINDOW_DAYS} days.`);
    formatDateColumn(sheet);
    sortNewestFirst(sheet);
    autoResizeSheet(sheet);
  });

  if (rebuildPurgedTotal > 0) {
    Logger.log(`New Leads: purged ${rebuildPurgedTotal} row(s) older than ${CONFIG.PURGE_WINDOW_DAYS} days.`);
  }

  Logger.log(`Done. ${addedCount} rows written (${resurfacedCount} flagged high priority as resurfaced after ${CONFIG.RESURFACE_WINDOW_DAYS}+ days, ${companyRegionOverrideCount} redirected from Other via Company Regions). ${reviewCount} sent to Needs Review. ${filteredCount} filtered out (${blockedCount} due to blocklist). ${skippedEmails} email(s) skipped due to API/parse errors.`);
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
- "region": required if action is "route", must be exactly one of: ${REGIONS.join(', ')}
- "reason": required if action is "filter" or "review", short plain-English reason (string)

FILTERING RULES (action = "filter"):
- Law firms, solicitors, chambers, legal recruitment agencies
- Charities, foundations, trusts, CIOs
- Councils and local authorities (borough/county/city/district councils)
- General recruitment/staffing agencies

REGION ASSIGNMENT (action = "route"):
Assign the town/location to exactly one region from this list, using this guidance:
- Scotland, North East, Yorkshire, North West, West Midlands, East Midlands, London, South West, Ireland — standard UK regions/postcode areas
- East Anglia — Norfolk, Suffolk, Cambridgeshire, Essex only (e.g. Cambridge, Norwich, Ipswich, Chelmsford, Colchester, Ely)
  - EXCEPTION: Peterborough is classified as East Midlands, NOT East Anglia, even though it sits in Cambridgeshire. Always route Peterborough to East Midlands.
- Northern Home Counties — Oxfordshire, Buckinghamshire, Bedfordshire, Hertfordshire (e.g. Oxford, Milton Keynes, Luton, St Albans, Watford)
- Southern Home Counties — Surrey, Kent, Sussex, Hampshire, Berkshire (e.g. Reading, Guildford, Brighton, Southampton, Portsmouth)
- Other — use this confidently (do NOT send to review) for: Remote, UK-wide, Nationwide, Work From Home, "United Kingdom", or any listing where the location is clearly national/non-specific rather than tied to a real town. These should always be routed to Other, never sent to review.

If the town is genuinely ambiguous, unrecognisable, or missing in a way that ISN'T covered by the Other rule above, use action "review" with a reason instead of guessing.

Respond with ONLY the JSON array. No markdown code fences, no commentary, no explanation before or after.

EMAIL TEXT:
${emailText}`;
}

// ==========================================================================
// NEW LEADS REBUILD
// ==========================================================================
// Flat equivalent of the old per-consultant rebuild (v17): same
// read-clear-rewrite pattern, same resurface flagging and purge, but no
// region sections — just one sorted, newest-first list. Job rows with no
// Link are intentionally dropped, same as before.
//
// staleLinks: existing rows whose Link is in this set are dropped during
// read-back (superseded by a resurfaced version under a new link).
//
// highPriorityLinks: rows whose Link is in this set get bold text +
// HIGH_PRIORITY_BG background applied after writing. The function ALSO
// reads back each existing row's current background before clearing the
// sheet, so a row already flagged from a previous run stays flagged after
// this rebuild — the flag is carried by cell formatting, not stored data.
//
// PURGE: rows whose Date Found is 84+ days old (isExpired()) are dropped
// during the same read-back pass, right alongside stale-link removal.
// Returns the count of purged rows so the caller can log it.

function rebuildNewLeadsTab(sheet, newRows, staleLinks, highPriorityLinks) {
  if (!sheet) {
    Logger.log(`rebuildNewLeadsTab called with no sheet — check that CONFIG.NEW_LEADS_SHEET_NAME ("${CONFIG.NEW_LEADS_SHEET_NAME}") matches the tab name exactly.`);
    return 0;
  }
  newRows = newRows || [];
  staleLinks = staleLinks || new Set();
  highPriorityLinks = highPriorityLinks || new Set();
  const lastRow = sheet.getLastRow();
  const numCols = TAB_HEADERS.length;

  // Carries forward any row already flagged high-priority from a previous
  // run, detected by its current background colour before the sheet gets
  // cleared below.
  const existingRows = [];
  const carriedFlags = new Set();
  let purgedCount = 0;

  if (lastRow >= 1) {
    const data = sheet.getRange(1, 1, lastRow, numCols).getValues();
    const backgrounds = sheet.getRange(1, 1, lastRow, numCols).getBackgrounds();
    data.forEach((row, idx) => {
      const isHeaderRow = row.join('|') === TAB_HEADERS.join('|');
      if (isHeaderRow) return; // repeated column-header row — not a job
      if (!row[5] || staleLinks.has(row[5])) return; // no link, or superseded by a resurfaced version
      if (isExpired(row[4])) {
        purgedCount++;
        return; // 84+ days old — drop it, don't carry forward
      }
      existingRows.push(row);
      if (backgrounds[idx][5] === HIGH_PRIORITY_BG) {
        carriedFlags.add(row[5]);
      }
    });
  }

  const allFlaggedLinks = new Set([...carriedFlags, ...highPriorityLinks]);

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

  sheet.getRange(1, 1, 1, numCols).setValues([TAB_HEADERS]).setFontWeight('bold');

  if (combined.length > 0) {
    const dataStartRow = 2;
    sheet.getRange(dataStartRow, 1, combined.length, numCols).setValues(combined);
    sheet.getRange(dataStartRow, 5, combined.length, 1).setNumberFormat('dd/mm/yyyy hh:mm');

    // Apply the high-priority flag to any row whose link is flagged.
    combined.forEach((rowData, i) => {
      if (allFlaggedLinks.has(rowData[5])) {
        sheet.getRange(dataStartRow + i, 1, 1, numCols)
          .setBackground(HIGH_PRIORITY_BG)
          .setFontWeight('bold');
      }
    });
  }

  sheet.autoResizeColumns(1, numCols);
  applyFixedLinkColumnWidth(sheet);

  return purgedCount;
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
      migratedRows.push(row);
    });
  });

  const newLeadsSheet = getOrCreateSheet(ss, CONFIG.NEW_LEADS_SHEET_NAME);
  const purged = rebuildNewLeadsTab(newLeadsSheet, migratedRows, new Set(), new Set());
  const purgedNote = purged > 0 ? ` (${purged} already past the ${CONFIG.PURGE_WINDOW_DAYS}-day retention window and dropped)` : '';
  Logger.log(`Migrated ${migratedRows.length} unique job row(s) into ${CONFIG.NEW_LEADS_SHEET_NAME}${purgedNote}.`);
  Logger.log('Old consultant tabs left untouched — delete Craig/Alison/Tom/Josh/Ray manually once New Leads looks correct.');
}

// ==========================================================================
// COMPANY BLOCKLIST
// ==========================================================================
// Single-column tab: any company listed here is force-filtered on every
// run, regardless of what the AI classifies it as. See the blocklist
// check in processJobAlerts(). NOT subject to the 84-day purge — this is
// a standing list, not job data, and never ages out.

function loadBlocklist(sheet) {
  const lastRow = sheet.getLastRow();
  const blocked = new Set();
  if (lastRow < 2) return blocked;
  const data = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  data.forEach(row => {
    const company = String(row[0] || '').trim();
    if (company) blocked.add(normalizeText(company));
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
// in processJobAlerts(). NOT subject to the 84-day purge — this is a
// standing reference list, like Company Blocklist, and never ages out.
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
// 12-WEEK DATA RETENTION PURGE
// ==========================================================================
// isExpired(): shared age check used both by rebuildNewLeadsTab() (for New
// Leads) and purgeExpiredRows() (for flat grid tabs). A missing/invalid
// date is treated as NOT expired — same "safest default" principle as
// isKeyStale(), so bad data never triggers surprise deletion.

function isExpired(dateFound) {
  if (!(dateFound instanceof Date)) return false;
  const msPerDay = 24 * 60 * 60 * 1000;
  const ageDays = (Date.now() - dateFound.getTime()) / msPerDay;
  return ageDays >= CONFIG.PURGE_WINDOW_DAYS;
}

// Generic purge for flat grid tabs (Other, Needs Review, Filtered Out, and
// — once built — Dispatch Log). Assumes Date Found lives in column E
// (index 4), matching every flat tab's layout in this project. Rewrites
// the sheet's data region in place, preserving row order otherwise.
// Returns the number of rows purged.
function purgeExpiredRows(sheet) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return 0;
  const numCols = sheet.getLastColumn();
  const data = sheet.getRange(2, 1, lastRow - 1, numCols).getValues();
  const kept = data.filter(row => !isExpired(row[4]));
  const purgedCount = data.length - kept.length;
  if (purgedCount === 0) return 0;

  sheet.getRange(2, 1, lastRow - 1, numCols).clearContent();
  if (kept.length > 0) {
    sheet.getRange(2, 1, kept.length, numCols).setValues(kept);
  }
  return purgedCount;
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
// Used both for the composite job-dedup key and for blocklist company
// matching, so "Acme Ltd." and "acme ltd" are always treated as the same.
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

// For a given existing Date Found, returns true if it's old enough that a
// new sighting of the same key should be treated as a resurfaced job
// rather than a duplicate. A missing/invalid date is treated as NOT stale
// (safest default — keeps permanent dedup rather than risking duplicate
// spam from bad data).
function isKeyStale(existingDate) {
  if (!(existingDate instanceof Date)) return false;
  const msPerDay = 24 * 60 * 60 * 1000;
  const ageDays = (Date.now() - existingDate.getTime()) / msPerDay;
  return ageDays >= CONFIG.RESURFACE_WINDOW_DAYS;
}

// Returns both the existing link Set (unchanged) and a keyInfo Map
// (key -> { date, link }) built from the same pass over the sheet. The
// Map lets dedup checks compare against how OLD each key's last sighting
// was, not just whether it exists.
function loadExistingLinksAndKeys(sheet) {
  const lastRow = sheet.getLastRow();
  const links = new Set();
  const keyInfo = new Map();
  if (lastRow < 1) return { links, keyInfo };
  const data = sheet.getRange(1, 1, lastRow, 6).getValues(); // A:F — Source..Link
  data.forEach(row => {
    const title = row[1], company = row[2], town = row[3], dateFound = row[4], link = row[5];
    if (link) links.add(link);
    if (title && company) {
      const key = normalizeJobKey(title, company, town);
      const d = (dateFound instanceof Date) ? dateFound : null;
      const existing = keyInfo.get(key);
      // Keep the MOST RECENT sighting of this key, in case duplicates
      // from before this fix are still sitting in the sheet.
      if (!existing || (d && (!existing.date || d > existing.date))) {
        keyInfo.set(key, { date: d, link: link || (existing && existing.link) || '' });
      }
    }
  });
  return { links, keyInfo };
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

// Link is always column F (6) across every tab layout (consultant tabs,
// flat tabs, Needs Review, Filtered Out). Auto-resize stretches it to fit
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
// TRIGGER SETUP (unchanged)
// ==========================================================================

function createDailyTrigger() {
  ScriptApp.newTrigger('processJobAlerts').timeBased().everyDays(1).atHour(7).create();
  Logger.log('Daily trigger created for 7am.');
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
      Logger.log(`${i + 1}. ${j.title} | ${j.company} | ${j.town} | ${link} -> ROUTE [${j.region} -> ${tabs}]`);
    } else {
      Logger.log(`${i + 1}. ${j.title} | ${j.company} | ${j.town} | ${link} -> ${j.action.toUpperCase()} (${j.reason})`);
    }
  });
}
// ==========================================================================
// DAILY RUN + SEND  (add-on for the COPY of the master sheet)
// ==========================================================================
// Paste this block at the BOTTOM of Code.gs on the copy. It adds nothing
// to and changes nothing in the existing script — it just wraps
// processJobAlerts() and an email send into one scheduled run.
//
// WHY ONE TRIGGER, NOT TWO:
//   Apps Script gives no ordering guarantee between two triggers set for
//   the same time. Two separate 7am triggers would periodically email
//   yesterday's sheet because the send fired before processing finished.
//   One wrapper function running both steps in sequence removes that
//   race entirely.
//
// SETUP (three steps, once):
//   1. Run dailyRunAndSend() manually — this fires the Google
//      authorisation prompt and confirms the whole chain works end to end.
//   2. Check the email actually arrived with today's data in it.
//   3. Run createDailyRunAndSendTrigger() once. Done.
//
// NOTE ON TIMING: "7am" means the trigger fires somewhere in the 7–8am
// window. Apps Script time-based triggers aren't exact. Arrival drifting
// to 7:40 is normal, not a fault.

const DAILY_SEND_CONFIG = {
  RECIPIENT_EMAIL: 'marklevine@bcllegal.com',
  SEND_HOUR: 7, // 24-hour clock; trigger fires within this hour
  SUBJECT_PREFIX: 'Job Alerts Sheet'
};

// ==========================================================================
// THE SCHEDULED FUNCTION
// ==========================================================================
// Runs processing first, then sends. If processing throws, the send still
// happens with a warning noted in the email body — a silent failure while
// nobody's watching is worse than a sheet that arrives flagged.

function dailyRunAndSend() {
  let processingError = null;

  try {
    processJobAlerts();
  } catch (err) {
    processingError = err;
    Logger.log(`processJobAlerts() failed: ${err}. Sending the sheet anyway, with a warning in the email body.`);
  }

  // Apps Script batches spreadsheet writes. Without this, the .xlsx
  // export can be taken BEFORE the new rows have actually committed —
  // the classic cause of "the email arrived but the new jobs weren't in
  // it". Forces everything to disk before we export.
  SpreadsheetApp.flush();

  sendSheetCopy(processingError);
}

// ==========================================================================
// EMAIL SEND
// ==========================================================================

function sendSheetCopy(processingError) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const dateStr = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'dd/MM/yyyy');

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

  let body = 'Attached is today\'s updated job alerts workbook.\n\nThis is an automated daily send.';
  if (processingError) {
    body = 'WARNING: today\'s job processing did not complete successfully, so this sheet may not include the latest listings.\n\n'
      + `Error: ${processingError}\n\n`
      + 'The workbook is attached as it currently stands.';
  }

  try {
    MailApp.sendEmail({
      to: DAILY_SEND_CONFIG.RECIPIENT_EMAIL,
      subject: `${DAILY_SEND_CONFIG.SUBJECT_PREFIX} — ${dateStr}${processingError ? ' (processing error)' : ''}`,
      body: body,
      attachments: [blob]
    });
    Logger.log(`Sent workbook to ${DAILY_SEND_CONFIG.RECIPIENT_EMAIL} (${dateStr}).`);
  } catch (err) {
    Logger.log(`Failed to send email: ${err}`);
  }
}

// ==========================================================================
// TRIGGER SETUP
// ==========================================================================
// Clears any existing dailyRunAndSend trigger first, so running this
// twice can't leave you with two triggers and two runs a day.

function createDailyRunAndSendTrigger() {
  const existing = ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'dailyRunAndSend');
  existing.forEach(t => ScriptApp.deleteTrigger(t));
  if (existing.length > 0) {
    Logger.log(`Removed ${existing.length} existing dailyRunAndSend trigger(s) before recreating.`);
  }

  ScriptApp.newTrigger('dailyRunAndSend')
    .timeBased()
    .everyDays(1)
    .atHour(DAILY_SEND_CONFIG.SEND_HOUR)
    .create();

  Logger.log(`Daily run+send trigger created for ~${DAILY_SEND_CONFIG.SEND_HOUR}:00. Recipient: ${DAILY_SEND_CONFIG.RECIPIENT_EMAIL}`);
}

// ==========================================================================
// DIAGNOSTICS
// ==========================================================================

// Copying a Google Sheet copies the bound script but NOT its triggers, so
// this copy starts with none. Run this after setup to confirm exactly
// what's scheduled — and to check you haven't accidentally got a leftover
// standalone processJobAlerts() trigger running alongside the wrapper,
// which would double-process.
function listAllTriggers() {
  const triggers = ScriptApp.getProjectTriggers();
  if (triggers.length === 0) {
    Logger.log('No triggers currently set on this copy.');
    return;
  }
  Logger.log(`${triggers.length} trigger(s) on this copy:`);
  triggers.forEach(t => Logger.log(`  - ${t.getHandlerFunction()} (${t.getEventType()})`));
}

// Turns off the automated daily run without deleting any code.
function removeDailyRunAndSendTrigger() {
  const existing = ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'dailyRunAndSend');
  existing.forEach(t => ScriptApp.deleteTrigger(t));
  Logger.log(`Removed ${existing.length} trigger(s). Automated daily run+send is now off.`);
}
