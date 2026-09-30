/**
 * Who may touch an offer through the PUBLIC offer routes (N0, dev job f907220c).
 *
 * Every /api/offers/* route a client's browser calls resolves access here, once,
 * the same way — so no route can quietly accept less than the others.
 *
 *   • An OFFER needs its access code (constant-time, rate-limited, fails closed on
 *     a blank code — lib/esign/access-guard.ts) or a genuine STAFF session asking
 *     for preview. The token alone is never enough: tokens are the client's name
 *     plus the year.
 *   • A RENEWAL agreement (no access code exists) needs a portal pass / grant bound
 *     to that agreement (lib/offers/renewal-pass.ts) or a staff preview.
 *
 * Staff preview uses isStaffUser (admin/team) — NOT isDashboardUser, which also
 * lets a partner through. A query flag alone is never proof of staff (see the
 * 2026-07-21 incident in lib/auth/staff-preview.ts).
 *
 * Flat result shape (not a union on a boolean) because this repo compiles with
 * strict:false — callers branch on `error` being non-null.
 */

import type { NextRequest } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { accessCodeError } from '@/lib/esign/access-guard'
import { createClient } from '@/lib/supabase/server'
import { isStaffUser } from '@/lib/auth'
import { verifyRenewalPass } from '@/lib/offers/renewal-pass'

export interface PublicOfferAccess {
  error: string | null
  status: number
  kind: 'offer' | 'renewal' | null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  offer: any | null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  agreement: any | null
  /** True when access came from a real staff session in preview mode (no tracking). */
  staffPreview: boolean
}

function denied(status: number, error: string): PublicOfferAccess {
  return { error, status, kind: null, offer: null, agreement: null, staffPreview: false }
}

/** A genuine admin/team session. Fails closed on any auth problem. */
export async function hasStaffSession(): Promise<boolean> {
  try {
    const supabase = createClient()
    const { data, error } = await supabase.auth.getUser()
    if (error) return false
    return isStaffUser(data?.user ?? null)
  } catch {
    return false
  }
}

export async function resolvePublicOfferAccess(
  req: NextRequest,
  input: { token?: string | null; code?: string | null; pass?: string | null; preview?: boolean },
  opts: { offerColumns?: string; renewalColumns?: string } = {},
): Promise<PublicOfferAccess> {
  const token = typeof input.token === 'string' ? input.token.trim() : ''
  if (!token) return denied(400, 'Missing offer link.')

  const { data: offer } = await supabaseAdmin
    .from('offers')
    .select(opts.offerColumns || '*')
    .eq('token', token)
    .maybeSingle()

  const staffPreview = input.preview === true ? await hasStaffSession() : false

  if (offer) {
    if (staffPreview) {
      return { error: null, status: 200, kind: 'offer', offer, agreement: null, staffPreview: true }
    }
    const codeErr = accessCodeError(req, {
      token,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expected: String((offer as any).access_code || ''),
      provided: typeof input.code === 'string' ? input.code : '',
      isPreview: false,
    })
    if (codeErr) return denied(codeErr.status === 403 ? 404 : codeErr.status, codeErr.status === 403 ? 'Offer not found.' : codeErr.error)
    return { error: null, status: 200, kind: 'offer', offer, agreement: null, staffPreview: false }
  }

  // Not an offer — maybe an annual renewal agreement.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: agreement } = await (supabaseAdmin as any)
    .from('annual_agreements')
    .select(opts.renewalColumns || '*')
    .eq('token', token)
    .maybeSingle()
  if (!agreement) return denied(404, 'Offer not found.')

  if (staffPreview) {
    return { error: null, status: 200, kind: 'renewal', offer: null, agreement, staffPreview: true }
  }
  const pass = await verifyRenewalPass(input.pass, String(agreement.id))
  if (!pass) {
    return denied(403, 'Please open your annual agreement from your client portal.')
  }
  return { error: null, status: 200, kind: 'renewal', offer: null, agreement, staffPreview: false }
}
