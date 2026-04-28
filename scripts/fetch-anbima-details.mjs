#!/usr/bin/env node
/**
 * Bulk fetcher for ANBIMA Data per-debenture pages (caracteristicas + precos +
 * agenda). Reads tickers from a debentures.json (the listing output produced
 * by fetch-anbima-debentures.mjs), iterates one ticker at a time, and writes
 * a consolidated JSON with one record per ticker.
 *
 * Usage:
 *   node scripts/fetch-anbima-details.mjs [options]
 *
 * Options:
 *   --input <path>        Listing JSON with {url,title,...} entries (default: debentures.json)
 *   --output <path>       Output file (default: details.json)
 *   --historico <window>  D-30 (default) | M-1 | D-N | full
 *   --base-url <url>      GhostReader processor (default: http://localhost:3000)
 *   --delay <ms>          Sleep between tickers (default: 1000)
 *   --retry <n>           Retries per failed call w/ exponential backoff (default: 3)
 *   --timeout <ms>        Per-call timeout (default: 90000)
 *   --resume              Skip tickers already present in output
 *   --limit <n>           Process only first N tickers
 *   --start <n>           Skip the first N tickers (useful for resuming a slice)
 *   --quiet               Suppress per-call lines, keep only ticker summary
 *
 * Environment:
 *   GHOSTREADER_URL       Overrides --base-url
 *
 * Examples:
 *   node scripts/fetch-anbima-details.mjs --historico D-30 --limit 50
 *   node scripts/fetch-anbima-details.mjs --historico full --output details-full.json
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// ---------------------------------------------------------------------------
// Arg parsing
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
const INPUT   = flags.input   || 'debentures.json';
const OUTPUT  = flags.output  || 'details.json';
const HIST    = flags.historico || 'D-30';
const BASE    = (process.env.GHOSTREADER_URL || flags['base-url'] || 'http://localhost:3000').replace(/\/$/, '');
const DELAY   = parseInt(flags.delay   || '1000', 10);
const RETRY   = parseInt(flags.retry   || '3', 10);
const TIMEOUT = parseInt(flags.timeout || '90000', 10);
const RESUME  = flags.resume === 'true';
const LIMIT   = flags.limit ? parseInt(flags.limit, 10) : Infinity;
const START   = flags.start ? parseInt(flags.start, 10) : 0;
const QUIET   = flags.quiet === 'true';
const SIZE    = 100; // ANBIMA accepts up to 100 per page

// ---------------------------------------------------------------------------
// History window parsing
// ---------------------------------------------------------------------------
/** Returns a predicate (rowDate => boolean) for the configured --historico. */
function buildHistFilter(spec) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  if (spec === 'full') return null; // no filter; paginate everything

  if (spec === 'M-1') {
    // previous calendar month relative to today
    const start = new Date(today.getFullYear(), today.getMonth() - 1, 1);
    const end   = new Date(today.getFullYear(), today.getMonth(), 0, 23, 59, 59);
    return (d) => d >= start && d <= end;
  }

  // D-N (e.g. D-30, D-7)
  const m = /^D-(\d+)$/.exec(spec);
  if (!m) {
    throw new Error(`Invalid --historico value: ${spec}. Expected D-N, M-1, or full.`);
  }
  const days = parseInt(m[1], 10);
  const start = new Date(today.getTime() - days * 86400_000);
  return (d) => d >= start && d <= today;
}

/** Parse "dd/mm/yyyy" to a Date (midnight local). */
function parseBrDate(s) {
  const [d, m, y] = s.split('/').map((n) => parseInt(n, 10));
  if (!d || !m || !y) return null;
  return new Date(y, m - 1, d);
}

// ---------------------------------------------------------------------------
// HTTP with retry
// ---------------------------------------------------------------------------
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function postExtract(url, profile, attempt = 1) {
  try {
    const res = await fetch(`${BASE}/extract`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, profile, timeout: TIMEOUT }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    if (data.error) throw new Error(`extract error: ${String(data.error).slice(0, 200)}`);
    return data;
  } catch (err) {
    if (attempt >= RETRY) throw err;
    const backoff = 1000 * Math.pow(2, attempt - 1); // 1s, 2s, 4s...
    if (!QUIET) console.error(`    retry ${attempt}/${RETRY - 1} after ${backoff}ms (${err.message.slice(0, 80)})`);
    await sleep(backoff);
    return postExtract(url, profile, attempt + 1);
  }
}

