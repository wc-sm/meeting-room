#!/usr/bin/env node
/**
 * fetch_data.js
 *
 * Fetches WCSM meeting room booking data from the Calendly API and writes
 * a structured data.json file that the dashboard reads.
 *
 * - Retrieves all scheduled events (active and cancelled) for each quarter.
 * - For every active event, fetches its invitee record to check the no_show flag.
 * - Writes data.json to the same directory as this script.
 *
 * Required environment variable: CALENDLY_API_TOKEN
 * (Set this as a GitHub Actions secret called CALENDLY_API_TOKEN)
 */

'use strict';

const https  = require('https');
const fs     = require('fs');
const path   = require('path');

// ─── Configuration ───────────────────────────────────────────────────────────

const TOKEN = process.env.CALENDLY_API_TOKEN;
if (!TOKEN) {
  console.error('ERROR: CALENDLY_API_TOKEN environment variable is not set.');
  process.exit(1);
}

const ORG_URI = 'https://api.calendly.com/organizations/339beecf-bf24-4bf1-89eb-547428fbf728';

// Quarter boundaries use the 9th-of-the-month pattern agreed with ALR.
// Add future quarters here as needed.
const QUARTERS = [
  { label: 'Q1 2026',   display: '9 Mar \u2013 8 Jun 2026',  start: '2026-03-09T00:00:00Z', end: '2026-06-08T23:59:59Z' },
  { label: 'Q2 2026',   display: '9 Jun \u2013 8 Sep 2026',  start: '2026-06-09T00:00:00Z', end: '2026-09-08T23:59:59Z' },
  { label: 'Q3 2026',   display: '9 Sep \u2013 8 Dec 2026',  start: '2026-09-09T00:00:00Z', end: '2026-12-08T23:59:59Z' },
  { label: 'Q4 2026/27',display: '9 Dec \u2013 8 Mar 2027',  start: '2026-12-09T00:00:00Z', end: '2027-03-08T23:59:59Z' },
];

// ─── HTTP helper ─────────────────────────────────────────────────────────────

function apiGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: {
        'Authorization': `Bearer ${TOKEN}`,
        'Content-Type':  'application/json',
      }
    }, (res) => {
      let body = '';
      res.on('data',  chunk => body += chunk);
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} from ${url}: ${body}`));
          return;
        }
        try   { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error(`JSON parse error for ${url}: ${e.message}`)); }
      });
    }).on('error', reject);
  });
}

// Small delay between invitee calls to be polite to the API
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Calendly data fetching ───────────────────────────────────────────────────

async function fetchAllEvents(minStart, maxStart) {
  const events = [];
  let pageToken = null;
  do {
    let url =
      `https://api.calendly.com/scheduled_events` +
      `?organization=${encodeURIComponent(ORG_URI)}` +
      `&count=100` +
      `&sort=start_time:asc` +
      `&min_start_time=${encodeURIComponent(minStart)}` +
      `&max_start_time=${encodeURIComponent(maxStart)}`;
    if (pageToken) url += `&page_token=${encodeURIComponent(pageToken)}`;
    const data = await apiGet(url);
    events.push(...data.collection);
    pageToken = data.pagination.next_page_token || null;
  } while (pageToken);
  return events;
}

async function isNoShow(eventUri) {
  const uuid = eventUri.split('/').pop();
  const url  = `https://api.calendly.com/scheduled_events/${uuid}/invitees?count=100`;
  try {
    const data = await apiGet(url);
    // An invitee is a no-show when its no_show field is a non-null object
    return data.collection.some(inv => inv.no_show && typeof inv.no_show === 'object');
  } catch (e) {
    console.warn(`  Warning: could not fetch invitees for ${eventUri}: ${e.message}`);
    return false;
  }
}

// ─── Per-quarter processing ───────────────────────────────────────────────────

async function processQuarter(q) {
  console.log(`\nProcessing ${q.label} (${q.display})...`);

  const allEvents = await fetchAllEvents(q.start, q.end);
  console.log(`  ${allEvents.length} total events returned by API.`);

  const activeEvents    = allEvents.filter(e => e.status === 'active');
  const cancelledCount  = allEvents.filter(e => e.status === 'canceled').length;
  console.log(`  ${activeEvents.length} active, ${cancelledCount} cancelled.`);

  const slots = [];
  let noShowCount = 0;

  for (let i = 0; i < activeEvents.length; i++) {
    const event = activeEvents[i];
    if (i > 0 && i % 10 === 0) {
      console.log(`  Checked invitees for ${i}/${activeEvents.length} events...`);
    }
    const noShow = await isNoShow(event.uri);
    if (noShow) noShowCount++;
    slots.push({
      start:  event.start_time,
      end:    event.end_time,
      noShow,
    });
    // 50ms gap between invitee calls
    if (i < activeEvents.length - 1) await sleep(50);
  }

  const counted = slots.filter(s => !s.noShow).length;
  console.log(`  ${noShowCount} no-show(s). ${counted} slots count towards allowance.`);

  return {
    label:        q.label,
    display:      q.display,
    start:        q.start,
    end:          q.end,
    slots,
    cancelledCount,
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== ALR Booking Data Fetch ===');
  console.log(`Started: ${new Date().toISOString()}`);

  const quarters = [];

  for (const q of QUARTERS) {
    try {
      const result = await processQuarter(q);
      quarters.push(result);
    } catch (err) {
      console.error(`ERROR processing ${q.label}: ${err.message}`);
      // Keep going with other quarters; record the error in output
      quarters.push({
        label:        q.label,
        display:      q.display,
        start:        q.start,
        end:          q.end,
        slots:        [],
        cancelledCount: 0,
        fetchError:   err.message,
      });
    }
  }

  const output = {
    generated_at: new Date().toISOString(),
    quarters,
  };

  const outPath = path.join(__dirname, 'data.json');
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2), 'utf8');
  console.log(`\ndata.json written to ${outPath}`);
  console.log(`Finished: ${new Date().toISOString()}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
