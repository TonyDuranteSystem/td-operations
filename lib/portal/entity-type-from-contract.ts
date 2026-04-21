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
