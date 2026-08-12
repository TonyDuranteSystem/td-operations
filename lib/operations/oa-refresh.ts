/**
 * Die-on-change for the Operating Agreement — the OA twin of refreshSS4.
 *
 * When a company's membership changes under a LIVE (not yet fully signed)
 * Operating Agreement, the emailed co-signer links must stop working. The SS-4
 * job taught the hard lesson this file is built on:
 *
 *   ⛔ ROTATING THE ACCESS CODE ALONE DOES NOT REVOKE A MEMBER.
 *   The portal wrapper rebuilds a working signing link from a member's contact_id
 *   on demand, and removing a member from the company does not remove their
 *   account link. So revocation is MARKED ON THE SIGNATURE ROW (`revoked_at`) and
 *   every signing door refuses a revoked row. That flag is the backbone; code
 *   rotation is only defence-in-depth on top of it.
 *
 * Two outcomes when the change is material (lib/oa/signing-diff.ts decides):
 *   - NO signature collected yet  → VOID the agreement (atomic, guarded so it can
 *     never touch one that just collected a signature), rotate its shared code,
 *     revoke every signer row, and tell the creator to regenerate from the portal
 *     (the portal already renders a voided OA as "outdated — generate a new one").
 *   - A signature already collected → NEVER void, NEVER touch a signed row. Revoke
 *     only the UNSIGNED signer rows and raise a staff alert to reissue by hand.
 *
 * Best-effort by construction: it must never fail the member write that triggered
 * it. The caller wraps it in try/catch and ignores the result on error.
 *
 * A signed or already-voided agreement is out of scope — a fully executed
 * agreement is immutable, and a voided one is already dead.
 */

import { randomUUID } from 'crypto'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { diffSigningState, type DiffMemberRow } from '@/lib/oa/signing-diff'
import { notifyClientActionRequired } from '@/lib/portal/action-required'
import { reportSystemError } from '@/lib/system-errors'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any

/** A fresh strong code (128-bit) — used when rotating the shared code on void.
 *  Deliberately stronger than the legacy 8-hex default, answering the entropy
 *  finding: any code we rotate is minted long. */
function genCode(): string {
  return randomUUID().replace(/-/g, '')
}

export type OaRefreshOutcome =
  | 'no_oa' // no live agreement to act on
  | 'unchanged' // membership change was immaterial to every live agreement
  | 'voided' // an unsigned agreement was voided + its links killed
  | 'partial_revoked' // a partially-signed agreement's unsigned links were revoked

export interface OaRefreshResult {
  outcome: OaRefreshOutcome
  agreementId?: string
  reasons?: string[]
  /** How many unsigned signer rows were revoked (partial case). */
  revokedSigners?: number
}

const LIVE_STATUSES = ['draft', 'sent', 'viewed', 'partially_signed'] as const

