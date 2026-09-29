/**
 * CRM Store — slice S3: who sees which file, who a file may be sent to, and a
 * member leaving / access revoked (master plan v4.5 §8.2, §8.4; job 685467b5).
 *
 * Thin wrappers over the database rules in
 * scripts/migrations/20260925-1500-crm-store-s3-access.sql — the rules live in ONE
 * place (the database), so a screen can never apply a different version of them.
 * Dark: nothing calls this yet (Antonio 2026-09-25 "build dark, wire later").
 *
 * - Portal viewers are EITHER a contact OR a portal teammate row, resolved by the
 *   portal's own identity resolver — never both, never neither.
 * - Every staff action requires a store staff user (explicit allow-list, server-set
 *   role only — lib/crm-store/access.ts).
 */

import type { User } from "@supabase/supabase-js"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { isStoreStaffUser } from "@/lib/crm-store/access"

export type PortalViewer = { contactId: string; teammateId?: never } | { teammateId: string; contactId?: never }

export type RecipientClass =
  | "own_person" | "company_members" | "representative" | "tax_authority"
  | "accountant" | "india_team" | "bank" | "service_provider" | "staff_internal" | "other"

/** Every code store_file_access can return. Anything but ok / ok_leaving is a refusal. */
export type AccessCode =
  | "ok" | "ok_leaving" | "viewer_required" | "not_found" | "not_live" | "unfiled" | "not_client_visible"
  | "personal_not_for_teammates" | "not_the_person" | "no_access" | "company_hidden" | "not_the_buyer"
  | "teammate_no_documents" | "no_company_access"

/** Every code store_send_check can return. */
export type SendCode =
  | "ok" | "unknown_recipient_class" | "not_found" | "not_live" | "unfiled_must_be_classified" | "reason_required"
  | "recipient_required" | "not_the_person" | "not_in_company" | "personal_not_allowed" | "not_a_representative"

export interface Recipient { contactId?: string | null; email?: string | null }

/** A send that already happened broke the rules. It IS recorded (audit), then this is thrown. */
export class StoreSendOutsideRulesError extends Error {
  constructor(public code: string, public eventId: number) {
    super(`This send was outside the storage rules (${code}) — it has been recorded for review.`)
    this.name = "StoreSendOutsideRulesError"
  }
}

