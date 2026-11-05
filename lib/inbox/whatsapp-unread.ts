import { supabaseAdmin } from "@/lib/supabase-admin"

/**
 * Unread WhatsApp conversations — WhatsApp ONLY.
 *
 * messaging_groups holds BOTH WhatsApp and Telegram rows (messaging_channels.platform distinguishes them), so a sum with no
 * platform filter silently folds Telegram into the "WhatsApp" number (Antonio, 2026-09-19: the badge showed 5 with nothing unread
 * in the WhatsApp list; the 5 was 2 unread Telegram conversations). This is the ONE place that filter lives: the WhatsApp menu
 * row, its first paint (dashboard layout) and the Inbox's own tab count all read it. Any failure counts as 0 (a badge must never
 * break a page).
 */
export async function getWhatsappUnread(): Promise<number> {
  try {
    const { data: channels } = await supabaseAdmin
      .from("messaging_channels")
      .select("id")
      .eq("platform", "whatsapp")
    const ids = (channels ?? []).map((c) => c.id)
    if (ids.length === 0) return 0
    const { data, error } = await supabaseAdmin
      .from("messaging_groups")
      .select("unread_count")
      .eq("is_active", true)
      .gt("unread_count", 0)
      .in("channel_id", ids)
    if (error) return 0
    return (data ?? []).reduce((sum: number, row: { unread_count: number | null }) => sum + (row.unread_count ?? 0), 0)
  } catch {
    return 0
  }
}
