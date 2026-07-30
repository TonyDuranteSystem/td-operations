import { describe, it, expect, vi, beforeEach } from "vitest"

/**
 * Getting 116 client conversations out of Slack before the workspace goes away.
 *
 * The whole risk of this job is a failure that LOOKS like success: Slack refuses,
 * the fetch returns nothing, and "no messages" is written down as the conversation's
 * permanent archive. There is no second chance — the source is gone afterwards. So
 * these tests are mostly about what must NOT be written.
 */

interface Row { id: string; source_ref: string | null; transcript: unknown; status: string; source: string }

const table = vi.hoisted(() => ({ rows: [] as Row[], writes: [] as Array<{ id: string; transcript: unknown }>, listError: null as string | null }))

vi.mock("@/lib/supabase-admin", () => {
  function builder() {
    const filters: Array<[string, unknown]> = []
    let patch: Record<string, unknown> | null = null
    const b: Record<string, unknown> = {}
    const run = () => {
      if (patch) {
        const id = filters.find(([c]) => c === "id")?.[1] as string
        table.writes.push({ id, transcript: (patch as { transcript?: unknown }).transcript })
        const row = table.rows.find(r => r.id === id)
        if (row) Object.assign(row, patch)
        return { data: null, error: null }
      }
      if (table.listError) return { data: null, error: { message: table.listError } }
      return {
        data: table.rows.filter(r => filters.every(([c, v]) => (r as unknown as Record<string, unknown>)[c] === v)),
        error: null,
      }
    }
    b.from = () => b
    b.select = () => b
    b.update = (p: Record<string, unknown>) => { patch = p; return b }
    b.eq = (c: string, v: unknown) => { filters.push([c, v]); return b }
    b.order = () => b
    b.limit = () => b
    b.then = (resolve: (v: unknown) => void) => Promise.resolve(run()).then(resolve)
    return b
  }
  return { supabaseAdmin: { from: () => builder() } }
})

import {
  rescueClientThreads,
  fetchThreadForArchive,
  parseSourceRef,
  makeAuthorResolver,
} from "@/lib/ai-agent/client-thread-rescue"

const TOKEN = "xoxb-test"

function slackOk(messages: Array<Record<string, unknown>>, nextCursor?: string) {
  return {
    ok: true,
    json: async () => ({
      ok: true,
      messages,
      ...(nextCursor ? { response_metadata: { next_cursor: nextCursor } } : {}),
    }),
  } as unknown as Response
}

function seed(rows: Array<Partial<Row>>) {
  table.rows = rows.map((r, i) => ({
    id: r.id ?? `t${i}`,
    source_ref: r.source_ref ?? "C1:111.1",
    transcript: r.transcript ?? null,
    status: r.status ?? "open",
    source: r.source ?? "slack",
  }))
}

beforeEach(() => { table.rows = []; table.writes = []; table.listError = null })

