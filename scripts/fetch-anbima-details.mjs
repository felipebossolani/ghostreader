#!/usr/bin/env node
/**
 * Bulk fetcher for ANBIMA Data per-debenture pages.
 *
 * This is the JSON path: instead of scraping the rendered HTML and parsing
 * with cheerio, we navigate the SPA in Camoufox and intercept the XHR/fetch
 * responses the SPA itself consumes from the data-api.prd.anbima.com.br
 * /web-bff/v1/debentures/* endpoints. The captured JSON is structured,
 * carries ISO dates and typed numbers, and is what feeds the rendered UI
 * — so it is by definition the canonical view.
 *
 * Usage:
 *   node scripts/fetch-anbima-details.mjs [options]
 *
 * Options:
 *   --input <path>        Listing JSON (default: debentures.json)
 *   --output <path>       Output file (default: details.json)
 *   --historico <window>  D-30 (default) | M-1 | D-N | full
 *   --scraper-url <url>   Scraper service (default: http://localhost:8090)
 *   --delay <ms>          Sleep between tickers (default: 200)
 *   --retry <n>           Retries per failed scrape (default: 5)
 *   --timeout <ms>        Per-call timeout (default: 30000)
 *   --resume              Skip tickers already present in output
 *   --limit <n>           Process only first N tickers
 *   --start <n>           Skip the first N tickers
 *   --quiet               Suppress per-ticker line, keep only summary
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
const SCRAPER = (process.env.SCRAPER_URL || flags['scraper-url'] || 'http://localhost:8090').replace(/\/$/, '');
const DELAY   = parseInt(flags.delay   || '200', 10);
const RETRY   = parseInt(flags.retry   || '5', 10);
const TIMEOUT = parseInt(flags.timeout || '30000', 10);
const RESUME  = flags.resume === 'true';
const LIMIT   = flags.limit ? parseInt(flags.limit, 10) : Infinity;
const START   = flags.start ? parseInt(flags.start, 10) : 0;
const QUIET   = flags.quiet === 'true';
const SIZE    = 100;

// ---------------------------------------------------------------------------
// History window predicate (operates on JS Date — XHR data is ISO)
// ---------------------------------------------------------------------------
function buildHistFilter(spec) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  if (spec === 'full') return null;

  if (spec === 'M-1') {
    const start = new Date(today.getFullYear(), today.getMonth() - 1, 1);
    const end   = new Date(today.getFullYear(), today.getMonth(), 0, 23, 59, 59);
    return (d) => d >= start && d <= end;
  }

  const m = /^D-(\d+)$/.exec(spec);
  if (!m) {
    throw new Error(`Invalid --historico value: ${spec}. Expected D-N, M-1, or full.`);
  }
  const days = parseInt(m[1], 10);
  const start = new Date(today.getTime() - days * 86400_000);
  return (d) => d >= start && d <= today;
}

// ---------------------------------------------------------------------------
// HTTP with retry
// ---------------------------------------------------------------------------
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Drive the scraper to load `url` in a headless browser and capture every
 * XHR/fetch hitting the ANBIMA data API. Returns the array of successful
 * (status 200) responses with parsed JSON bodies.
 */
