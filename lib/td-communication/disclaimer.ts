/**
 * TD Communication — disclaimer pure logic (no DB / no I/O).
 *
 * Backs the Phase 7 click-to-accept disclaimer gate that precedes the logo
 * reveal. Kept side-effect-free so it is unit-testable without a database
 * (R086). The DB-backed acceptance log lives in ./disclaimer-queries.ts.
 *
 * disclaimerVersion() is a CONTENT HASH of the exact EN+IT wording the client
 * saw — recorded on every acceptance so the legal trail ties to the precise
 * terms, and so editing the disclaimer (CRM Settings tab) automatically re-gates
 * the client on the new wording (the version-keyed acceptance check in
 * disclaimer-queries.ts::hasAcceptedDisclaimer no longer finds a row).
 */

import { createHash } from 'node:crypto'
import type { Locale } from '@/lib/portal/i18n'
import type { EnrollmentStatus, TdCommSettings } from './types'

/* -------------------------------------------------------------------------- */
/* Default disclaimer text (fallback when Settings leaves it blank)            */
/* -------------------------------------------------------------------------- */

/** Default EN disclaimer — used when td_communication_settings.disclaimer_en is blank. */
export const DEFAULT_DISCLAIMER_EN =
  'By viewing this brand concept, you agree that this design is the exclusive ' +
  'property of TD Communication. Any unauthorized reproduction, distribution, ' +
  'or use of this design will result in a penalty of $10,000 USD. This concept ' +
  'is provided for your review only and may not be copied, recreated, or shared ' +
  'without express written consent.'

/** Default IT disclaimer — used when td_communication_settings.disclaimer_it is blank. */
export const DEFAULT_DISCLAIMER_IT =
  'Visualizzando questo concept del brand, accetti che questo design è di ' +
  'proprietà esclusiva di TD Communication. Qualsiasi riproduzione, ' +
  'distribuzione o utilizzo non autorizzato di questo design comporterà una ' +
  'penale di 10.000 USD. Questo concept è fornito esclusivamente per la tua ' +
  'revisione e non può essere copiato, ricreato o condiviso senza esplicito ' +
  'consenso scritto.'

/**
 * The disclaimer text for a locale: the Settings value when non-blank, else the
 * code default. IT falls back to the IT default (NOT the EN one) so an Italian
 * client never sees English terms.
 */
export function resolveDisclaimerText(
  settings: Pick<TdCommSettings, 'disclaimer_en' | 'disclaimer_it'> | null | undefined,
  locale: Locale,
): string {
  const en = settings?.disclaimer_en?.trim() ? settings.disclaimer_en.trim() : DEFAULT_DISCLAIMER_EN
  const it = settings?.disclaimer_it?.trim() ? settings.disclaimer_it.trim() : DEFAULT_DISCLAIMER_IT
  return locale === 'it' ? it : en
}

/**
 * Stable version identifier for the ACTIVE disclaimer wording: 'v1-' + the first
 * 10 hex chars of a sha256 over the resolved EN and IT text. Deterministic for a
 * given pair of strings; changes whenever either language's text changes.
 *
 * Pass the SAME resolved text (Settings value or default) that the client is
 * shown — recompute it server-side at accept time, never trust a client-sent
 * version.
 */
export function disclaimerVersion(en: string, it: string): string {
  const hash = createHash('sha256').update(`${en} ${it}`).digest('hex').slice(0, 10)
  return `v1-${hash}`
}

/**
 * The version for the current Settings (resolving blanks to the defaults first),
 * so callers get the exact version a client at this locale-agnostic moment would
 * accept. Combines resolveDisclaimerText (both locales) + disclaimerVersion.
 */
export function currentDisclaimerVersion(
  settings: Pick<TdCommSettings, 'disclaimer_en' | 'disclaimer_it'> | null | undefined,
): string {
  return disclaimerVersion(
    resolveDisclaimerText(settings, 'en'),
    resolveDisclaimerText(settings, 'it'),
  )
}

/* -------------------------------------------------------------------------- */
/* Status gating                                                               */
/* -------------------------------------------------------------------------- */

/** A concept is revealable to the client at concept_ready (gated) or approved. */
export function canRevealConcept(status: string): boolean {
  return status === ('concept_ready' satisfies EnrollmentStatus)
    || status === ('approved' satisfies EnrollmentStatus)
}

/** "I Love It" is valid only from concept_ready (forward-only; approved is a no-op). */
export function canApproveConcept(status: string): boolean {
  return status === ('concept_ready' satisfies EnrollmentStatus)
}