export class StoreAccessDeniedError extends Error {
  constructor(message = "Only staff can do this in the CRM store.") {
    super(message)
    this.name = "StoreAccessDeniedError"
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = () => supabaseAdmin as any

function viewerArgs(v: PortalViewer) {
  const contact = "contactId" in v && v.contactId ? v.contactId : null
  const teammate = "teammateId" in v && v.teammateId ? v.teammateId : null
  if ((contact === null) === (teammate === null)) throw new Error("store: a portal viewer is exactly one contact or one teammate")
  return { p_contact_id: contact, p_teammate_id: teammate }
}

function requireStaff(actor: Pick<User, "id" | "app_metadata"> | null | undefined): string {
  if (!actor || !isStoreStaffUser(actor)) throw new StoreAccessDeniedError()
  return actor.id
}

async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await db().rpc(fn, args)
  if (error) throw new Error(`[crm-store] ${fn} failed: ${error.message}`)
  return data as T
}

export const ALLOWED_ACCESS = ["ok", "ok_leaving"] as const

/** May this portal viewer see this file? Fail closed: anything but ok/ok_leaving is a refusal. */
export async function fileAccess(fileId: string, viewer: PortalViewer): Promise<{ allowed: boolean; code: AccessCode }> {
  const code = await rpc<AccessCode>("store_file_access", { p_file_id: fileId, ...viewerArgs(viewer) })
  return { allowed: (ALLOWED_ACCESS as readonly string[]).includes(code), code }
}

export interface VisibleFile {
  file_id: string; owner_id: string; folder_id: string; name: string
  document_type: string | null; period_year: number | null; access: string
}

/** The only listing a tree / search / zip may use: every row passed the per-file check. */
export async function visibleFiles(viewer: PortalViewer, ownerId?: string): Promise<VisibleFile[]> {
  return (await rpc<VisibleFile[] | null>("store_visible_files", { ...viewerArgs(viewer), p_owner_id: ownerId ?? null })) ?? []
}

/** Record a portal view (the database logs it for personal files). Returns the access code. */
export async function recordView(fileId: string, viewer: PortalViewer): Promise<string> {
  return rpc<string>("store_record_view", { p_file_id: fileId, ...viewerArgs(viewer) })
}

function recipientJson(r: Recipient) {
  return { contact_id: r.contactId ?? null, email: r.email ?? null }
}

/** Staff: may this file be sent to this recipient? 'ok' or a refusal code. */
export async function sendCheck(
  actor: Pick<User, "id" | "app_metadata"> | null | undefined,
  p: { fileId: string; recipientClass: RecipientClass; recipient: Recipient; reason?: string | null },
): Promise<{ allowed: boolean; code: SendCode }> {
  requireStaff(actor)
  const code = await rpc<SendCode>("store_send_check", {
    p_file_id: p.fileId, p_recipient_class: p.recipientClass, p_recipient: recipientJson(p.recipient), p_reason: p.reason ?? null,
  })
  return { allowed: code === "ok", code }
}

/**
 * Staff: record a send AFTER it happened (send first, record after — R037). A send the rules would have
 * refused is still recorded (the audit never loses a real send), then StoreSendOutsideRulesError is thrown.
 */
export async function recordSend(
  actor: Pick<User, "id" | "app_metadata"> | null | undefined,
  p: { fileId: string; recipientClass: RecipientClass; recipient: Recipient; reason?: string | null; channel: string },
): Promise<number> {
  const actorId = requireStaff(actor)
  const r = await rpc<{ event_id: number; code: string }>("store_record_send", {
    p_file_id: p.fileId, p_recipient_class: p.recipientClass, p_recipient: recipientJson(p.recipient),
    p_reason: p.reason ?? null, p_actor: actorId, p_channel: p.channel,
  })
  if (r.code !== "ok") throw new StoreSendOutsideRulesError(r.code, r.event_id)
  return r.event_id
}

/** Staff: move a file's filing status forward (draft → filed; an amendment → amended). Never back. */
export async function setFilingStatus(
  actor: Pick<User, "id" | "app_metadata"> | null | undefined, fileId: string, status: "draft" | "filed" | "amended",
): Promise<boolean> {
  const actorId = requireStaff(actor)
  return rpc<boolean>("store_set_filing_status", { p_file_id: fileId, p_status: status, p_actor: actorId })
}

/** Staff: publish / unpublish a file for the client — it always takes effect (a hidden-draft type is refused). */
export async function setPublished(actor: Pick<User, "id" | "app_metadata"> | null | undefined, fileId: string, published: boolean): Promise<boolean> {
  const actorId = requireStaff(actor)
  return rpc<boolean>("store_set_published", { p_file_id: fileId, p_published: published, p_actor: actorId })
}

type MembershipArgs = { accountId: string; contactId: string; reason?: string | null }

/** Staff: a member leaves — soft end, one-week download window, invitation QUEUED (not sent). */
export async function endMembership(actor: Pick<User, "id" | "app_metadata"> | null | undefined, p: MembershipArgs) {
  const actorId = requireStaff(actor)
  return rpc<{ status: string; access_until?: string; invitation_id?: string | null }>("store_end_membership", {
    p_account_id: p.accountId, p_contact_id: p.contactId, p_actor: actorId, p_reason: p.reason ?? null,
  })
}

/** Staff: undo a mistaken end of membership (a revoke stays revoked). */
export async function reopenMembership(actor: Pick<User, "id" | "app_metadata"> | null | undefined, p: MembershipArgs) {
  const actorId = requireStaff(actor)
  return rpc<{ status: string; still_revoked?: boolean }>("store_reopen_membership", {
    p_account_id: p.accountId, p_contact_id: p.contactId, p_actor: actorId, p_reason: p.reason ?? null,
  })
}

/**
 * Staff: end this person's access to the company's STORED DOCUMENTS at once; the membership stays; no
 * invitation. Until Stage 1 it does not touch today's portal login, chat or invoices.
 */
export async function revokeStoreAccess(actor: Pick<User, "id" | "app_metadata"> | null | undefined, p: MembershipArgs) {
  const actorId = requireStaff(actor)
  return rpc<{ status: string }>("store_revoke_access", {
    p_account_id: p.accountId, p_contact_id: p.contactId, p_actor: actorId, p_reason: p.reason ?? null,
  })
}

/** Staff: lift a revoke (never extends a leaver's finished window). */
export async function restoreStoreAccess(actor: Pick<User, "id" | "app_metadata"> | null | undefined, p: MembershipArgs) {
  const actorId = requireStaff(actor)
  return rpc<{ status: string; access?: string | null }>("store_restore_access", {
    p_account_id: p.accountId, p_contact_id: p.contactId, p_actor: actorId, p_reason: p.reason ?? null,
  })
}
