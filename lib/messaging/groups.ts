/**
 * Canonical WhatsApp conversation (messaging_groups) lookup/creation.
 *
 * Two call sites used to derive `external_group_id` independently and
 * disagreed: the historical import wrote a bare digit string, while the
 * "New WhatsApp" flow wrote `${digits}@c.us` — the same real contact could
 * therefore own two disconnected threads. This is the one place that decides
 * the key and does the lookup, so a third caller (the inbound webhook) can't
 * introduce a third convention.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import { digitsOnly, toWhatsAppJid } from "@/lib/messaging/phone"

export interface FindOrCreateGroupParams {
  channelId: string
  /** Any phone format, or an existing JID — normalized internally. */
  remoteIdentifier: string
  groupName?: string | null
  groupType?: "support_group" | "lead_chat" | "internal" | "other"
  accountId?: string | null
  contactId?: string | null
  leadId?: string | null
}

export interface MessagingGroupRow {
  id: string
  channel_id: string
  external_group_id: string
  group_name: string | null
  account_id?: string | null
  contact_id?: string | null
  lead_id?: string | null
}

/**
 * Find the group for this (channel, remote contact) or create it, keyed on
 * the canonical JID so old and new conversations for the same number land
 * in the same thread. Upserts on the DB's own
 * `messaging_groups_channel_id_external_group_id_key` unique index so a
 * race between two callers can't create a duplicate.
 *
 * An already-existing group is patched (never overwritten) with any identity
 * the caller has that the stored row is missing — e.g. a lead who converts to
 * a contact and gets texted again from their new Contact page must not stay
 * permanently linked only to the stale lead record.
 */
export async function findOrCreateWhatsAppGroup(
  params: FindOrCreateGroupParams
): Promise<{ group: MessagingGroupRow } | { error: string }> {
  const externalGroupId = toWhatsAppJid(params.remoteIdentifier)

  const { data: canonical, error: lookupError } = await supabaseAdmin
    .from("messaging_groups")
    .select("id, channel_id, external_group_id, group_name, account_id, contact_id, lead_id")
    .eq("channel_id", params.channelId)
    .eq("external_group_id", externalGroupId)
    .maybeSingle()

  if (lookupError) {
    return { error: `messaging_groups lookup failed: ${lookupError.message}` }
  }

  // The historical import wrote a BARE-DIGIT key (~169 production chats). If the canonical key has no chat but
  // the legacy key does, that is the SAME conversation — reuse it, or the first message after the cutover would
  // open a second, empty thread next to the imported history (the exact split this helper was written to prevent).
  // The legacy key is left as it is: normalizing stored keys touches real client data and needs Antonio's own go.
  let existing = canonical
  if (!existing) {
    const { data: legacy, error: legacyError } = await supabaseAdmin
      .from("messaging_groups")
      .select("id, channel_id, external_group_id, group_name, account_id, contact_id, lead_id")
      .eq("channel_id", params.channelId)
      .eq("external_group_id", digitsOnly(params.remoteIdentifier))
      .maybeSingle()
    if (legacyError) {
      return { error: `messaging_groups lookup failed: ${legacyError.message}` }
    }
    existing = legacy
  }
  if (existing) {
    const row = existing as MessagingGroupRow
    const patch: Record<string, string> = {}
    if (!row.account_id && params.accountId) patch.account_id = params.accountId
    if (!row.contact_id && params.contactId) patch.contact_id = params.contactId
    if (!row.lead_id && params.leadId) patch.lead_id = params.leadId

    if (Object.keys(patch).length === 0) {
      return { group: row }
    }

    const { data: patched, error: patchError } = await supabaseAdmin
      .from("messaging_groups")
      .update(patch)
      .eq("id", row.id)
      .select("id, channel_id, external_group_id, group_name, account_id, contact_id, lead_id")
      .single()

    // A failed patch shouldn't block the send — the group is still usable,
    // just with the gap unfilled for next time.
    return { group: patchError || !patched ? row : (patched as MessagingGroupRow) }
  }

  const { data: created, error: upsertError } = await supabaseAdmin
    .from("messaging_groups")
    .upsert(
      {
        channel_id: params.channelId,
        external_group_id: externalGroupId,
        group_name: params.groupName ?? null,
        group_type: params.groupType ?? "lead_chat",
        account_id: params.accountId ?? null,
        contact_id: params.contactId ?? null,
        lead_id: params.leadId ?? null,
      },
      { onConflict: "channel_id,external_group_id" }
    )
    .select("id, channel_id, external_group_id, group_name")
    .single()

  if (upsertError || !created) {
    return { error: `messaging_groups upsert failed: ${upsertError?.message ?? "no row returned"}` }
  }

  return { group: created as MessagingGroupRow }
}
