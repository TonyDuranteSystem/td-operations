/**
 * Company Change Name, last step: when the client has SIGNED the new Operating Agreement (the one that carries the new
 * company name), the job closes by itself. The OA pipeline has no link to a service delivery (an agreement belongs to an
 * account), so the rule is derived from the data: the company's active name-change job sits on the Operating Agreement step AND
 * the agreement that was just signed carries the company's CURRENT name (the signed OLD agreement, signed before the rename, never
 * matches — so signing or re-sending an old one cannot close a job).
 *
 * Idempotent (a job no longer on that step is left alone) and best-effort (never throws: the signer's submit must not fail
 * because of this). A refusal is reported to the error dashboard — the client signed but the job did not close, staff must see it.
 */
import { supabaseAdmin } from '@/lib/supabase-admin'
import { CHANGE_NAME_STAGES } from '@/lib/flows/change-name-stages'
import { oaNameKey } from '@/lib/portal/oa-regenerate-guard'

export interface NameChangeOaFacts {
  serviceType: string | null | undefined
  jobStage: string | null | undefined
  /** the company name frozen into the agreement that was just signed */
  signedOaName: string | null | undefined
  /** the company's name now (accounts.company_name) */
  accountName: string | null | undefined
}

/** PURE: does this signed agreement close the company's name-change job? */
export function signedOaClosesNameChange(f: NameChangeOaFacts): boolean {
  if (f.serviceType !== 'Company Change Name' || f.jobStage !== CHANGE_NAME_STAGES.oa) return false
  const signed = oaNameKey(f.signedOaName)
  return signed !== '' && signed === oaNameKey(f.accountName)
}

export interface NameChangeAdvanceResult {
  advanced: boolean
  reason?: string
}

export async function advanceNameChangeAfterOaSigned(p: { accountId: string; oaId: string; signedOaName: string | null | undefined }): Promise<NameChangeAdvanceResult> {
  try {
    const [{ data: account }, { data: sd }] = await Promise.all([
      supabaseAdmin.from('accounts').select('company_name').eq('id', p.accountId).maybeSingle(),
      supabaseAdmin
        .from('service_deliveries')
        .select('id, service_type, stage')
        .eq('account_id', p.accountId)
        .eq('service_type', 'Company Change Name')
        .eq('status', 'active')
        .eq('stage', CHANGE_NAME_STAGES.oa)
        .limit(1)
        .maybeSingle(),
    ])
    if (!sd) return { advanced: false, reason: 'no name-change job is waiting for the Operating Agreement' }
    if (!signedOaClosesNameChange({ serviceType: sd.service_type, jobStage: sd.stage, signedOaName: p.signedOaName, accountName: account?.company_name })) {
      return { advanced: false, reason: 'the signed agreement does not carry the company\'s current name' }
    }
    const { advanceServiceDelivery } = await import('@/lib/service-delivery')
    const result = await advanceServiceDelivery({
      delivery_id: sd.id as string,
      target_stage: CHANGE_NAME_STAGES.done,
      skip_tasks: true,
      actor: 'oa-signed',
      notes: `The new Operating Agreement was signed by the client (agreement ${p.oaId})`,
    })
    if (result && result.success === false) {
      await report(sd.id as string, p.oaId, result.error ?? 'refused')
      return { advanced: false, reason: result.error ?? 'refused' }
    }
    return { advanced: true }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await report(null, p.oaId, message)
    return { advanced: false, reason: message }
  }
}

async function report(sdId: string | null, oaId: string, reason: string): Promise<void> {
  console.error(`advanceNameChangeAfterOaSigned: agreement ${oaId} signed but the name-change job did not close: ${reason}`)
  try {
    const { reportSystemError } = await import('@/lib/system-errors')
    await reportSystemError({
      source: 'server',
      route: 'lib/oa/name-change-advance.ts',
      message: `The client signed the new Operating Agreement but the name-change job did not close${sdId ? ` (SD ${sdId})` : ''}: ${reason}. Close it by hand.`,
      context: { oa_id: oaId, service_delivery_id: sdId },
    })
  } catch {
    /* best-effort */
  }
}