export async function refreshOaForMemberChange(args: {
  account_id: string
  source: string
}): Promise<OaRefreshResult> {
  const { account_id, source } = args

  // Every non-terminal agreement for the account (newest first). A signed one is
  // immutable; a voided one is already dead — both excluded.
  const { data: agreements, error: agErr } = await db
    .from('oa_agreements')
    .select('id, token, status, entity_type, members, access_code, contact_id, company_name, signed_count, total_signers, created_at')
    .eq('account_id', account_id)
    .in('status', LIVE_STATUSES)
    .order('created_at', { ascending: false })

  if (agErr) {
    console.error('[oa-refresh] agreement lookup failed:', agErr.message)
    return { outcome: 'no_oa' }
  }
  if (!agreements || agreements.length === 0) return { outcome: 'no_oa' }

  // The company's CURRENT roster — the same shape the create route reads.
  const { data: liveRows } = await db
    .from('members')
    .select('id, full_name, company_name, email, ownership_pct, is_primary, contact_id, member_type, representative_name, representative_email')
    .eq('account_id', account_id)
  const liveMemberRows: DiffMemberRow[] = (liveRows ?? []) as DiffMemberRow[]

  const now = new Date().toISOString()
  let result: OaRefreshResult = { outcome: 'unchanged' }
  let voidedAny = false

  for (const ag of agreements) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: sigRows } = await db
      .from('oa_signatures')
      .select('id, member_index, member_name, member_email, contact_id, access_code, status')
      .eq('oa_id', ag.id)
      .order('member_index')
    const signatures = sigRows ?? []

    const diff = diffSigningState({
      agreementEntityType: ag.entity_type,
      pinnedMembers: ag.members ?? null,
      pinnedSignerRows: signatures,
      liveMemberRows,
    })
    if (!diff.material) continue

    const collected =
      ag.status === 'partially_signed' ||
      (ag.signed_count ?? 0) > 0 ||
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      signatures.some((s: any) => s.status === 'signed')

    if (!collected) {
      // ── VOID (unsigned) ──────────────────────────────────────────────────
      // Atomic + guarded: only a genuinely-unsigned row flips. signed_count=0 is
      // load-bearing — a signature write increments the counter BEFORE it flips
      // status to partially_signed, so this guard catches a signature that landed
      // in the read→write gap and REFUSES the void, dropping to the partial path.
      const { data: voided } = await db
        .from('oa_agreements')
        .update({ status: 'voided', access_code: genCode(), updated_at: now })
        .eq('id', ag.id)
        .in('status', ['draft', 'sent', 'viewed'])
        .eq('signed_count', 0)
        .select('id')

      if (voided && voided.length > 0) {
        // Kill every signer row (all unsigned by definition here).
        await db
          .from('oa_signatures')
          .update({ revoked_at: now, revoked_reason: `agreement voided — membership changed (${source})`, updated_at: now })
          .eq('oa_id', ag.id)
          .is('revoked_at', null)
        voidedAny = true
        result = { outcome: 'voided', agreementId: ag.id, reasons: diff.reasons }
        continue
      }
      // Void refused → a signature landed in the gap. Fall through to partial.
    }

    // ── PARTIAL (a signature exists, or a void just lost the race) ───────────
    // NEVER void, NEVER touch a signed row. Revoke only the unsigned links.
    const { data: revoked } = await db
      .from('oa_signatures')
      .update({ revoked_at: now, revoked_reason: `membership changed (${source})`, updated_at: now })
      .eq('oa_id', ag.id)
      .neq('status', 'signed')
      .is('revoked_at', null)
      .select('id')

    const revokedCount = revoked?.length ?? 0
    await reportSystemError({
      source: 'server',
      route: 'lib/operations/oa-refresh',
      method: 'refreshOaForMemberChange',
      message: `Operating Agreement for ${ag.company_name} is partially signed and its membership changed — ${revokedCount} unsigned signing link(s) revoked. Reissue by hand: void it and have the client regenerate, or re-send fresh links to the remaining members.`,
      context: { account_id, oa_id: ag.id, source, reasons: diff.reasons, revoked_unsigned: revokedCount },
    }).catch(() => {})

    result = { outcome: 'partial_revoked', agreementId: ag.id, reasons: diff.reasons, revokedSigners: revokedCount }
  }

  // Tell the creator to regenerate — once, only if we voided something. The
  // portal already renders a voided OA as "outdated, generate a new one", so this
  // points them straight at the generate screen. Best-effort.
  if (voidedAny) {
    const voided = agreements.find((a: { id: string }) => a.id === result.agreementId)
    const contactId = voided?.contact_id ?? null
    if (contactId) {
      await notifyClientActionRequired({
        contact_id: contactId,
        account_id,
        topic: 'Operating Agreement',
        title: {
          en: `Your Operating Agreement needs to be regenerated`,
          it: `Il tuo Atto Costitutivo deve essere rigenerato`,
        },
        message: {
          en: `The list of members for ${voided?.company_name ?? 'your company'} changed, so the previous Operating Agreement is no longer valid. Please generate a new one — it takes one click.`,
          it: `L'elenco dei soci di ${voided?.company_name ?? 'la tua azienda'} è cambiato, quindi il precedente Atto Costitutivo non è più valido. Generane uno nuovo — bastano pochi secondi.`,
        },
        // Unique per agreement so the dedup scope changes when the agreement does.
        link: `/portal/documents/generate?oa_voided=${result.agreementId}`,
      }).catch(() => {})
    }
  }

  return result
}

/**
 * Best-effort wrapper for the member-write surfaces. NEVER throws — die-on-change
 * must not fail the member mutation that triggered it. Returns null on error or
 * when there is nothing to act on.
 */
export async function autoRefreshOa(account_id: string, source: string): Promise<OaRefreshResult | null> {
  try {
    const r = await refreshOaForMemberChange({ account_id, source })
    return r.outcome === 'no_oa' ? null : r
  } catch (err) {
    console.error('[oa-refresh] failed (non-fatal):', err)
    return null
  }
}