// ---------------------------------------------------------------------------
// Per-endpoint helpers
// ---------------------------------------------------------------------------
async function fetchCaracteristicas(ticker) {
  const url = `https://data.anbima.com.br/debentures/${ticker}/caracteristicas`;
  const data = await postExtract(url, 'anbima_debenture_caracteristicas');
  return data.results[0]?.content || {};
}

async function fetchPrecos(ticker, histFilter) {
  // Always pull page 1 first — covers most assets in one shot under D-30.
  const out = { indicativo: [], historico: [], flags: [] };
  const url1 = `https://data.anbima.com.br/debentures/${ticker}/precos?page=1&size=${SIZE}`;
  const d1 = await postExtract(url1, 'anbima_debenture_precos');

  for (const r of d1.results) {
    if (r.title.endsWith('PU Indicativo')) out.indicativo = r.content;
    if (r.title.endsWith('PU Histórico')) out.historico = r.content;
  }
  for (const s of d1.suggestions || []) {
    if (!s.startsWith('Exibindo')) out.flags.push(s);
  }

  // Should we paginate Histórico? Need full mode OR D-N where N exceeds first page coverage.
  let needMore = false;
  if (histFilter === null) {
    // full mode: always paginate until done
    needMore = true;
  } else if (out.historico.length === SIZE) {
    // partial mode: only continue if oldest row in page 1 still inside window
    const oldest = out.historico[out.historico.length - 1]?.data_de_referencia;
    const oldestDate = oldest ? parseBrDate(oldest) : null;
    needMore = oldestDate && histFilter(oldestDate);
  }

  if (needMore) {
    let page = 2;
    while (true) {
      const url = `https://data.anbima.com.br/debentures/${ticker}/precos?page=${page}&size=${SIZE}`;
      const d = await postExtract(url, 'anbima_debenture_precos');
      const hist = d.results.find((r) => r.title.endsWith('PU Histórico'))?.content || [];
      if (hist.length === 0) break;

      // Filter by window. If first row is already older than window, we're done.
      let stop = false;
      if (histFilter !== null) {
        const filtered = [];
        for (const row of hist) {
          const dt = parseBrDate(row.data_de_referencia);
          if (dt && histFilter(dt)) filtered.push(row);
          else if (dt && dt < (new Date(Date.now() - 365 * 86400_000))) {
            // hard stop if we've gone more than a year past today
            stop = true; break;
          }
        }
        out.historico.push(...filtered);
        if (filtered.length < hist.length) stop = true; // crossed window boundary
      } else {
        out.historico.push(...hist);
      }

      if (stop || hist.length < SIZE) break;
      page += 1;
    }
  }

  // Apply final filter to indicativo (always small, single page)
  if (histFilter !== null) {
    out.indicativo = out.indicativo.filter((row) => {
      const dt = parseBrDate(row.data || row.data_de_referencia);
      return dt && histFilter(dt);
    });
    out.historico = out.historico.filter((row) => {
      const dt = parseBrDate(row.data_de_referencia);
      return dt && histFilter(dt);
    });
  }

  return out;
}

async function fetchAgenda(ticker) {
  const out = [];
  const flags = [];
  let page = 1;
  while (true) {
    const url = `https://data.anbima.com.br/debentures/${ticker}/agenda?page=${page}&size=${SIZE}`;
    const d = await postExtract(url, 'anbima_debenture_agenda');
    for (const s of d.suggestions || []) {
      if (!s.startsWith('Exibindo')) flags.push(s);
    }
    const r = d.results[0];
    const rows = r?.content || [];
    if (rows.length === 0) break;
    out.push(...rows);
    if (rows.length < SIZE) break;
    page += 1;
  }
  return { rows: out, flags };
}

