/**
 * ANBIMA Data — Debenture event schedule (Agenda de eventos) extraction profile.
 *
 * URL pattern: https://data.anbima.com.br/debentures/{TICKER}/agenda?page=1&size=100
 *
 * Returns one result whose `content` is an array of event rows keyed by the
 * normalized column header: data_do_evento, data_de_liquidacao, evento,
 * percentual_taxa, valor_pago, status.
 *
 * For papers without a registered agenda, ANBIMA renders a "not found" page
 * (.anbima-ui-not-found-page) instead of the table. In that case the profile
 * returns no results and reports `agenda: not_found` in suggestions.
 *
 * Pagination is the caller's responsibility.
 */

import * as cheerio from 'cheerio';
import type { Profile, ExtractionOutput } from './types.js';
import { tickerFromUrl, tableToRows, cleanText } from './anbima_utils.js';

const anbimaDebentureAgenda: Profile = {
  name: 'anbima_debenture_agenda',
  captchaPatterns: [],
  // Wait for either the event table to fully hydrate (zero skeletons) or
  // for the not-found template (LTTE14-style) to appear instead.
  waitForSelector: 'tbody tr, .anbima-ui-not-found-page',
  waitForFunction:
    '(document.querySelector(".anbima-ui-not-found-page") !== null) || (document.querySelectorAll("tbody tr").length > 0 && document.querySelectorAll(".skeleton-container").length === 0)',
  waitAfterLoad: 0,

  extract(html: string, url: string): ExtractionOutput {
    const $ = cheerio.load(html);
    const ticker = tickerFromUrl(url);
    const results: ExtractionOutput['results'] = [];
    const suggestions: string[] = [];

    if ($('.anbima-ui-not-found-page').length) {
      suggestions.push('agenda: not_found');
      return { results, suggestions };
    }

    // Pick the first table whose header schema matches an event row. Falls
    // back to the first <table> if classification is inconclusive.
    let chosen: cheerio.Cheerio<any> | null = null;
    let rows: Array<Record<string, string>> = [];
    $('table').each((_, el) => {
      if (chosen) return;
      const t = $(el);
      const candidate = tableToRows($, t);
      if (candidate.length === 0) return;
      const keys = Object.keys(candidate[0]);
      // event rows always carry an event date column
      if (keys.includes('data_do_evento') || keys.some((k) => k.startsWith('evento'))) {
        chosen = t;
        rows = candidate;
      }
    });

    if (!chosen) {
      const first = $('table').first();
      if (first.length) {
        rows = tableToRows($, first);
      }
    }

    if (rows.length) {
      results.push({
        url,
        title: `${ticker} Agenda`,
        content: rows,
      });
    } else {
      suggestions.push('agenda: empty');
    }

    const paginationText = cleanText(
      $('body').text().match(/Exibindo\s+\d+\s*-\s*\d+\s+de\s+\d+\s+resultados?/i)?.[0] ?? '',
    );
    if (paginationText) suggestions.push(paginationText);

    return { results, suggestions };
  },
};

export default anbimaDebentureAgenda;
