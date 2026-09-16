/**
 * Pure decision logic for the MMLLC "add your members" kickoff (dev job
 * ef529eaf) — extracted from advanceServiceDelivery (lib/service-delivery.ts)
 * and the record-ein-received route, both of which have no dedicated test
 * harness of their own to extend (same precedent as
 * lib/operations/irs-tracking.ts / lib/tasks/itin-processing-reminder.ts:
 * keep the DB-wiring thin, put the actual decision in a pure, tested module).
 */

import { isItalian } from "@/lib/locale"

export interface MemberInfoKickoffDecision {
  shouldSend: boolean
  reason: "not_mmllc" | "request_failed" | "already_requested" | "new_mmllc_request"
}

/**
 * Should the "your company is open, add your members" prompt fire right now?
 *
 * MMLLC only (SMLLCs get no `members` rows by design — surfacing this form to
 * one would violate that). Only on a genuinely NEW request: a reused pending
 * one means the client already got this message (or staff sent it manually)
 * and sending again would double-notify; a request that failed to create is
 * never messaged. This is the ONLY gate — callers must not separately decide
 * whether to notify.
 */
export function decideMemberInfoKickoff(params: {
  entityType: string | null | undefined
  requestOutcome: "ok" | "error"
  isExistingRequest: boolean
}): MemberInfoKickoffDecision {
  if (params.entityType !== "Multi Member LLC") {
    return { shouldSend: false, reason: "not_mmllc" }
  }
  if (params.requestOutcome !== "ok") {
    return { shouldSend: false, reason: "request_failed" }
  }
  if (params.isExistingRequest) {
    return { shouldSend: false, reason: "already_requested" }
  }
  return { shouldSend: true, reason: "new_mmllc_request" }
}

/** Bilingual copy for the kickoff message, via the canonical locale helper —
 * never a local `=== 'it'`/`=== 'Italian'` check (lib/locale.ts's own
 * docstring documents five prior incidents of exactly that mistake). */
export function buildMemberInfoKickoffMessage(params: {
  companyName: string
  formUrl: string
  language: string | null | undefined
}): { message: string; messagePreview: string } {
  const italian = isItalian(params.language)
  const message = italian
    ? `Buone notizie — **${params.companyName}** è stata ufficialmente costituita! 🎉\n\nOra puoi indicarci chi sono i soci della società e chi firmerà il modulo SS-4 per richiedere l'EIN:\n\n${params.formUrl}`
    : `Great news — **${params.companyName}** is officially formed! 🎉\n\nYou can now tell us who the company's members are and who will sign the SS-4 form to request the EIN:\n\n${params.formUrl}`
  const messagePreview = italian
    ? `${params.companyName} è stata costituita — indica i soci`
    : `${params.companyName} is formed — add your members`
  return { message, messagePreview }
}

export type EinReceivedMemberInfoAction = "skip_already_submitted" | "reuse_pending" | "create_new"

/**
 * The EIN-received flow's own, separate member-info trigger (fires much
 * later than materialization, when the EIN itself comes back). Its ONLY job
 * here is to never re-ask a client who already answered — "already answered"
 * means a `submitted` request exists, not just "no `pending` one exists"
 * (the pending-only check was the exact bug: it couldn't see a submitted row,
 * so it minted a second request and re-messaged every client who had already,
 * correctly, answered promptly at materialization).
 */
export function decideEinReceivedMemberInfoAction(
  existingRequestStatus: "pending" | "submitted" | null | undefined,
): EinReceivedMemberInfoAction {
  if (existingRequestStatus === "submitted") return "skip_already_submitted"
  if (existingRequestStatus === "pending") return "reuse_pending"
  return "create_new"
}

/** Bilingual copy for the EIN-received flow's own member-info message. */
export function buildEinReceivedMemberInfoMessage(params: {
  companyName: string
  ein: string
  formUrl: string
  language: string | null | undefined
}): { message: string; messagePreview: string } {
  const italian = isItalian(params.language)
  const message = italian
    ? `Ottime notizie! L'EIN per ${params.companyName} è stato rilasciato (${params.ein}).\n\nPer procedere con l'apertura del conto bancario aziendale, abbiamo bisogno delle informazioni complete di tutti i soci della LLC.\n\nCompila questo breve modulo:\n${params.formUrl}\n\nUna volta inviato, aggiorneremo il tuo account e ti guideremo nei prossimi passi.`
    : `Great news! The EIN for ${params.companyName} has been issued (${params.ein}).\n\nTo proceed with opening your business bank account, we need the complete information for all LLC members.\n\nPlease fill out this short form:\n${params.formUrl}\n\nOnce submitted, we will update your account and guide you through the next steps.`
  const messagePreview = italian
    ? `EIN ricevuto — indica i soci di ${params.companyName}`
    : `EIN received — add your members for ${params.companyName}`
  return { message, messagePreview }
}
