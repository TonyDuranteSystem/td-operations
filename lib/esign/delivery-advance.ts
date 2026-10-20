/**
 * When the client has signed a form that belongs to a service delivery, the delivery moves on by itself.
 * The e-sign engine (lib/operations/esign.ts) stores `esign_envelopes.service_delivery_id` but nothing used
 * to act on it — only the legacy Tax Return signing route moved a delivery, and only from the hard-coded
 * "Tax Return Prepared" stage. Per service, ONE rule: the stage the delivery must be at, and where it goes.
 *
 * Company Change Name: "Client signs the name-change form" → "File the form with the state". Staff can send the form
 * from "Check names and client confirms" and press nothing else — the client's signature carries the job through
 * from either step, so a signature is never left stranded just because the job was not moved by hand first.
 *
 * Idempotent (a delivery no longer at the "from" stage is left alone, so a repeated completion call or a
 * reminder-cron re-run does nothing) and best-effort (never throws — the signer's submit must not fail
 * because of this). A refusal (e.g. no confirmed name) is reported to the error dashboard: the client has
 * signed but the job did not move, and staff must see it.
 */

import { supabaseAdmin } from '@/lib/supabase-admin'
import { CHANGE_NAME_STAGES } from '@/lib/flows/change-name-stages'

export const ESIGN_COMPLETION_ADVANCE: Readonly<Record<string, { fromStages: readonly string[]; toStage: string }>> = {
  'Company Change Name': { fromStages: [CHANGE_NAME_STAGES.check, CHANGE_NAME_STAGES.sign], toStage: CHANGE_NAME_STAGES.file },
}

/** The stage a delivery moves to after its form is signed, or null when this delivery is not waiting on a signature. Pure. */
export function esignAdvanceTarget(serviceType: string | null | undefined, currentStage: string | null | undefined): string | null {
  if (!serviceType || !currentStage) return null
  const rule = ESIGN_COMPLETION_ADVANCE[serviceType]
  return rule && rule.fromStages.includes(currentStage) ? rule.toStage : null
}

export interface DeliveryAdvanceResult {
  advanced: boolean
  reason?: string
}

export async function advanceDeliveryAfterEsign(envelopeId: string): Promise<DeliveryAdvanceResult> {
  try {
    // esign_* tables are not in the generated DB types.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = supabaseAdmin as any
    const { data: env } = await db.from('esign_envelopes').select('id, status, service_delivery_id, document_name').eq('id', envelopeId).maybeSingle()
    if (!env || !env.service_delivery_id) return { advanced: false, reason: 'not linked to a service delivery' }
    if (env.status !== 'completed') return { advanced: false, reason: 'not fully signed yet' }

    const { data: sd } = await supabaseAdmin
      .from('service_deliveries')
      .select('id, service_type, stage, status')
      .eq('id', env.service_delivery_id as string)
      .maybeSingle()
    if (!sd) return { advanced: false, reason: 'service delivery not found' }
    const target = esignAdvanceTarget(sd.service_type, sd.stage)
    if (!target) return { advanced: false, reason: 'the delivery is not waiting for this signature' }

    const { advanceServiceDelivery } = await import('@/lib/service-delivery')
    const result = await advanceServiceDelivery({
      delivery_id: sd.id as string,
      target_stage: target,
      skip_tasks: true,
      actor: 'esign-completed',
      notes: `Form signed by the client (e-sign envelope ${envelopeId}: ${env.document_name ?? 'form'})`,
    })
    if (result && result.success === false) {
      await reportNotAdvanced(sd.id as string, envelopeId, result.error ?? 'refused')
      return { advanced: false, reason: result.error ?? 'refused' }
    }
    return { advanced: true }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await reportNotAdvanced(null, envelopeId, message)
    return { advanced: false, reason: message }
  }
}

async function reportNotAdvanced(sdId: string | null, envelopeId: string, reason: string): Promise<void> {
  console.error(`advanceDeliveryAfterEsign: envelope ${envelopeId} signed but the delivery did not move: ${reason}`)
  try {
    const { reportSystemError } = await import('@/lib/system-errors')
    await reportSystemError({
      source: 'server',
      route: 'lib/esign/delivery-advance.ts',
      message: `The client signed the form but the job did not move to the next step${sdId ? ` (SD ${sdId})` : ''}: ${reason}. Move it by hand.`,
      context: { envelopeId, service_delivery_id: sdId },
    })
  } catch {
    /* best-effort */
  }
}
