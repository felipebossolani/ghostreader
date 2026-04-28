/**
 * Shared types for extraction profiles.
 */

export interface ExtractResult {
  url: string;
  title: string;
  content: string | Record<string, string> | Array<Record<string, string>>;
  thumbnail?: string;
}

export interface ExtractionOutput {
  results: ExtractResult[];
  suggestions: string[];
}

export interface Profile {
  name: string;
  captchaPatterns: string[];
  waitForSelector?: string;
  /**
   * Optional JS predicate (function body) the scraper evaluates in the page
   * context after `waitForSelector` matches. Snapshot is taken only once it
   * returns truthy. Use for SPAs that hydrate cells progressively.
   * Example: `() => document.querySelectorAll('.skeleton-container').length === 0`
   */
  waitForFunction?: string;
  waitAfterLoad: number;
  extract: (html: string, url: string, options?: Record<string, string>) => ExtractionOutput;
}