describe("a failed read is NEVER written down as an empty conversation", () => {
  it("Slack refusing the request leaves the record untouched and names the reason", async () => {
    seed([{ id: "a" }])
    const fetchImpl = vi.fn(async () => ({ json: async () => ({ ok: false, error: "channel_not_found" }) }) as unknown as Response)
    const report = await rescueClientThreads({ dryRun: false, token: TOKEN, fetchImpl })
    expect(table.writes).toEqual([])
    expect(report.archived).toBe(0)
    expect(report.failed).toEqual([{ id: "a", reason: "slack: channel_not_found" }])
  })

  it("a network failure is a failure, not an empty archive", async () => {
    seed([{ id: "a" }])
    const fetchImpl = vi.fn(async () => { throw new Error("socket hang up") })
    const report = await rescueClientThreads({ dryRun: false, token: TOKEN, fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(table.writes).toEqual([])
    expect(report.failed[0].reason).toMatch(/network: socket hang up/)
  })

  it("a genuinely empty thread is counted, but still not archived — so a retry can find it", async () => {
    seed([{ id: "a" }])
    const fetchImpl = vi.fn(async () => slackOk([]))
    const report = await rescueClientThreads({ dryRun: false, token: TOKEN, fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(table.writes).toEqual([])
    expect(report.empty).toBe(1)
    expect(report.archived).toBe(0)
  })

  it("no token → reads nothing and writes nothing, and says so", async () => {
    seed([{ id: "a" }])
    const report = await rescueClientThreads({ dryRun: false, token: "" })
    expect(table.writes).toEqual([])
    expect(report.failed[0].reason).toMatch(/no Slack token/)
  })

  it("a record with no usable Slack pointer is reported, never guessed at", async () => {
    seed([{ id: "a", source_ref: "not-a-pointer" }])
    const fetchImpl = vi.fn(async () => slackOk([{ text: "hi", ts: "1", user: "U1" }]))
    const report = await rescueClientThreads({ dryRun: false, token: TOKEN, fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(report.failed[0].reason).toMatch(/no usable Slack pointer/)
  })
})

describe("the archive is complete and re-runnable", () => {
  it("writes the messages it read", async () => {
    seed([{ id: "a" }])
    const fetchImpl = vi.fn(async (url: string) =>
      url.includes("users.info")
        ? ({ json: async () => ({ ok: true, user: { real_name: "Luca Rossi" } }) } as unknown as Response)
        : slackOk([{ text: "the client asked about the EIN", ts: "111.1", user: "U1" }]),
    )
    const report = await rescueClientThreads({ dryRun: false, token: TOKEN, fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(report.archived).toBe(1)
    expect(table.writes[0].transcript).toEqual([
      { author: "Luca Rossi", text: "the client asked about the EIN", ts: "111.1" },
    ])
  })

  it("REGRESSION: a long conversation is followed to the end, not cut at the first page", async () => {
    // conversations.replies caps a page at 100. The live path asks for 100 and keeps
    // whatever came back — fine for a panel you can reopen, silent truncation in a
    // permanent archive nobody can check afterwards.
    seed([{ id: "a" }])
    let call = 0
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("users.info")) return { json: async () => ({ ok: true, user: { real_name: "Antonio" } }) } as unknown as Response
      call++
      return call === 1
        ? slackOk([{ text: "page one", ts: "1", user: "U1" }], "CURSOR2")
        : slackOk([{ text: "page two", ts: "2", user: "U1" }])
    })
    await rescueClientThreads({ dryRun: false, token: TOKEN, fetchImpl: fetchImpl as unknown as typeof fetch })
    const written = table.writes[0].transcript as Array<{ text: string }>
    expect(written.map(m => m.text)).toEqual(["page one", "page two"])
  })

  it("skips a conversation that is already archived, so a re-run only fills the gaps", async () => {
    seed([
      { id: "done", transcript: [{ author: "Antonio", text: "already saved", ts: "1" }] },
      { id: "todo" },
    ])
    const fetchImpl = vi.fn(async (url: string) =>
      url.includes("users.info")
        ? ({ json: async () => ({ ok: true, user: { real_name: "Antonio" } }) } as unknown as Response)
        : slackOk([{ text: "new one", ts: "2", user: "U1" }]),
    )
    const report = await rescueClientThreads({ dryRun: false, token: TOKEN, fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(report.skipped).toBe(1)
    expect(table.writes.map(w => w.id)).toEqual(["todo"])
  })

  it("a dry run reads Slack and writes NOTHING", async () => {
    seed([{ id: "a" }])
    const fetchImpl = vi.fn(async (url: string) =>
      url.includes("users.info")
        ? ({ json: async () => ({ ok: true, user: { real_name: "Antonio" } }) } as unknown as Response)
        : slackOk([{ text: "hello", ts: "1", user: "U1" }]),
    )
    const report = await rescueClientThreads({ dryRun: true, token: TOKEN, fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(report.archived).toBe(1)
    expect(report.dryRun).toBe(true)
    expect(table.writes).toEqual([])
  })

  it("one broken conversation does not abandon the rest of the run", async () => {
    seed([{ id: "bad" }, { id: "good" }])
    let n = 0
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("users.info")) return { json: async () => ({ ok: true, user: { real_name: "Antonio" } }) } as unknown as Response
      n++
      return n === 1
        ? ({ json: async () => ({ ok: false, error: "thread_not_found" }) } as unknown as Response)
        : slackOk([{ text: "survived", ts: "1", user: "U1" }])
    })
    const report = await rescueClientThreads({ dryRun: false, token: TOKEN, fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(report.failed.map(f => f.id)).toEqual(["bad"])
    expect(table.writes.map(w => w.id)).toEqual(["good"])
  })
})

describe("who said what survives the move", () => {
  it("resolves real names instead of flattening everyone to 'Team'", async () => {
    const fetchImpl = vi.fn(async () => ({ json: async () => ({ ok: true, user: { real_name: "Luca Rossi" } }) }) as unknown as Response)
    const resolve = makeAuthorResolver(TOKEN, fetchImpl as unknown as typeof fetch)
    expect(await resolve({ user: "U9" })).toBe("Luca Rossi")
  })

  it("looks a person up ONCE per run", async () => {
    const fetchImpl = vi.fn(async () => ({ json: async () => ({ ok: true, user: { real_name: "Luca Rossi" } }) }) as unknown as Response)
    const resolve = makeAuthorResolver(TOKEN, fetchImpl as unknown as typeof fetch)
    await resolve({ user: "U9" })
    await resolve({ user: "U9" })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it("keeps a bot's own name, and falls back only when Slack cannot say", async () => {
    const fetchImpl = vi.fn(async () => ({ json: async () => ({ ok: false }) }) as unknown as Response)
    const resolve = makeAuthorResolver(TOKEN, fetchImpl as unknown as typeof fetch)
    expect(await resolve({ bot_profile: { name: "Claude" } })).toBe("Claude")
    expect(await resolve({ user: "U-unknown" })).toBe("Team")
    expect(await resolve({})).toBe("Team")
  })
})

describe("parseSourceRef", () => {
  it("reads a channel/timestamp pointer", () => {
    expect(parseSourceRef("C123:1712345678.9012")).toEqual({ channelId: "C123", threadTs: "1712345678.9012" })
  })
  it("refuses anything else rather than inventing a pointer", () => {
    for (const bad of [null, undefined, "", "C123", ":", "C123:", ":123"]) {
      expect(parseSourceRef(bad as string | null)).toBeNull()
    }
  })
})

describe("fetchThreadForArchive", () => {
  it("stops after a bounded number of pages even if Slack keeps handing back a cursor", async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      url.includes("users.info")
        ? ({ json: async () => ({ ok: true, user: { real_name: "A" } }) } as unknown as Response)
        : slackOk([{ text: "x", ts: "1", user: "U1" }], "ALWAYS"),
    )
    const resolve = makeAuthorResolver(TOKEN, fetchImpl as unknown as typeof fetch)
    const out = await fetchThreadForArchive("C1", "1", TOKEN, resolve, fetchImpl as unknown as typeof fetch)
    expect(out.ok).toBe(true)
    // Bounded: it returns rather than spinning for ever on a repeating cursor.
    expect(out.messages.length).toBe(20)
  })
})
