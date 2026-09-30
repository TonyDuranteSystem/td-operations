/**
 * LIVE (sandbox): the new one-request team-thread list returns EXACTLY what the old per-thread loop returned — on every
 * thread already in the sandbox plus fixtures for each tricky case (account / contact / title-only / untitled, no
 * messages, deleted last message, read vs unread, my own messages, a source message, an emoji-long preview).
 * Also counts the database requests each version makes (the whole point of the change).
 */
import { describe, it, expect, beforeAll } from "vitest"
import { randomUUID } from "crypto"
import { supabaseAdmin } from "@/lib/supabase-admin"
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any
const tag = Date.now()
const me = randomUUID()
const other = randomUUID()

async function insert(table: string, row: Record<string, unknown>): Promise<string> {
  const { data, error } = await db.from(table).insert(row).select("id").single()
  if (error) throw new Error(`${table}: ${error.message}`)
  return data.id as string
}

beforeAll(async () => {
  const { data: acct } = await db.from("accounts").select("id").limit(1).single()
  const { data: ct } = await db.from("contacts").select("id").limit(1).single()
  const { data: pm } = await db.from("portal_messages").select("id").limit(1).single()
  const mk = (over: Record<string, unknown>) => insert("internal_threads", { created_by: other, ...over })
  const msg = (thread_id: string, over: Record<string, unknown>) => insert("internal_messages", { thread_id, sender_id: other, sender_name: "ZZ Other", message: "hello", ...over })
  const tAcct = await mk({ title: `ZZ-T1 ${tag}`, account_id: acct.id })
  await msg(tAcct, { message: "one" }); await msg(tAcct, { message: "two", read_at: new Date().toISOString() }); await msg(tAcct, { message: "three" })
  await msg(tAcct, { sender_id: me, sender_name: "ZZ Me", message: "mine (never counted as unread)" })
  await msg(tAcct, { message: "😀".repeat(120) + " long emoji preview" })           // astral characters: the 80-character preview must match
  const tCt = await mk({ title: `ZZ-T2 ${tag}`, contact_id: ct.id }); await msg(tCt, { message: "from a contact thread" })
  const tTitle = await mk({ title: `ZZ-T3 ${tag}` }); await msg(tTitle, { message: "title only" })
  await mk({ title: null })                                                              // no name at all → 'Team Thread', no messages
  const tDel = await mk({ title: `ZZ-T5 ${tag}` }); await msg(tDel, { message: "visible" }); await msg(tDel, { message: "deleted latest", deleted_at: new Date().toISOString() })
  const tSrc = await mk({ title: `ZZ-T6 ${tag}`, source_message_id: pm.id }); await msg(tSrc, { message: "with a source message" })
}, 120_000)

describe("team-thread list: one request = the old loop, field for field", () => {
  it("identical output on every thread in the sandbox", async () => {
    const { listInternalThreads, listInternalThreadsLegacy } = await import("@/lib/internal/thread-list")
    const fresh = await listInternalThreads(me)
    const old = await listInternalThreadsLegacy(me)
    expect(fresh.length).toBeGreaterThan(5)                      // the positive control: a non-trivial list was compared
    expect(fresh.length).toBe(old.length)
    expect(fresh).toEqual(old)
    // the tricky cases really are in the compared list
    const names = fresh.map((t) => t.company_name)
    expect(names).toContain("Team Thread")
    expect(fresh.some((t) => t.unread_count === 3)).toBe(true)   // T1: 3 unread from others (my own message excluded)
    expect(fresh.some((t) => t.source_message)).toBe(true)
  }, 120_000)

  it("the new version makes ONE database request where the old one made hundreds", async () => {
    const realFetch = globalThis.fetch
    let n = 0
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => { if (String(input instanceof Request ? input.url : input).includes("/rest/v1/")) n++; return realFetch(input, init) }) as typeof fetch
    try {
      const { listInternalThreads, listInternalThreadsLegacy } = await import("@/lib/internal/thread-list")
      n = 0; await listInternalThreads(me); const fresh = n
      n = 0; await listInternalThreadsLegacy(me); const old = n
      expect(fresh).toBe(1)
      expect(old).toBeGreaterThan(20)
    } finally { globalThis.fetch = realFetch }
  }, 120_000)
})
