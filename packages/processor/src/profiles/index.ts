/**
 * Profile registry — loads profiles by name.
 */

import type { Profile } from './types.js';
import googleWeb from './google_web.js';
import googleNews from './google_news.js';
import base from './base.js';
import anbimaDebentures from './anbima_debentures.js';
import anbimaDebentureCaracteristicas from './anbima_debenture_caracteristicas.js';
import anbimaDebenturePrecos from './anbima_debenture_precos.js';
import anbimaDebentureAgenda from './anbima_debenture_agenda.js';

const profiles: Record<string, Profile> = {
  google_web: googleWeb,
  google_news: googleNews,
  base,
  anbima_debentures: anbimaDebentures,
  anbima_debenture_caracteristicas: anbimaDebentureCaracteristicas,
  anbima_debenture_precos: anbimaDebenturePrecos,
  anbima_debenture_agenda: anbimaDebentureAgenda,
};

export function getProfile(name: string): Profile | null {
  return profiles[name] || null;
}

export function listProfiles(): string[] {
  return Object.keys(profiles);
}

export type { Profile, ExtractionOutput, ExtractResult } from './types.js';