async function scrapeAndCollect(url, opts = {}, attempt = 1) {
  const body = {
    url,
    wait_after_load: opts.waitAfterLoad ?? 1.5,
    timeout: TIMEOUT,
    wait_until: 'domcontentloaded',
    collect_xhrs: ['data-api.prd.anbima.com.br/web-bff/v1/debentures/'],
  };
  if (opts.waitForFunction) body.wait_for_function = opts.waitForFunction;
  if (opts.waitForSelector) body.wait_for_selector = opts.waitForSelector;

  try {
    const res = await fetch(`${SCRAPER}/scrape`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    if (data.error) throw new Error(`scrape error: ${String(data.error).slice(0, 200)}`);
    return (data.xhrs || []).filter((x) => x.status === 200);
  } catch (err) {
    if (attempt >= RETRY) throw err;
    const backoff = 1000 * Math.pow(2, attempt - 1);
    if (!QUIET) console.error(`    retry ${attempt}/${RETRY - 1} after ${backoff}ms (${err.message.slice(0, 80)})`);
    await sleep(backoff);
    return scrapeAndCollect(url, opts, attempt + 1);
  }
}

/**
 * Pick the first XHR whose URL matches the regex AND whose body is a parsed
 * JSON object (not an error placeholder). Returns the body, or null.
 */
function pickXhrBody(xhrs, urlPattern) {
  for (const x of xhrs) {
    if (urlPattern.test(x.url) && x.body && typeof x.body === 'object' && !x.body.__parse_error__) {
      return x.body;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Per-endpoint helpers (operate on captured XHRs)
// ---------------------------------------------------------------------------

/**
 * Visit /caracteristicas — captures /v1/debentures/{T} (info geral) and
 * /v1/debentures/{T}/caracteristicas (rich info).
 */
async function fetchInfoAndCaracteristicas(ticker) {
  const xhrs = await scrapeAndCollect(
    `https://data.anbima.com.br/debentures/${ticker}/caracteristicas`,
    { waitAfterLoad: 1.5 },
  );
  const tickerEsc = ticker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return {
    info: pickXhrBody(xhrs, new RegExp(`/v1/debentures/${tickerEsc}$`)),
    caracteristicas: pickXhrBody(xhrs, new RegExp(`/v1/debentures/${tickerEsc}/caracteristicas$`)),
  };
}

/**
 * Visit /precos?page=1 — captures /precos summary, /precos/pu-historico
 * page 0, and the indicative-history graph.
 */
async function fetchPrecosFirstPage(ticker) {
  const xhrs = await scrapeAndCollect(
    `https://data.anbima.com.br/debentures/${ticker}/precos?page=1&size=${SIZE}`,
    { waitAfterLoad: 1.5 },
  );
  const tickerEsc = ticker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return {
    summary: pickXhrBody(xhrs, new RegExp(`/v1/debentures/${tickerEsc}/precos$`)),
    historico: pickXhrBody(xhrs, new RegExp(`/v1/debentures/${tickerEsc}/precos/pu-historico\\?`)),
    grafico: pickXhrBody(xhrs, new RegExp(`/v1/debentures/${tickerEsc}/grafico-pu-historico-indicativo`)),
  };
}

/** Visit /precos?page=N — only need the pu-historico XHR. Cache-bust on
 *  paginations beyond page 1 because the SPA sometimes serves stale state
 *  when only the page= param changes (observed AALR13 stopping at page=3). */
async function fetchHistoricoPage(ticker, oneIndexedPage, attempt = 1) {
  const bust = oneIndexedPage > 1 ? `&_=${Date.now()}-${attempt}` : '';
  const url = `https://data.anbima.com.br/debentures/${ticker}/precos?page=${oneIndexedPage}&size=${SIZE}${bust}`;
  const xhrs = await scrapeAndCollect(url, { waitAfterLoad: 1.5 });
  const tickerEsc = ticker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const apiPage = oneIndexedPage - 1;
  const body = pickXhrBody(
    xhrs,
    new RegExp(`/v1/debentures/${tickerEsc}/precos/pu-historico\\?page=${apiPage}\\b`),
  );
  // One-shot recovery: re-issue with a fresh cache-bust if no body captured.
  if (!body && attempt < 2) {
    return fetchHistoricoPage(ticker, oneIndexedPage, attempt + 1);
  }
  return body;
}

/** Visit /agenda?page=N — only need the agenda XHR. */
async function fetchAgendaPage(ticker, oneIndexedPage, attempt = 1) {
  const bust = oneIndexedPage > 1 ? `&_=${Date.now()}-${attempt}` : '';
  const url = `https://data.anbima.com.br/debentures/${ticker}/agenda?page=${oneIndexedPage}&size=${SIZE}${bust}`;
  const xhrs = await scrapeAndCollect(url, { waitAfterLoad: 1.5 });
  const tickerEsc = ticker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const apiPage = oneIndexedPage - 1;
  const body = pickXhrBody(
    xhrs,
    new RegExp(`/v1/debentures/${tickerEsc}/agenda\\?page=${apiPage}\\b`),
  );
  if (!body && attempt < 2 && oneIndexedPage > 1) {
    return fetchAgendaPage(ticker, oneIndexedPage, attempt + 1);
  }
  return body;
}

// ---------------------------------------------------------------------------
// Per-ticker pipeline
// ---------------------------------------------------------------------------
async function processTicker(ticker, histFilter) {
  const record = {
    ticker,
    url_base: `https://data.anbima.com.br/debentures/${ticker}`,
    fetched_at: new Date().toISOString(),
    info: null,
    caracteristicas: null,
    precos: {
      summary: null,
      grafico: null,
      historico: [],
      historico_total: null,
      historico_complete: null,
    },
    agenda: {
      rows: [],
      total: null,
      complete: null,
    },
    errors: [],
    flags: [],
  };

  // Step 1: caracteristicas page → info + caracteristicas
  try {
    const t = await fetchInfoAndCaracteristicas(ticker);
    record.info = t.info;
    record.caracteristicas = t.caracteristicas;
    if (!t.info && !t.caracteristicas) record.flags.push('info: no_xhr_captured');
  } catch (e) {
    record.errors.push(`info: ${e.message}`);
  }

  // Step 2: precos page 1 → summary + grafico + historico page 0
  try {
    const fp = await fetchPrecosFirstPage(ticker);
    record.precos.summary = fp.summary;
    record.precos.grafico = fp.grafico;
    if (fp.historico) {
      record.precos.historico_total = fp.historico.total_elements ?? null;
      record.precos.historico.push(...(fp.historico.content || []));
    } else {
      record.flags.push('precos_historico: no_xhr_captured');
    }
  } catch (e) {
    record.errors.push(`precos: ${e.message}`);
  }

  // Step 3: paginate historico per --historico mode
  await paginateHistorico(record, ticker, histFilter);

  // Step 4: agenda (always paginate to end; cheap relative to historico)
  await paginateAgenda(record, ticker);

  return record;
}

async function paginateHistorico(record, ticker, histFilter) {
  const total = record.precos.historico_total;
  const haveAll = (count) => total != null && count >= total;

  if (histFilter === null) {
    // FULL mode: walk to end
    if (total != null && total > SIZE) {
      const lastPage = Math.ceil(total / SIZE);
      for (let p = 2; p <= lastPage; p++) {
        try {
          const body = await fetchHistoricoPage(ticker, p);
          if (!body || !body.content?.length) {
            record.flags.push(`precos_historico: missing_page=${p}`);
            break;
          }
          record.precos.historico.push(...body.content);
        } catch (e) {
          record.errors.push(`precos page ${p}: ${e.message}`);
          break;
        }
      }
    }
    record.precos.historico_complete = haveAll(record.precos.historico.length);
  } else {
    // D-N or M-1: filter by date window. The API returns rows in DESC date
    // order, so once a row falls outside the window, all subsequent rows are
    // also outside.
    const inWindow = [];
    for (const row of record.precos.historico) {
      const d = new Date(row.data_referencia);
      if (histFilter(d)) inWindow.push(row);
    }
    // If page 0 was fully inside the window, paginate forward until a row
    // crosses the boundary.
    let needMore = inWindow.length === record.precos.historico.length
      && record.precos.historico.length === SIZE
      && (total == null || total > SIZE);

    let page = 2;
    while (needMore) {
      try {
        const body = await fetchHistoricoPage(ticker, page);
        const rows = body?.content || [];
        if (rows.length === 0) break;
        let crossed = false;
        for (const row of rows) {
          const d = new Date(row.data_referencia);
          if (histFilter(d)) inWindow.push(row);
          else { crossed = true; break; }
        }
        if (crossed || rows.length < SIZE) break;
        page += 1;
      } catch (e) {
        record.errors.push(`precos page ${page}: ${e.message}`);
        break;
      }
    }

    record.precos.historico = inWindow;
    record.precos.historico_complete = true; // by construction (filtered to window)
  }
}

async function paginateAgenda(record, ticker) {
  let p = 1;
  while (true) {
    try {
      const body = await fetchAgendaPage(ticker, p);
      if (!body) {
        if (p === 1) record.flags.push('agenda: no_xhr_captured');
        break;
      }
      if (p === 1) record.agenda.total = body.total_elements ?? null;
      const rows = body.content || [];
      record.agenda.rows.push(...rows);
      if (rows.length < SIZE) break;
      p += 1;
    } catch (e) {
      record.errors.push(`agenda page ${p}: ${e.message}`);
      break;
    }
  }
  record.agenda.complete = record.agenda.total != null
    ? record.agenda.rows.length >= record.agenda.total
    : record.agenda.rows.length > 0;
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
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { return []; }
}

function saveOutput(path, records) {
  ensureDir(path);
  writeFileSync(path, JSON.stringify(records, null, 2), 'utf8');
}

async function main() {
  const histFilter = buildHistFilter(HIST);

  const listing = JSON.parse(readFileSync(INPUT, 'utf8'));
  const tickerFromUrl = (url) => {
    const m = /\/debentures\/([^/?]+)/i.exec(url || '');
    return m ? m[1].toUpperCase() : null;
  };
  const tickers = listing.map((entry) => tickerFromUrl(entry.url)).filter(Boolean);

  console.log(`Loaded ${tickers.length} tickers from ${INPUT}`);
  console.log(`Mode: --historico ${HIST} (filter=${histFilter ? 'yes' : 'no'})`);
  console.log(`Output: ${OUTPUT} (resume=${RESUME})`);
  console.log(`Scraper: ${SCRAPER} | delay=${DELAY}ms retry=${RETRY} timeout=${TIMEOUT}ms`);

  let existing = RESUME ? loadOutput(OUTPUT) : [];
  const seen = new Set(existing.map((r) => r.ticker));

  const slice = tickers.slice(START, START + LIMIT);
  console.log(`Processing ${slice.length} tickers (start=${START}, limit=${LIMIT === Infinity ? 'all' : LIMIT})`);

  const t0 = Date.now();
  let done = 0, skipped = 0, failed = 0;

  for (const ticker of slice) {
    if (seen.has(ticker)) { skipped += 1; continue; }

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

    const el = ((Date.now() - ts) / 1000).toFixed(2);
    const total = ((Date.now() - t0) / 1000).toFixed(1);
    const errs = record.errors?.length ?? 0;
    const histLen = record.precos?.historico?.length ?? 0;
    const histTot = record.precos?.historico_total ?? '?';
    const agLen = record.agenda?.rows?.length ?? 0;
    const agTot = record.agenda?.total ?? '?';
    const cFields = (record.caracteristicas ? Object.keys(record.caracteristicas).length : 0);
    if (!QUIET) {
      console.log(
        `  [${done}/${slice.length}] ${ticker} ${el}s | c=${cFields} h=${histLen}/${histTot} a=${agLen}/${agTot}` +
        (errs ? ` | errors=${errs}` : '') +
        ` | total=${total}s`,
      );
    }
    if (DELAY > 0) await sleep(DELAY);
  }

  const total = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(``);
  console.log(`Done. ${done} processed, ${skipped} skipped, ${failed} fatal in ${total}s`);
  console.log(`Average: ${(total / Math.max(done, 1)).toFixed(2)}s/ticker`);
  console.log(`Saved to ${OUTPUT}`);
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
