/**
 * Canonical Telegram conversation (messaging_groups) lookup/creation —
 * the Telegram counterpart to groups.ts::findOrCreateWhatsAppGroup.
 *
 * Telegram has no phone-number identity to normalize: a chat's `chat.id` is
 * already a stable, unique, provider-issued integer for the lifetime of that
 * chat, so it's used as `external_group_id` verbatim (as a string) with no
 * JID-style transformation.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"

export interface FindOrCreateTelegramGroupParams {
  channelId: string
  /** Telegram's `chat.id` — a stable integer per chat, sent as a string. */
  chatId: string
  groupName?: string | null
}

export interface TelegramMessagingGroupRow {
  id: string
  channel_id: string
  external_group_id: string
  group_name: string | null
}

/**
 * Find the group for this (channel, chat_id) or create it. Upserts on the
 * same `messaging_groups_channel_id_external_group_id_key` unique index the
 * WhatsApp path uses, so a redelivered/racing webhook can't create a
 * duplicate. An existing group's name is refreshed if the caller has one and
 * the stored row doesn't — the same "patch, never overwrite" rule as WhatsApp.
 */
export async function findOrCreateTelegramGroup(
  params: FindOrCreateTelegramGroupParams
): Promise<{ group: TelegramMessagingGroupRow } | { error: string }> {
  const { data: existing, error: lookupError } = await supabaseAdmin
    .from("messaging_groups")
    .select("id, channel_id, external_group_id, group_name")
    .eq("channel_id", params.channelId)
    .eq("external_group_id", params.chatId)
    .maybeSingle()

  if (lookupError) {
    return { error: `messaging_groups lookup failed: ${lookupError.message}` }
  }
  if (existing) {
    const row = existing as TelegramMessagingGroupRow
    if (row.group_name || !params.groupName) {
      return { group: row }
    }
    const { data: patched, error: patchError } = await supabaseAdmin
      .from("messaging_groups")
      .update({ group_name: params.groupName })
      .eq("id", row.id)
      .select("id, channel_id, external_group_id, group_name")
      .single()
    return { group: patchError || !patched ? row : (patched as TelegramMessagingGroupRow) }
  }

  const { data: created, error: upsertError } = await supabaseAdmin
    .from("messaging_groups")
    .upsert(
      {
        channel_id: params.channelId,
        external_group_id: params.chatId,
        group_name: params.groupName ?? null,
        group_type: "lead_chat",
      },
      { onConflict: "channel_id,external_group_id" }
    )
    .select("id, channel_id, external_group_id, group_name")
    .single()

  if (upsertError || !created) {
    return { error: `messaging_groups upsert failed: ${upsertError?.message ?? "no row returned"}` }
  }

  return { group: created as TelegramMessagingGroupRow }
}
