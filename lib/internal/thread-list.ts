/**
 * The internal team-thread list behind GET /api/internal/threads (Portal Chats screen).
 *
 * WHY THIS FILE EXISTS (2026-09-30, Supabase egress over quota): the route used to loop over up to 100 threads and run
 * separate requests per thread (account name, contact name, unread count, last message, source message) — hundreds of
 * database requests per refresh, every 10 s per open tab, ~65% of all production API requests. `listInternalThreads`
 * gets the same list from ONE database function (`internal_threads_overview`). If that function is not installed yet
 * (the migration runs separately in production) it falls back to the old per-thread path, so deploying the code first
 * can never break the screen. The output shape is IDENTICAL to the old route's — a test compares them.
 */
import { supabaseAdmin } from "@/lib/supabase-admin"

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a new function not in the generated types
const db = () => supabaseAdmin as any

export interface ThreadListItem {
  [column: string]: unknown
  company_name: string
  contact_name: string | null
  unread_count: number
  last_message_at: string
  last_message_preview: string | null
  source_message: string | null
}

interface OverviewRow {
  thread: Record<string, unknown>
  account_name: string | null
  contact_name: string | null
  unread_count: number | string | null
  last_message_at: string | null
  last_message: string | null
  source_message: string | null
}

/** Pure: one database row → one list item (the exact rules the old route applied). */
export function shapeThread(r: OverviewRow): ThreadListItem {
  const thread = r.thread
  const title = (thread.title as string | null) ?? null
  return {
    ...thread,
    company_name: r.account_name ?? r.contact_name ?? title ?? "Team Thread",
    contact_name: r.contact_name ?? null,
    unread_count: Number(r.unread_count ?? 0),
    last_message_at: r.last_message_at ?? (thread.created_at as string),
    last_message_preview: r.last_message?.slice(0, 80) ?? null,
    source_message: r.source_message ?? null,
  }
}

/** Pure: newest activity first — same sort the old route used. */
export function sortThreads<T extends { last_message_at: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => new Date(b.last_message_at).getTime() - new Date(a.last_message_at).getTime())
}

export function isMissingFunction(err: { code?: string; message?: string } | null): boolean {
  return !!err && (err.code === "PGRST202" || err.code === "42883" || /could not find the function|does not exist/i.test(err.message ?? ""))
}

/** The old way: several requests PER thread. Kept as the fallback and as the reference the test compares against. */
export async function listInternalThreadsLegacy(userId: string): Promise<ThreadListItem[]> {
  const { data: threads, error } = await db().from("internal_threads").select("*").order("created_at", { ascending: false }).limit(100)
  if (error) throw new Error(error.message)
  const rows: ThreadListItem[] = await Promise.all((threads ?? []).map(async (thread: Record<string, unknown>) => {
    let accountName: string | null = null
    let contactName: string | null = null
    if (thread.account_id) accountName = (await db().from("accounts").select("company_name").eq("id", thread.account_id).single()).data?.company_name ?? null
    if (thread.contact_id) contactName = (await db().from("contacts").select("full_name").eq("id", thread.contact_id).single()).data?.full_name ?? null
    const { count } = await db().from("internal_messages").select("id", { count: "exact", head: true }).eq("thread_id", thread.id).neq("sender_id", userId).is("read_at", null)
    const { data: lastMsg } = await db().from("internal_messages").select("created_at, message").eq("thread_id", thread.id).order("created_at", { ascending: false }).limit(1).single()
    let sourceMessage: string | null = null
    if (thread.source_message_id) sourceMessage = (await db().from("portal_messages").select("message").eq("id", thread.source_message_id).single()).data?.message ?? null
    return shapeThread({ thread, account_name: accountName, contact_name: contactName, unread_count: count ?? 0, last_message_at: lastMsg?.created_at ?? null, last_message: lastMsg?.message ?? null, source_message: sourceMessage })
  }))
  return sortThreads(rows)
}

/** The list, in ONE request. Falls back to the old path only when the database function is not installed. */
export async function listInternalThreads(userId: string): Promise<ThreadListItem[]> {
  const { data, error } = await db().rpc("internal_threads_overview", { p_user_id: userId, p_limit: 100 })
  if (error) {
    if (isMissingFunction(error)) return listInternalThreadsLegacy(userId)
    throw new Error(error.message)
  }
  return sortThreads(((data ?? []) as OverviewRow[]).map(shapeThread))
}
