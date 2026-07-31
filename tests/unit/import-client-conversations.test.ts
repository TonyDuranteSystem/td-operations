import { describe, it, expect, vi, beforeEach } from "vitest"

/**
 * Importing the 116 Slack client conversations into Team Chat.
 *
 * The failure that matters is an EMPTY thread: a conversation that appears in Team
 * Chat with no history reads to a human as "the messages were lost", and because the
 * record is then marked as imported it would be skipped for ever. So the rule the
 * tests defend is — a thread is created ONLY when there are messages to put in it.
 */

interface CT {
  id: string
  account_id: string | null
  contact_id: string | null
  lead_id: string | null
  topic_slug: string | null
  source_ref: string | null
  thread_id: string | null
  transcript: unknown
  summary: string | null
  created_at: string
  source: string
  status: string
}

const db = vi.hoisted(() => ({
  clientThreads: [] as CT[],
  threads: [] as Array<Record<string, unknown>>,
  messages: [] as Array<Record<string, unknown>>,
  reads: [] as Array<Record<string, unknown>>,
  threadInsertError: null as string | null,
}))

vi.mock("@/lib/team/directory", () => ({
  listTeamMembers: async () => [{ id: "user-antonio" }, { id: "user-luca" }],
}))

vi.mock("@/lib/supabase-admin", () => {
  function builder(table: string) {
    const filters: Array<[string, unknown]> = []
    let patch: Record<string, unknown> | null = null
    let inserted: unknown = null
    const b: Record<string, unknown> = {}
    const run = () => {
      if (inserted !== null) {
        if (table === "internal_threads") {
          if (db.threadInsertError) return { data: null, error: { message: db.threadInsertError } }
          const row = { id: `team-${db.threads.length + 1}`, ...(inserted as Record<string, unknown>) }
          db.threads.push(row)
          return { data: row, error: null }
        }
        if (table === "internal_messages") {
          for (const m of inserted as Array<Record<string, unknown>>) db.messages.push(m)
          return { data: null, error: null }
        }
        if (table === "internal_thread_reads") {
          for (const r of inserted as Array<Record<string, unknown>>) db.reads.push(r)
          return { data: null, error: null }
        }
        return { data: null, error: null }
      }
      if (patch) {
        const id = filters.find(([c]) => c === "id")?.[1] as string
        const row = db.clientThreads.find(r => r.id === id)
        if (row) Object.assign(row, patch)
        return { data: null, error: null }
      }
      if (table === "client_threads") {
        return { data: db.clientThreads.filter(r => filters.every(([c, v]) => (r as unknown as Record<string, unknown>)[c] === v)), error: null }
      }
      // accounts / contacts / leads name lookups
      return { data: { company_name: "Acme LLC", full_name: "Marco Rossi" }, error: null }
    }
    b.from = (t: string) => builder(t)
    b.select = () => b
    b.insert = (v: unknown) => { inserted = v; return b }
    b.upsert = (v: unknown) => { inserted = v; return b }
    b.update = (p: Record<string, unknown>) => { patch = p; return b }
    b.eq = (c: string, v: unknown) => { filters.push([c, v]); return b }
    b.order = () => b
    b.limit = () => b
    b.single = async () => run()
    b.maybeSingle = async () => run()
    b.then = (resolve: (v: unknown) => void) => Promise.resolve(run()).then(resolve)
    return b
  }
  return { supabaseAdmin: { from: (t: string) => builder(t) } }
})

import {
  importClientConversations,
  buildThreadTitle,
  slackTsToIso,
  maxIso,
  IMPORTED_SENDER_UUID,
} from "@/lib/team/import-client-conversations"

const TOKEN = "xoxb-test"

function seed(rows: Array<Partial<CT>>) {
  db.clientThreads = rows.map((r, i) => ({
    id: r.id ?? `c${i}`,
    account_id: r.account_id ?? "acct-1",
    contact_id: r.contact_id ?? null,
    lead_id: r.lead_id ?? null,
    topic_slug: r.topic_slug ?? "tax",
    source_ref: r.source_ref ?? "C1:1712345678.9012",
    thread_id: r.thread_id ?? null,
    transcript: r.transcript ?? null,
    summary: r.summary ?? null,
    created_at: r.created_at ?? "2026-06-21T10:00:00.000Z",
    source: "slack",
    status: "open",
  }))
}

