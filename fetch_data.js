#!/usr/bin/env node
/**
 * fetch_data.js  (v4)
 *
 * Changes from v3:
 *  - Only checks invitees (for no-show status) on PAST events. Future events
 *    cannot be no-shows, so those API calls were wasted and contributed to
 *    rate-limit errors.
 *  - Processes invitee calls in batches of 10 with a 2-second pause between
 *    each batch, giving Calendly's rate-limit window time to recover.
 *  - More generous retry backoff on 429: 5s, 10s, 20s.
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

const BATCH_SIZE       = 10;   // invitee calls per batch
const BATCH_PAUSE_MS   = 2000; // pause between batches (ms)
const CALL_INTERVAL_MS = 150;  // pause between individual calls within a batch (ms)

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// HTTP GET with automatic retry on 429, using longer backoff than v3.
async function apiGet(url, attempt = 1) {
  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: {
        'Authorization': `Bearer ${TOKEN}`,
        'Content-Type':  'application/json',
      }
    }, (res) => {
      let body = '';
      res.on('data',  chunk => body += chunk);
      res.on('end', async () => {
        if (res.statusCode === 429) {
          if (attempt <= 4) {
            const wait = Math.pow(2, attempt + 1) * 1000; // 4s, 8s, 16s, 32s
            console.log(`  Rate limited (429). Waiting ${wait / 1000}s before retry ${attempt}/4...`);
            await sleep(wait);
            try { resolve(await apiGet(url, attempt + 1)); } catch (e) { reject(e); }
          } else {
            reject(new Error(`HTTP 429 (rate limited) after 4 retries for ${url}`));
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

// ── Calendly fetching ─────────────────────────────────────────────────────────

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
  const now = new Date();
  console.log(`\n[${q.label}] Fetching events...`);

  const allEvents      = await fetchAllEvents(q.start, q.end);
  const activeEvents   = allEvents.filter(e => e.status === 'active');
  const cancelledCount = allEvents.filter(e => e.status === 'canceled').length;

  // Split active events into past (eligible for no-show) and future (skip invitee check)
  const pastEvents   = activeEvents.filter(e => new Date(e.start_time) <  now);
  const futureEvents = activeEvents.filter(e => new Date(e.start_time) >= now);

  console.log(`[${q.label}] ${activeEvents.length} active (${pastEvents.length} past, ${futureEvents.length} upcoming), ${cancelledCount} cancelled.`);
  console.log(`[${q.label}] Checking invitees for ${pastEvents.length} past event(s) only (future events cannot be no-shows).`);

  // Check past events for no-show status, in batches
  const noShowSet = new Set();
  for (let i = 0; i < pastEvents.length; i += BATCH_SIZE) {
    const batch = pastEvents.slice(i, i + BATCH_SIZE);
    console.log(`[${q.label}] Invitee batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(pastEvents.length / BATCH_SIZE)} (events ${i + 1}–${Math.min(i + BATCH_SIZE, pastEvents.length)})...`);
    for (let j = 0; j < batch.length; j++) {
      const noShow = await isNoShow(batch[j].uri);
      if (noShow) noShowSet.add(batch[j].uri);
      if (j < batch.length - 1) await sleep(CALL_INTERVAL_MS);
    }
    // Pause between batches (skip after the last one)
    if (i + BATCH_SIZE < pastEvents.length) {
      console.log(`[${q.label}] Batch complete. Pausing ${BATCH_PAUSE_MS / 1000}s...`);
      await sleep(BATCH_PAUSE_MS);
    }
  }

  // Build slot list: past events with no-show status, future events always noShow:false
  const slots = [
    ...pastEvents.map(e => ({
      start:  e.start_time,
      end:    e.end_time,
      noShow: noShowSet.has(e.uri),
    })),
    ...futureEvents.map(e => ({
      start:  e.start_time,
      end:    e.end_time,
      noShow: false,
    })),
  ].sort((a, b) => new Date(a.start) - new Date(b.start));

  const counted = slots.filter(s => !s.noShow).length;
  console.log(`[${q.label}] Done. ${noShowSet.size} no-show(s). ${counted} counted slots (${counted / 2} hrs).`);

  return { label: q.label, display: q.display, start: q.start, end: q.end, slots, cancelledCount };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== ALR Booking Data Fetch (v4) ===');
  console.log(`Started: ${new Date().toISOString()}`);

  const now            = new Date();
  const activeQuarters = QUARTERS.filter(q => new Date(q.start) <= now);
  const futureQuarters = QUARTERS.filter(q => new Date(q.start) >  now);

  console.log(`Processing ${activeQuarters.length} active quarter(s); skipping ${futureQuarters.length} future quarter(s).`);

  const results = [];

  for (let i = 0; i < activeQuarters.length; i++) {
    const result = await processQuarter(activeQuarters[i]);
    results.push(result);
    if (i < activeQuarters.length - 1) await sleep(3000);
  }

  for (const q of futureQuarters) {
    results.push({
      label: q.label, display: q.display, start: q.start, end: q.end,
      slots: [], cancelledCount: 0,
    });
  }

  const output = { generated_at: new Date().toISOString(), quarters: results };
  fs.writeFileSync(path.join(__dirname, 'data.json'), JSON.stringify(output, null, 2), 'utf8');

  console.log('\n=== Summary ===');
  results.forEach(q => {
    const counted = q.slots.filter(s => !s.noShow).length;
    const tag     = new Date(q.start) > now ? '(future – skipped)' : '';
    console.log(`${q.label}: ${counted} counted slots  ${tag}`);
  });
  console.log(`\ndata.json written. Finished: ${new Date().toISOString()}`);
}

main().catch(err => {
  console.error('\nFATAL ERROR:', err.message);
  process.exit(1);
});
