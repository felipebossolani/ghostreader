/**
 * Helpers shared by ANBIMA debenture profiles.
 */

import type { CheerioAPI, Cheerio } from 'cheerio';

/** "Data do evento" → "data_do_evento", "% PU Par" → "pct_pu_par". */
export function normalizeKey(label: string): string {
  return label
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .trim()
    .replace(/%/g, 'pct ')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/** Pull ticker (e.g. "AALM12") from a /debentures/{TICKER}/... URL. */
export function tickerFromUrl(url: string): string {
  const m = url.match(/\/debentures\/([^/]+)/i);
  return m ? m[1].toUpperCase() : '';
}

/** Tidy whitespace and collapse internal runs of spaces. */
export function cleanText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Parse a <table> into an array of row objects keyed by header.
 * Headers are normalized via {@link normalizeKey}. Cells with "-" become "".
 */
export function tableToRows(
  $: CheerioAPI,
  table: Cheerio<any>,
): Array<Record<string, string>> {
  const headerText = (th: Cheerio<any>) => {
    // strip tooltip spans / svg before reading text — ANBIMA injects an "(i)"
    // tooltip into many headers whose body holds long methodology blurbs.
    const clone = th.clone();
    clone.find('[class*="tooltip"], svg').remove();
    return normalizeKey(clone.text());
  };

  const headers: string[] = [];
  table.find('thead tr').first().find('th, td').each((_, th) => {
    headers.push(headerText($(th)));
  });

  // Fallback: some layouts put headers in the first <tr> with no <thead>
  if (headers.length === 0) {
    table.find('tr').first().find('th, td').each((_, th) => {
      headers.push(headerText($(th)));
    });
  }

  const rows: Array<Record<string, string>> = [];
  const bodyRows = table.find('tbody tr').length
    ? table.find('tbody tr')
    : table.find('tr').slice(1);

  bodyRows.each((_, tr) => {
    const row: Record<string, string> = {};
    $(tr).find('td').each((i, td) => {
      const key = headers[i] || `col_${i}`;
      const value = cleanText($(td).text());
      row[key] = value === '-' ? '' : value;
    });
    if (Object.keys(row).length) rows.push(row);
  });

  return rows;
}

/**
 * Find the table that follows (or contains) a heading whose text matches `pattern`.
 * ANBIMA wraps each section as: <heading>...</heading> ... <table>...</table>
 * — possibly nested in extra wrappers, so we walk up + search.
 */
export function findTableNear(
  $: CheerioAPI,
  pattern: RegExp,
): Cheerio<any> | null {
  let found: Cheerio<any> | null = null;
  $('h1, h2, h3, h4, h5, h6, [class*="title"], [class*="heading"], p.large-text-bold').each((_, el) => {
    if (found) return;
    const text = cleanText($(el).text());
    if (!pattern.test(text)) return;

    // climb ancestors until we find one that contains a <table>
    let scope = $(el).parent();
    for (let i = 0; i < 6 && scope.length; i++) {
      const t = scope.find('table').first();
      if (t.length) {
        found = t;
        return;
      }
      scope = scope.parent();
    }
  });
  return found;
}
