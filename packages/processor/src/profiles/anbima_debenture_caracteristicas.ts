/**
 * ANBIMA Data — Debenture detail (Características) extraction profile.
 *
 * URL pattern: https://data.anbima.com.br/debentures/{TICKER}/caracteristicas
 *
 * The page uses 4 distinct markup patterns for label/value pairs:
 *
 *   1. Sidebar header (Emissor, Setor):
 *        <dl><dt>Emissor</dt><dd>...</dd></dl>
 *
 *   2. Sidebar metadata (Data de emissão, Data de vencimento, Remuneração):
 *        <li><span class="small-text">label</span><span class="normal-text">value</span></li>
 *
 *   3. Sidebar prices (Taxa indicativa, PU Indicativo, PU PAR) — title contains
 *      a "(ref. dd/mm/yyyy)" span we strip before keying:
 *        <li class="lower-card-item">
 *          <p class="lower-card-item-title">Taxa indicativa <span>(ref. ...)</span></p>
 *          <p class="lower-card-item-value">0,8329 %</p>
 *        </li>
 *
 *   4. Body section (1ª Série — Remuneração, ISIN, datas, prazos, etc):
 *        <div class="anbima-ui-output__container">
 *          <span class="anbima-ui-output__label">Remuneração</span>
 *          <div class="anbima-ui-output__container--details">
 *            <span class="anbima-ui-output__value">DI + 1,6000%</span>
 *          </div>
 *        </div>
 */

import * as cheerio from 'cheerio';
import type { Profile, ExtractionOutput } from './types.js';
import { normalizeKey, tickerFromUrl, cleanText } from './anbima_utils.js';

const anbimaDebentureCaracteristicas: Profile = {
  name: 'anbima_debenture_caracteristicas',
  captchaPatterns: [],
  // The body section renders last; wait for one of its containers.
  waitForSelector: '.anbima-ui-output__container',
  waitAfterLoad: 3,

  extract(html: string, url: string): ExtractionOutput {
    const $ = cheerio.load(html);
    const fields: Record<string, string> = {};

    const set = (rawLabel: string, rawValue: string) => {
      const label = cleanText(rawLabel).replace(/\s*\([^)]*\)\s*$/, '');
      if (!label) return;
      const key = normalizeKey(label);
      const value = cleanText(rawValue);
      if (!key) return;
      // First occurrence wins (sidebar prices come before body, body is more authoritative
      // for some fields — but values are identical, so order doesn't matter in practice).
      if (!(key in fields)) {
        fields[key] = value === '-' ? '' : value;
      }
    };

    // Pattern 1: <dl><dt>label</dt><dd>value</dd></dl>
    $('dl').each((_, el) => {
      const dl = $(el);
      const dt = dl.find('dt').first();
      const dd = dl.find('dd').first();
      if (dt.length && dd.length) set(dt.text(), dd.text());
    });

    // Pattern 2: <li><span.small-text>label</span><span.normal-text>value</span></li>
    $('li').each((_, el) => {
      const li = $(el);
      const label = li.children('span.small-text').first();
      const value = li.children('span.normal-text').first();
      if (label.length && value.length) set(label.text(), value.text());
    });

    // Pattern 3: <li.lower-card-item><p.lower-card-item-title>...<p.lower-card-item-value>
    $('li.lower-card-item').each((_, el) => {
      const li = $(el);
      // strip any nested <span> from the title (it holds "(ref. dd/mm/yyyy)")
      const titleEl = li.find('.lower-card-item-title').first().clone();
      titleEl.find('span').remove();
      const valueEl = li.find('.lower-card-item-value').first();
      if (titleEl.length && valueEl.length) set(titleEl.text(), valueEl.text());
    });

    // Pattern 4: body — <div.anbima-ui-output__container> with label/value spans.
    // The label may contain a tooltip span with metadata text we must strip.
    $('.anbima-ui-output__container').each((_, el) => {
      const container = $(el);
      const labelEl = container.children('.anbima-ui-output__label').first().clone();
      labelEl.find('[class*="tooltip"], [role="tooltip"], svg').remove();
      const value = container
        .find('.anbima-ui-output__container--details .anbima-ui-output__value')
        .first();
      if (labelEl.length && value.length) set(labelEl.text(), value.text());
    });

    return {
      results: [
        {
          url,
          title: tickerFromUrl(url),
          content: fields,
        },
      ],
      suggestions: [],
    };
  },
};

export default anbimaDebentureCaracteristicas;