const HISTORY = [
  { author: "Marco Rossi", text: "when is my tax return due?", ts: "1712345678.9012" },
  { author: "Luca", text: "we file it by the 15th", ts: "1712349999.0001" },
]

beforeEach(() => { db.clientThreads = []; db.threads = []; db.messages = []; db.reads = []; db.threadInsertError = null })

describe("the conversation arrives in Team Chat as itself", () => {
  it("creates a client-linked thread and writes the history into it", async () => {
    seed([{ id: "c1", transcript: HISTORY }])
    const report = await importClientConversations({ dryRun: false, token: TOKEN })

    expect(report.imported).toBe(1)
    expect(report.messages).toBe(2)
    const thread = db.threads[0]
    // It has to be the SAME kind of thread Team Chat already uses for a client, or it
    // will not show up beside the ones started here.
    expect(thread.thread_type).toBe("discussion")
    expect(thread.account_id).toBe("acct-1")
    expect(thread.topic_slug).toBe("tax")
    expect(String(thread.title)).toContain("Acme LLC")
    // REGRESSION: the creator column is NOT NULL in the real database. Omitting it
    // failed every import against sandbox while every unit test stayed green — the
    // fake table here has no constraints, so this assertion is the only guard.
    expect(thread.created_by).toBe(IMPORTED_SENDER_UUID)
  })

  it("keeps who said what, and when — not a clump stamped with the import time", async () => {
    seed([{ id: "c1", transcript: HISTORY }])
    await importClientConversations({ dryRun: false, token: TOKEN })

    expect(db.messages.map(m => m.sender_name)).toEqual(["Marco Rossi", "Luca"])
    expect(db.messages.map(m => m.message)).toEqual([
      "when is my tax return due?",
      "we file it by the 15th",
    ])
    // Original Slack times, in order — otherwise the whole conversation lands at once.
    expect(db.messages[0].created_at).toBe(new Date(1712345678.9012 * 1000).toISOString())
    expect(db.messages[1].created_at).toBe(new Date(1712349999.0001 * 1000).toISOString())
    // Imported rows are identifiable for ever and never look like a person posting.
    expect(new Set(db.messages.map(m => m.sender_id))).toEqual(new Set([IMPORTED_SENDER_UUID]))
  })

  it("history does not arrive as unread work for the team", async () => {
    seed([{ id: "c1", transcript: HISTORY }])
    await importClientConversations({ dryRun: false, token: TOKEN })
    expect(db.messages.every(m => m.read_at)).toBe(true)
  })

  it("REGRESSION: every staff member gets a read pointer — dated NOW, not the epoch", async () => {
    // The same row does two opposite jobs. Without it the conversation notifies
    // nobody ever (participation IS the read row), so an imported conversation would
    // be silent. Seeded at the epoch — what a NEW conversation does — the whole
    // imported history comes back as unread: 116 conversations, 116 badges.
    seed([{ id: "c1", transcript: HISTORY }])
    await importClientConversations({ dryRun: false, token: TOKEN })

    expect(db.reads.map(r => r.user_id).sort()).toEqual(["user-antonio", "user-luca"])
    for (const r of db.reads) {
      expect(r.thread_id).toBe("team-1")
      expect(String(r.last_read_at).startsWith("1970")).toBe(false)
      // Later than the imported messages, so none of them count as unread.
      expect(Date.parse(String(r.last_read_at))).toBeGreaterThan(1712349999_000)
    }
  })

  it("points the conversation record at its new Team Chat thread", async () => {
    seed([{ id: "c1", transcript: HISTORY }])
    await importClientConversations({ dryRun: false, token: TOKEN })
    expect(db.clientThreads[0].thread_id).toBe("team-1")
  })
})

