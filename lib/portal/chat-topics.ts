/**
 * Open topics of one portal chat — shared by the staff "eye" pop-up (document-share-message.ts) and the Calendar
 * "Message client" window (app/api/flows/[id]/chat). A topic is just the name stamped on portal_messages.topic, so the
 * list is derived from the chat's own non-deleted messages, newest first, distinct ignoring case.
 */
import { supabaseAdmin } from "@/lib/supabase-admin"

export async function openTopicsOf(scope: { accountId: string } | { contactId: string }): Promise<string[]> {
  let q = supabaseAdmin.from("portal_messages").select("topic, created_at").is("deleted_at", null).not("topic", "is", null)
  q = "accountId" in scope ? q.eq("account_id", scope.accountId) : q.is("account_id", null).eq("contact_id", scope.contactId)
  const { data } = await q.order("created_at", { ascending: false }).limit(300)
  const seen = new Set<string>()
  const out: string[] = []
  for (const r of (data ?? []) as { topic: string | null }[]) {
    const t = (r.topic ?? "").trim()
    if (t && !seen.has(t.toLowerCase())) { seen.add(t.toLowerCase()); out.push(t) }
  }
  return out
}

