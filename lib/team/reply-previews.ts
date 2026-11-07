import { supabaseAdmin } from '@/lib/supabase-admin'

/** Adds the quoted-message preview to each message that is a reply (one query for all of them). Shared by the default chat answer and TD Talk's light one. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function withReplyPreviews(messages: any[], client: any = supabaseAdmin): Promise<any[]> {
  const replyIds = Array.from(new Set(messages.filter(m => m.reply_to_id).map(m => m.reply_to_id)))
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const parentMap = new Map<string, any>()
  if (replyIds.length > 0) {
    const { data: parents } = await client
      .from('internal_messages')
      .select('id, message, sender_name, deleted_at')
      .in('id', replyIds)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(parents ?? []).forEach((p: any) => parentMap.set(p.id, p))
  }
  return messages.map(m => ({
    ...m,
    reply_to_preview: m.reply_to_id ? (parentMap.get(m.reply_to_id) ?? null) : null,
  }))
}
