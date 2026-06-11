/**
 * Phase 0 safety fix: derive entity_type from the signed contract at activation time
 * instead of hardcoding 'Single Member LLC' / 'SMLLC'.
 *
 * The client picks SMLLC / MMLLC / Corporation on the signing page (writes contracts.llc_type).
 * Two downstream call sites previously hardcoded entity_type, silently ignoring that choice:
 *   - lib/portal/auto-create.ts ensureMinimalAccount() — sets accounts.entity_type
 *   - app/api/workflows/activate-service/route.ts — passes entity_type into formation_form_create
 *
 * This helper reads contracts.llc_type by offer_token and returns BOTH:
 *   - wizardCode: short form used by wizard form params (SMLLC | MMLLC)
 *   - accountLabel: long form written to accounts.entity_type
 *
 * Sources:
 *   'contract'              — contract found, llc_type is SMLLC or MMLLC
 *   'corporation_not_wired' — contract says Corporation; wizard path not built yet,
 *                             so wizardCode=null (caller should skip auto-wizard + task manual handling);
 *                             accountLabel=C-Corp Elected so the account is still labeled correctly
 *   'no_token'              — no offer_token passed (legacy/unusual call site)
 *   'no_contract'           — no signed contract row for the given token
 *   'unknown_type'          — llc_type present but not a recognized value
 *
 * Callers decide how to fall back for null results. This helper only reads + maps.
 */

import { supabaseAdmin } from '@/lib/supabase-admin'

export type EntityTypeSource =
  | 'contract'
  | 'corporation_not_wired'
  | 'no_token'
  | 'no_contract'
  | 'unknown_type'

export interface EntityTypeLookup {
  wizardCode: 'SMLLC' | 'MMLLC' | null
  accountLabel: 'Single Member LLC' | 'Multi Member LLC' | 'C-Corp Elected' | null
  rawLlcType: string | null
  source: EntityTypeSource
}