describe("never an empty thread", () => {
  it("REGRESSION: a failed Slack read creates NOTHING", async () => {
    seed([{ id: "c1", transcript: null }])
    const fetchImpl = vi.fn(async () => ({ json: async () => ({ ok: false, error: "channel_not_found" }) }) as unknown as Response)
    const report = await importClientConversations({ dryRun: false, token: TOKEN, fetchImpl })

    expect(db.threads).toEqual([])
    expect(db.messages).toEqual([])
    expect(db.clientThreads[0].thread_id).toBeNull()
    expect(report.failed[0].reason).toMatch(/channel_not_found/)
  })

  it("a conversation with nothing in it is counted, not created", async () => {
    seed([{ id: "c1", transcript: null }])
    const fetchImpl = vi.fn(async () => ({ json: async () => ({ ok: true, messages: [] }) }) as unknown as Response)
    const report = await importClientConversations({ dryRun: false, token: TOKEN, fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(db.threads).toEqual([])
    expect(report.empty).toBe(1)
  })

  it("with no stored copy and no Slack key, it reports rather than importing a blank", async () => {
    seed([{ id: "c1", transcript: null }])
    const report = await importClientConversations({ dryRun: false, token: "" })
    expect(db.threads).toEqual([])
    expect(report.failed[0].reason).toMatch(/no Slack token/)
  })

  it("a thread that cannot be created is reported, and the record stays unlinked", async () => {
    seed([{ id: "c1", transcript: HISTORY }])
    db.threadInsertError = "permission denied"
    const report = await importClientConversations({ dryRun: false, token: TOKEN })
    expect(report.imported).toBe(0)
    expect(db.clientThreads[0].thread_id).toBeNull()
    expect(report.failed[0].reason).toMatch(/permission denied/)
  })
})

describe("safe to run twice", () => {
  it("skips a conversation already in Team Chat instead of duplicating it", async () => {
    seed([
      { id: "already", thread_id: "team-existing", transcript: HISTORY },
      { id: "new", transcript: HISTORY },
    ])
    const report = await importClientConversations({ dryRun: false, token: TOKEN })
    expect(report.skipped).toBe(1)
    expect(report.imported).toBe(1)
    expect(db.threads.length).toBe(1)
  })

  it("a dry run reports what it would do and writes NOTHING", async () => {
    seed([{ id: "c1", transcript: HISTORY }])
    const report = await importClientConversations({ dryRun: true, token: TOKEN })
    expect(report.imported).toBe(1)
    expect(report.messages).toBe(2)
    expect(db.threads).toEqual([])
    expect(db.messages).toEqual([])
    expect(db.clientThreads[0].thread_id).toBeNull()
  })

  it("uses the stored copy when there is one, and does not call Slack at all", async () => {
    seed([{ id: "c1", transcript: HISTORY }])
    const fetchImpl = vi.fn()
    await importClientConversations({ dryRun: false, token: TOKEN, fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe("titles and times", () => {
  it("names the thread after the client and what it is about", () => {
    expect(buildThreadTitle("Acme LLC", "tax")).toBe("Acme LLC — tax")
    expect(buildThreadTitle("Acme LLC", "annual_report")).toBe("Acme LLC — annual report")
    expect(buildThreadTitle(null, null)).toBe("Client conversation — general")
  })

  it("a thread's last-activity never predates its own creation", () => {
    // Slack timestamps and the record's date come from different clocks. A thread
    // stamped older than it is sinks to the bottom of the list and reads as dead.
    expect(maxIso("2024-04-05T00:00:00.000Z", "2026-06-21T10:00:00.000Z")).toBe("2026-06-21T10:00:00.000Z")
    expect(maxIso("2026-07-01T00:00:00.000Z", "2026-06-21T10:00:00.000Z")).toBe("2026-07-01T00:00:00.000Z")
    expect(maxIso("nonsense", "2026-06-21T10:00:00.000Z")).toBe("2026-06-21T10:00:00.000Z")
    expect(maxIso("2026-06-21T10:00:00.000Z", "nonsense")).toBe("2026-06-21T10:00:00.000Z")
  })

  it("falls back to the conversation's own date when Slack's timestamp is unusable", () => {
    const fallback = "2026-06-21T10:00:00.000Z"
    expect(slackTsToIso("1712345678.9012", fallback)).toBe(new Date(1712345678.9012 * 1000).toISOString())
    for (const bad of ["", "not-a-number", "0", "-5"]) {
      expect(slackTsToIso(bad, fallback)).toBe(fallback)
    }
  })
})
