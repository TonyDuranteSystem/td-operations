/**
 * TD Communication Phase 14 — showcase-consent data layer + wording (server-side).
 *
 * The client opt-in to be FEATURED publicly in the portfolio. Mirrors the Phase 7
 * disclaimer trail: a version = content hash of the exact wording shown (recorded
 * on every grant so the audit ties to precise terms); IP/user-agent are read
 * server-side by the route and passed in, never trusted from the body.
 *
 * td_comm_showcase_consents is RLS ON / NO policy — the browser never queries it;
 * these helpers use supabaseAdmin after the route authenticated the client (owns
 * the enrollment). The consent version hashing uses node:crypto, so this module is
 * SERVER-ONLY (kept out of the client-safe portfolio.ts, like disclaimer.ts).
 *
 * SOFT model: a granted consent is shown to the curator but does not block
 * publishing. A WITHDRAWAL, however, auto-unpublishes linked entries — that logic
 * lives in portfolio-queries.ts (unpublishEntriesForEnrollment); the route calls
 * both so the two modules stay decoupled (no import cycle).
 */

import { createHash } from 'node:crypto'
import { supabaseAdmin } from '@/lib/supabase-admin'
import type { Locale } from '@/lib/portal/i18n'
import type { ShowcaseConsent } from './types'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any

/* -------------------------------------------------------------------------- */
/* Consent wording + version                                                   */
/* -------------------------------------------------------------------------- */

/** Default EN showcase-consent wording (plain, friendly — this is opt-in, not a penalty clause). */
export const DEFAULT_SHOWCASE_CONSENT_EN =
  'I give TD Communication permission to feature my brand — including the logo and ' +
  'designs created for me — in its public portfolio and marketing materials. I can ' +
  'withdraw this permission at any time, and the work will be removed from the public ' +
  'portfolio.'

/** Default IT showcase-consent wording. */
export const DEFAULT_SHOWCASE_CONSENT_IT =
  'Autorizzo TD Communication a mostrare il mio brand — inclusi il logo e i design ' +
  'creati per me — nel suo portfolio pubblico e nei materiali di marketing. Posso ' +
  'revocare questa autorizzazione in qualsiasi momento e il lavoro verrà rimosso dal ' +
  'portfolio pubblico.'

/** The consent text for a locale (IT never falls back to EN). */
export function resolveShowcaseConsentText(locale: Locale): string {
  return locale === 'it' ? DEFAULT_SHOWCASE_CONSENT_IT : DEFAULT_SHOWCASE_CONSENT_EN
}

/** Stable version id for the wording: 'v1-' + sha256(en + ' ' + it)[:10]. */
export function showcaseConsentVersion(en: string, it: string): string {
  const hash = createHash('sha256').update(`${en} ${it}`).digest('hex').slice(0, 10)
  return `v1-${hash}`
}

/** Version for the current (default) wording — recompute server-side, never trust the client. */
export function currentShowcaseConsentVersion(): string {
  return showcaseConsentVersion(DEFAULT_SHOWCASE_CONSENT_EN, DEFAULT_SHOWCASE_CONSENT_IT)
}

/* -------------------------------------------------------------------------- */
/* Data access                                                                 */
/* -------------------------------------------------------------------------- */

function shapeConsent(row: Record<string, unknown> | null): ShowcaseConsent | null {
  if (!row) return null
  return {
    id: String(row.id),
    enrollment_id: (row.enrollment_id as string) ?? null,
    contact_id: (row.contact_id as string) ?? null,
    consent_version: String(row.consent_version ?? ''),
    granted_at: String(row.granted_at ?? ''),
    revoked_at: (row.revoked_at as string) ?? null,
    ip_address: (row.ip_address as string) ?? null,
    user_agent: (row.user_agent as string) ?? null,
    method: (row.method as 'click' | 'docusign') ?? 'click',
    created_at: String(row.created_at ?? ''),
  }
}

/** The most recent NON-revoked consent for an enrollment, or null. Drives the badge + client card. */
export async function getActiveConsentForEnrollment(enrollmentId: string): Promise<ShowcaseConsent | null> {
  const { data, error } = await db
    .from('td_comm_showcase_consents')
    .select('*')
    .eq('enrollment_id', enrollmentId)
    .is('revoked_at', null)
    .order('granted_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw new Error(error.message)
  return shapeConsent(data)
}

export interface GrantConsentInput {
  enrollmentId: string
  contactId: string | null
  version: string
  ipAddress: string | null
  userAgent: string | null
  method?: 'click' | 'docusign'
}

/**
 * Record a client's opt-in. Idempotent: if a NON-revoked consent for this
 * (enrollment, version) already exists, return it with { already: true } — a
 * double-click never spams the trail. A previously-revoked client re-granting
 * inserts a fresh row (its own granted_at).
 */
export async function grantShowcaseConsent(
  input: GrantConsentInput,
): Promise<{ consent: ShowcaseConsent; already: boolean }> {
  const { data: existing, error: exErr } = await db
    .from('td_comm_showcase_consents')
    .select('*')
    .eq('enrollment_id', input.enrollmentId)
    .eq('consent_version', input.version)
    .is('revoked_at', null)
    .order('granted_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (exErr) throw new Error(exErr.message)
  if (existing) return { consent: shapeConsent(existing)!, already: true }

  const { data, error } = await db
    .from('td_comm_showcase_consents')
    .insert({
      enrollment_id: input.enrollmentId,
      contact_id: input.contactId,
      consent_version: input.version,
      ip_address: input.ipAddress,
      user_agent: input.userAgent,
      method: input.method ?? 'click',
    })
    .select('*')
    .single()
  if (error) throw new Error(error.message)
  return { consent: shapeConsent(data)!, already: false }
}

/**
 * Withdraw consent: stamp revoked_at on every currently-active consent row for the
 * enrollment. Returns how many rows were revoked. The caller (route) then
 * unpublishes + cleans up any linked portfolio entries.
 */
export async function withdrawShowcaseConsent(enrollmentId: string): Promise<{ revoked: number }> {
  const { data, error } = await db
    .from('td_comm_showcase_consents')
    .update({ revoked_at: new Date().toISOString() })
    .eq('enrollment_id', enrollmentId)
    .is('revoked_at', null)
    .select('id')
  if (error) throw new Error(error.message)
  return { revoked: Array.isArray(data) ? data.length : 0 }
}