// ---------------------------------------------------------------------------
// Per-ticker pipeline
// ---------------------------------------------------------------------------
async function processTicker(ticker, histFilter) {
  const record = {
    ticker,
    url_base: `https://data.anbima.com.br/debentures/${ticker}`,
    caracteristicas: null,
    precos: null,
    agenda: null,
    errors: [],
  };

  try {
    record.caracteristicas = await fetchCaracteristicas(ticker);
  } catch (e) {
    record.errors.push(`caracteristicas: ${e.message}`);
  }

  try {
    record.precos = await fetchPrecos(ticker, histFilter);
  } catch (e) {
    record.errors.push(`precos: ${e.message}`);
  }

  try {
    const ag = await fetchAgenda(ticker);
    record.agenda = { rows: ag.rows, flags: ag.flags };
  } catch (e) {
    record.errors.push(`agenda: ${e.message}`);
  }

  return record;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function ensureDir(path) {
  const d = dirname(path);
  if (d && !existsSync(d)) mkdirSync(d, { recursive: true });
}

function loadOutput(path) {
  if (!existsSync(path)) return [];
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return [];
  }
}

function saveOutput(path, records) {
  ensureDir(path);
  writeFileSync(path, JSON.stringify(records, null, 2), 'utf8');
}

async function main() {
  const histFilter = buildHistFilter(HIST);

  const listing = JSON.parse(readFileSync(INPUT, 'utf8'));
  // Parse ticker from the URL path — title can carry concatenated badges
  // like "ABFR12Lei 12.431" that the listing's split-on-whitespace heuristic
  // fails to strip (when the badge has no leading space).
  const tickerFromUrl = (url) => {
    const m = /\/debentures\/([^/?]+)/i.exec(url || '');
    return m ? m[1].toUpperCase() : null;
  };
  const tickers = listing.map((entry) => tickerFromUrl(entry.url)).filter(Boolean);

  console.log(`Loaded ${tickers.length} tickers from ${INPUT}`);
  console.log(`Mode: --historico ${HIST} (filter=${histFilter ? 'yes' : 'no'})`);
  console.log(`Output: ${OUTPUT} (resume=${RESUME})`);

  let existing = RESUME ? loadOutput(OUTPUT) : [];
  const seen = new Set(existing.map((r) => r.ticker));

  const slice = tickers.slice(START, START + LIMIT);
  console.log(`Processing ${slice.length} tickers (start=${START}, limit=${LIMIT === Infinity ? 'all' : LIMIT})`);

  const t0 = Date.now();
  let done = 0;
  let skipped = 0;
  let failed = 0;

  for (const ticker of slice) {
    if (seen.has(ticker)) {
      skipped += 1;
      continue;
    }

    const ts = Date.now();
    let record;
    try {
      record = await processTicker(ticker, histFilter);
    } catch (e) {
      record = { ticker, errors: [`fatal: ${e.message}`] };
      failed += 1;
    }

    existing.push(record);
    saveOutput(OUTPUT, existing);
    done += 1;

    const elapsed = ((Date.now() - ts) / 1000).toFixed(2);
    const total = ((Date.now() - t0) / 1000).toFixed(1);
    const errCount = record.errors?.length ?? 0;
    const cFields  = record.caracteristicas ? Object.keys(record.caracteristicas).length : 0;
    const pInd     = record.precos?.indicativo?.length ?? 0;
    const pHist    = record.precos?.historico?.length ?? 0;
    const aRows    = record.agenda?.rows?.length ?? 0;
    if (!QUIET) {
      console.log(
        `  [${done}/${slice.length}] ${ticker} ${elapsed}s | c=${cFields} p=${pInd}+${pHist} a=${aRows}` +
        (errCount ? ` | errors=${errCount}` : '') +
        ` | total=${total}s`,
      );
    }

    if (DELAY > 0) await sleep(DELAY);
  }

  const elapsedTotal = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(``);
  console.log(`Done. ${done} processed, ${skipped} skipped, ${failed} fatal in ${elapsedTotal}s`);
  console.log(`Average: ${(elapsedTotal / Math.max(done, 1)).toFixed(2)}s/ticker`);
  console.log(`Saved to ${OUTPUT}`);
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
