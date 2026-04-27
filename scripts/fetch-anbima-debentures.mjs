#!/usr/bin/env node
/**
 * Fetch ANBIMA debentures across multiple pages and consolidate into a single JSON file.
 *
 * Usage:
 *   node scripts/fetch-anbima-debentures.mjs [options]
 *
 * Options:
 *   --pages <n>        Number of pages to fetch (default: 10)
 *   --size  <n>        Items per page — must match ANBIMA's page size (default: 20)
 *   --output <path>    Output file path (default: debentures.json)
 *   --base-url <url>   GhostReader processor URL (default: http://localhost:3000)
 *   --delay <ms>       Delay between requests in ms to be polite (default: 2000)
 *   --timeout <ms>     Per-request timeout in ms (default: 60000)
 *
 * Environment:
 *   GHOSTREADER_URL    Overrides --base-url
 *
 * Example:
 *   node scripts/fetch-anbima-debentures.mjs --pages 5 --output data/debentures.json
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// ---------------------------------------------------------------------------
// Arg parsing (zero deps)
// ---------------------------------------------------------------------------
function parseArgs(args) {
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = 'true';
      }
    }
  }
  return flags;
}

const flags = parseArgs(process.argv.slice(2));

const PAGES    = parseInt(flags.pages   || '10', 10);
const SIZE     = parseInt(flags.size    || '20', 10);
const OUTPUT   = flags.output           || 'debentures.json';
const BASE_URL = (process.env.GHOSTREADER_URL || flags['base-url'] || 'http://localhost:3000').replace(/\/$/, '');
const DELAY    = parseInt(flags.delay   || '2000', 10);
const TIMEOUT  = parseInt(flags.timeout || '60000', 10);

const ANBIMA_BASE = 'https://data.anbima.com.br/busca/debentures';
const PROFILE     = 'anbima_debentures';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildAnbimaUrl(page) {
  return `${ANBIMA_BASE}?view=caracteristicas&page=${page}&q=&size=${SIZE}`;
}

async function extractPage(page) {
  const targetUrl = buildAnbimaUrl(page);
  const res = await fetch(`${BASE_URL}/extract`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: targetUrl, profile: PROFILE, timeout: TIMEOUT }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Page ${page}: HTTP ${res.status} — ${text}`);
  }

  const data = await res.json();

  if (data.captcha) {
    throw new Error(`Page ${page}: CAPTCHA detected`);
  }
  if (data.error) {
    throw new Error(`Page ${page}: ${data.error}`);
  }

  return data.results || [];
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log(`Fetching ${PAGES} pages (${SIZE} items/page) from ANBIMA Data...`);
  console.log(`Processor: ${BASE_URL}`);
  console.log(`Output:    ${OUTPUT}\n`);

  const allResults = [];

  for (let page = 0; page < PAGES; page++) {
    const label = `Page ${page + 1}/${PAGES}`;
    try {
      console.log(`${label}: fetching...`);
      const results = await extractPage(page);
      console.log(`${label}: ${results.length} debentures extracted`);
      allResults.push(...results);
    } catch (err) {
      console.error(`${label}: FAILED — ${err.message}`);
    }

    // Be polite — wait between requests (skip after last page)
    if (page < PAGES - 1 && DELAY > 0) {
      await sleep(DELAY);
    }
  }

  console.log(`\nTotal: ${allResults.length} debentures collected`);

  // Ensure output directory exists
  const dir = dirname(OUTPUT);
  if (dir && dir !== '.') {
    mkdirSync(dir, { recursive: true });
  }

  writeFileSync(OUTPUT, JSON.stringify(allResults, null, 2), 'utf-8');
  console.log(`Saved to ${OUTPUT}`);
}

main().catch((err) => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
