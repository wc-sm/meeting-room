#!/usr/bin/env node
/**
 * fetch_data.js  (v3)
 *
 * Changes from v2:
 *  - Only fetches quarters that have started (skips future quarters entirely,
 *    avoiding unnecessary API calls and rate-limit errors on those quarters).
 *  - Retries automatically on HTTP 429 (rate limit) with exponential backoff.
 *  - Increases delay between invitee calls slightly to reduce rate-limit risk.
 */

'use strict';

const https = require('https');
const fs    = require('fs');
const path  = require('path');

const TOKEN = process.env.CALENDLY_API_TOKEN;
if (!TOKEN) {
  console.error('ERROR: CALENDLY_API_TOKEN environment variable is not set.');
  process.exit(1);
}

const ORG_URI = 'https://api.calendly.com/organizations/339beecf-bf24-4bf1-89eb-547428fbf728';

const QUARTERS = [
  { label: 'Q1 2026',    display: '9 Mar \u2013 8 Jun 2026',  start: '2026-03-09T00:00:00Z', end: '2026-06-08T23:59:59Z' },
  { label: 'Q2 2026',    display: '9 Jun \u2013 8 Sep 2026',  start: '2026-06-09T00:00:00Z', end: '2026-09-08T23:59:59Z' },
  { label: 'Q3 2026',    display: '9 Sep \u2013 8 Dec 2026',  start: '2026-09-09T00:00:00Z', end: '2026-12-08T23:59:59Z' },
  { label: 'Q4 2026/27', display: '9 Dec \u2013 8 Mar 2027',  start: '2026-12-09T00:00:00Z', end: '2027-03-08T23:59:59Z' },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// HTTP GET with automatic retry on 429 (rate limit).
// Waits 2s, 4s, 8s before giving up.
async function apiGet(url, attempt = 1) {
  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: {
        'Authorization': `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
      }
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', async () => {
        if (res.statusCode === 429) {
          if (attempt <= 3) {
            const wait = Math.pow(2, attempt) * 1000; // 2s, 4s, 8s
            console.log(`  Rate limited (429). Waiting ${wait / 1000}s before retry ${attempt}/3...`);
            await sleep(wait);
            try { resolve(await apiGet(url, attempt + 1)); } catch (e) { reject(e); }
          } else {
            reject(new Error(`HTTP 429 (rate limited) after 3 retries for ${url}`));
          }
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} from ${url}: ${body.slice(0, 200)}`));
          return;
        }
        try   { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error(`JSON parse error for ${url}: ${e.message}`)); }
      });
    }).on('error', reject);
  });
}

// ── Calendly data fetching ────────────────────────────────────────────────────

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
  const data = await apiGet(url);
  return data.collection.some(inv => inv.no_show && typeof inv.no_show === 'object');
}

// ── Per-quarter processing ────────────────────────────────────────────────────

async function processQuarter(q) {
  console.log(`\n[${q.label}] Fetching events...`);
  const allEvents      = await fetchAllEvents(q.start, q.end);
  const activeEvents   = allEvents.filter(e => e.status === 'active');
  const cancelledCount = allEvents.filter(e => e.status === 'canceled').length;
  console.log(`[${q.label}] ${activeEvents.length} active, ${cancelledCount} cancelled.`);

  const slots = [];
  let noShowCount = 0;

  for (let i = 0; i < activeEvents.length; i++) {
    if (i % 10 === 0) {
      console.log(`[${q.label}] Checking invitees ${i + 1}/${activeEvents.length}...`);
    }
    const noShow = await isNoShow(activeEvents[i].uri);
    if (noShow) noShowCount++;
    slots.push({ start: activeEvents[i].start_time, end: activeEvents[i].end_time, noShow });
    // 100ms between invitee calls (up from 50ms) to reduce rate-limit risk
    if (i < activeEvents.length - 1) await sleep(100);
  }

  const counted = slots.filter(s => !s.noShow).length;
  console.log(`[${q.label}] Done. ${noShowCount} no-show(s). ${counted} counted slots (${counted / 2} hrs).`);

  return { label: q.label, display: q.display, start: q.start, end: q.end, slots, cancelledCount };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== ALR Booking Data Fetch (v3) ===');
  console.log(`Started: ${new Date().toISOString()}`);

  const now = new Date();

  // Only process quarters that have already started.
  // Future quarters are skipped entirely – they have no events and generate
  // unnecessary API calls that can trigger rate limiting.
  const activeQuarters = QUARTERS.filter(q => new Date(q.start) <= now);
  const futureQuarters = QUARTERS.filter(q => new Date(q.start) >  now);

  console.log(`Processing ${activeQuarters.length} active quarter(s); skipping ${futureQuarters.length} future quarter(s).`);

  const results = [];

  for (const q of activeQuarters) {
    const result = await processQuarter(q);
    results.push(result);
    // 2s pause between quarters to let the rate-limit window recover
    if (q !== activeQuarters[activeQuarters.length - 1]) await sleep(2000);
  }

  // Include future quarters as empty placeholders so the dashboard can still
  // show the quarter tabs (with zero data) without needing to fetch anything.
  for (const q of futureQuarters) {
    results.push({ label: q.label, display: q.display, start: q.start, end: q.end, slots: [], cancelledCount: 0 });
  }

  const output = { generated_at: new Date().toISOString(), quarters: results };
  const outPath = path.join(__dirname, 'data.json');
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2), 'utf8');

  console.log('\n=== Summary ===');
  results.forEach(q => {
    const counted = q.slots.filter(s => !s.noShow).length;
    const status  = new Date(q.start) > now ? '(future – skipped)' : '';
    console.log(`${q.label}: ${counted} counted slots  ${status}`);
  });
  console.log(`\ndata.json written. Finished: ${new Date().toISOString()}`);
}

main().catch(err => {
  console.error('\nFATAL ERROR:', err.message);
  process.exit(1);
});
