/**
 * ANBIMA Data — Debenture prices (Preços) extraction profile.
 *
 * URL pattern: https://data.anbima.com.br/debentures/{TICKER}/precos?page=1&size=100
 *
 * Pages may render zero, one, or two pricing tables:
 *   - "PU Indicativo" — secondary-market reference prices (recent days). Absent
 *     when ANBIMA does not price the asset ("Este ativo não é precificado…").
 *   - "PU Histórico"  — daily PU PAR / VNA series since issue. Usually present;
 *     may be absent for very new or non-priced assets.
 *
 * Tables are classified by their *header schema*, not by document order — this
 * avoids the trap of duplicating the lone Histórico table when Indicativo is
 * missing.
 *
 * Each classified result's `content` is an array of rows keyed by normalized
 * column header (e.g. "data_de_referencia", "pu_par", "taxa_indicativa",
 * "pu_indicativo", "pct_pu_par").
 *
 * Pagination is the caller's responsibility — this profile only reads the
 * single rendered page. The "Exibindo X - Y de N resultados" footer is
 * surfaced via `suggestions` so callers can decide when to stop iterating.
 */

import * as cheerio from 'cheerio';
import type { Profile, ExtractionOutput } from './types.js';
import { tickerFromUrl, tableToRows, cleanText } from './anbima_utils.js';

type TableKind = 'indicativo' | 'historico' | null;

function classifyByHeaders(headers: string[]): TableKind {
  const set = new Set(headers);
  if (set.has('data_de_referencia')) return 'historico';
  if (set.has('data') && (set.has('taxa_indicativa') || set.has('pu_indicativo'))) {
    return 'indicativo';
  }
  return null;
}

const anbimaDebenturePrecos: Profile = {
  name: 'anbima_debenture_precos',
  captchaPatterns: [],
  // Page may legitimately have no <table> when asset is not priced — wait on
  // a generic content marker instead so we don't time out on those.
  waitForSelector: '.anbima-ui-card',
  waitAfterLoad: 3,

  extract(html: string, url: string): ExtractionOutput {
    const $ = cheerio.load(html);
    const ticker = tickerFromUrl(url);
    const results: ExtractionOutput['results'] = [];
    const suggestions: string[] = [];

    const seen: Record<TableKind & string, boolean> = {} as never;

    $('table').each((_, el) => {
      const t = $(el);
      const rows = tableToRows($, t);
      if (rows.length === 0) return;
      const headers = Object.keys(rows[0]);
      const kind = classifyByHeaders(headers);
      if (!kind) return;
      if (seen[kind]) return; // never duplicate a slot
      seen[kind] = true;
      results.push({
        url,
        title: kind === 'indicativo' ? `${ticker} PU Indicativo` : `${ticker} PU Histórico`,
        content: rows,
      });
    });

    // Surface page-level state for the caller.
    if (!seen.indicativo) {
      // ANBIMA prints a fixed disclaimer when an asset has no indicative price.
      const disclaimer = $('body').text().match(/Este ativo não é precificado pela ANBIMA/i);
      suggestions.push(disclaimer ? 'pu_indicativo: not_priced' : 'pu_indicativo: missing');
    }
    if (!seen.historico) suggestions.push('pu_historico: missing');

    const paginationText = cleanText(
      $('body').text().match(/Exibindo\s+\d+\s*-\s*\d+\s+de\s+\d+\s+resultados/i)?.[0] ?? '',
    );
    if (paginationText) suggestions.push(paginationText);

    return { results, suggestions };
  },
};

export default anbimaDebenturePrecos;