export async function getEntityTypeFromContract(
  offerToken: string | null | undefined,
): Promise<EntityTypeLookup> {
  if (!offerToken) {
    return { wizardCode: null, accountLabel: null, rawLlcType: null, source: 'no_token' }
  }

  const { data } = await supabaseAdmin
    .from('contracts')
    .select('llc_type')
    .eq('offer_token', offerToken)
    .eq('status', 'signed')
    .order('signed_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  const rawLlcType = data?.llc_type ?? null

  if (!rawLlcType) {
    return { wizardCode: null, accountLabel: null, rawLlcType: null, source: 'no_contract' }
  }

  if (rawLlcType === 'SMLLC') {
    return { wizardCode: 'SMLLC', accountLabel: 'Single Member LLC', rawLlcType, source: 'contract' }
  }

  if (rawLlcType === 'MMLLC') {
    return { wizardCode: 'MMLLC', accountLabel: 'Multi Member LLC', rawLlcType, source: 'contract' }
  }

  if (rawLlcType === 'Corporation') {
    return {
      wizardCode: null,
      accountLabel: 'C-Corp Elected',
      rawLlcType,
      source: 'corporation_not_wired',
    }
  }

  return { wizardCode: null, accountLabel: null, rawLlcType, source: 'unknown_type' }
}

// ─── Formation-scoped resolution (2026-06-11, Adam Mihaly incident) ─────────
//
// At company-materialization time the entity type must come from what the
// client BOUGHT (the signed contract), not from a code default. Precedent:
// LUMA Beauty Global LLC — the signed contract said MMLLC (contracts.llc_type,
// picked by the client on the signing page), the portal wizard never captured
// entity_type, and formation-materialize silently defaulted to SMLLC. The
// SS-4 then went out as 1-member and the client caught the error.
//
// Resolution priority (Antonio, 2026-06-11: "The CRM must be set according to
// the contract that the client signed"):
//   1. admin override   — explicit human input on the materialize call
//   2. signed contract  — contracts.llc_type via this formation's lead → offers
//                         (fallback: all the contact's leads + direct contact offers)
//   3. formation form   — formation_submissions.entity_type
//   4. wizard data      — wizard_progress.data.entity_type
//   5. UNRESOLVED       — caller must fail loudly. NEVER default to SMLLC.

export type FormationEntityTypeSource =
  | 'admin_override'
  | 'contract'
  | 'formation_submission'
  | 'wizard_data'
  | 'corporation_manual'
  | 'unresolved'

export interface FormationEntityTypeResolution {
  wizardCode: 'SMLLC' | 'MMLLC' | null
  accountLabel: 'Single Member LLC' | 'Multi Member LLC' | null
  source: FormationEntityTypeSource
  detail: string
  /** Set when the signed contract disagreed with form/wizard data (contract won). */
  conflictWarning?: string
}

/** Normalize free-form entity-type strings ('SMLLC', 'Multi Member LLC', …). */
export function normalizeEntityCode(raw: string | null | undefined): 'SMLLC' | 'MMLLC' | null {
  if (!raw) return null
  const v = String(raw).toUpperCase().trim()
  if (v === 'MMLLC' || v.includes('MULTI')) return 'MMLLC'
  if (v === 'SMLLC' || v.includes('SINGLE')) return 'SMLLC'
  return null
}

const ACCOUNT_LABEL: Record<'SMLLC' | 'MMLLC', 'Single Member LLC' | 'Multi Member LLC'> = {
  SMLLC: 'Single Member LLC',
  MMLLC: 'Multi Member LLC',
}

export async function resolveEntityTypeForFormation(input: {
  contactId: string
  /** wizard_progress.lead_id when known — pins the lookup to THIS formation. */
  leadId?: string | null
  adminOverride?: 'SMLLC' | 'MMLLC' | null
  submissionEntityType?: string | null
  wizardEntityType?: string | null
}): Promise<FormationEntityTypeResolution> {
  const formCode = normalizeEntityCode(input.submissionEntityType) ?? normalizeEntityCode(input.wizardEntityType)
  const formSource: FormationEntityTypeSource = normalizeEntityCode(input.submissionEntityType)
    ? 'formation_submission'
    : 'wizard_data'

  // 1. Admin override.
  if (input.adminOverride) {
    return {
      wizardCode: input.adminOverride,
      accountLabel: ACCOUNT_LABEL[input.adminOverride],
      source: 'admin_override',
      detail: `Admin-supplied entity_type ${input.adminOverride}`,
    }
  }

  // 2. Signed contract. Resolve this formation's lead(s) → offer tokens →
  //    signed contracts. A returning client can have several companies and
  //    contracts, so when leadId is known the lookup is pinned to it; the
  //    contact-wide fallback only trusts the contract when all signed
  //    contracts agree on llc_type.
  try {
    let leadIds: string[] = []
    if (input.leadId) {
      leadIds = [input.leadId]
    } else {
      const { data: leads } = await supabaseAdmin
        .from('leads')
        .select('id')
        .eq('converted_to_contact_id', input.contactId)
      leadIds = (leads ?? []).map(l => l.id)
    }

    let offersQuery = supabaseAdmin.from('offers').select('token, lead_id, contact_id')
    if (leadIds.length > 0) {
      offersQuery = offersQuery.or(
        `lead_id.in.(${leadIds.join(',')}),contact_id.eq.${input.contactId}`
      )
    } else {
      offersQuery = offersQuery.eq('contact_id', input.contactId)
    }
    const { data: offers } = await offersQuery
    const tokens = (offers ?? []).map(o => o.token).filter(Boolean)

    if (tokens.length > 0) {
      const { data: contracts } = await supabaseAdmin
        .from('contracts')
        .select('offer_token, llc_type, signed_at')
        .in('offer_token', tokens)
        .eq('status', 'signed')
        .order('signed_at', { ascending: false })

      const llcTypes = Array.from(new Set((contracts ?? []).map(c => c.llc_type).filter(Boolean)))

      if (llcTypes.length === 1) {
        const raw = llcTypes[0] as string
        if (raw === 'Corporation') {
          return {
            wizardCode: null,
            accountLabel: null,
            source: 'corporation_manual',
            detail: `Signed contract says Corporation (token ${contracts![0].offer_token}) — LLC materialization does not apply; manual handling required.`,
          }
        }
        const code = normalizeEntityCode(raw)
        if (code) {
          const conflictWarning = formCode && formCode !== code
            ? `Signed contract says ${code} but the formation form/wizard says ${formCode} — the contract wins. Verify member data before generating EIN documents.`
            : undefined
          return {
            wizardCode: code,
            accountLabel: ACCOUNT_LABEL[code],
            source: 'contract',
            detail: `Signed contract llc_type=${raw} (token ${contracts![0].offer_token})`,
            conflictWarning,
          }
        }
      }
      // 0 signed contracts, conflicting types, or unrecognized value:
      // fall through to form/wizard data.
    }
  } catch {
    // Contract lookup is best-effort — a query failure falls through to the
    // form/wizard sources rather than blocking materialization outright.
  }

  // 3./4. Formation form, then wizard data.
  if (formCode) {
    return {
      wizardCode: formCode,
      accountLabel: ACCOUNT_LABEL[formCode],
      source: formSource,
      detail: `Entity type ${formCode} from ${formSource === 'formation_submission' ? 'formation_submissions.entity_type' : 'wizard_progress.data.entity_type'} (no signed contract found to confirm)`,
    }
  }

  // 5. Unresolved — the caller MUST fail loudly, never default.
  return {
    wizardCode: null,
    accountLabel: null,
    source: 'unresolved',
    detail:
      'No signed contract with llc_type, no formation-form entity_type, and no wizard entity_type. Pass entity_type explicitly (SMLLC or MMLLC) on the materialize call after checking what the client bought.',
  }
}
