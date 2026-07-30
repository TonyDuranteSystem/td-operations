import { describe, it, expect, beforeEach, vi } from "vitest"

/**
 * WHOSE frozen email does a Confirm card belong to?
 *
 * A worker conversation is SHARED. In Team Chat `thread_uuid` is the whole channel;
 * on the Inbox and client-chat panels it is the email thread / the client, and two
 * staff can have that same screen open. The picker used to take "the newest pending
 * row on this conversation", which under two overlapping turns handed one person's
 * answer the OTHER person's frozen email — while their own draft got no card at all
 * and expired unseen. The failure-path cancel had the mirror bug: it cancelled a
 * colleague's live draft because the row postdated this turn's snapshot.
 *
 * These tests drive the real helpers against a fake table that honours the filters,
 * so a dropped `.eq("actor", …)` fails here rather than in a shared channel.
 */

interface Row {
  id: string
  thread_uuid: string
  actor: string
  status: string
  created_at: string
  to_address: string
  subject: string
  body: string | null
  attachments: Array<{ name: string; size?: number }>
}

const table = vi.hoisted(() => ({ rows: [] as Row[], failNextSelect: false }))

vi.mock("@/lib/supabase-admin", () => {
  function builder() {
    const filters: Array<[string, unknown]> = []
    let patch: Record<string, unknown> | null = null
    let inFilter: { col: string; vals: unknown[] } | null = null
    let asc = true

    const match = (r: Row) =>
      filters.every(([c, v]) => (r as unknown as Record<string, unknown>)[c] === v) &&
      (!inFilter || inFilter.vals.includes((r as unknown as Record<string, unknown>)[inFilter.col]))

    const run = () => {
      if (table.failNextSelect) {
        table.failNextSelect = false
        return { data: null, error: { message: "boom" } }
      }
      const hits = table.rows.filter(match)
      if (patch) {
        for (const r of hits) Object.assign(r, patch)
        return { data: null, error: null }
      }
      const sorted = [...hits].sort((a, b) =>
        asc ? a.created_at.localeCompare(b.created_at) : b.created_at.localeCompare(a.created_at),
      )
      return { data: sorted, error: null }
    }

    const b: Record<string, unknown> = {}
    b.from = () => b
    b.select = () => b
    b.update = (p: Record<string, unknown>) => { patch = p; return b }
    b.eq = (c: string, v: unknown) => { filters.push([c, v]); return b }
    b.in = (c: string, vals: unknown[]) => { inFilter = { col: c, vals }; return b }
    b.order = (_c: string, o?: { ascending?: boolean }) => { asc = o?.ascending !== false; return b }
    b.then = (resolve: (v: unknown) => void) => Promise.resolve(run()).then(resolve)
    return b
  }
  return { supabaseAdmin: { from: () => builder() } }
})

import {
  snapshotPendingPreparedIds,
  findPreparedFrozenThisTurn,
  cancelPreparedFrozenThisTurn,
} from "@/lib/inbox/worker-email-send"

const CHANNEL = "channel-td-support"
const ANTONIO = "team-chat:Antonio Durante"
const LUCA = "team-chat:Luca"

function freeze(id: string, actor: string, at: string, to: string): Row {
  const row: Row = {
    id,
    thread_uuid: CHANNEL,
    actor,
    status: "pending",
    created_at: at,
    to_address: to,
    subject: `draft ${id}`,
    body: `body of ${id}`,
    attachments: [],
  }
  table.rows.push(row)
  return row
}

beforeEach(() => { table.rows = []; table.failNextSelect = false })

describe("two overlapping turns in one shared conversation", () => {
  it("REGRESSION: each turn's card carries ITS OWN frozen email, not the other person's", async () => {
    // Both turns start with nothing pending, then Luca's freeze lands FIRST — which
    // is precisely the ordering that made the old oldest-first picker hand Antonio
    // Luca's recipient (and leave Antonio's own draft cardless).
    const antonioPrior = await snapshotPendingPreparedIds(CHANNEL, ANTONIO)
    const lucaPrior = await snapshotPendingPreparedIds(CHANNEL, LUCA)
    freeze("luca-draft", LUCA, "2026-07-30T10:00:00Z", "accountant@example.com")
    freeze("antonio-draft", ANTONIO, "2026-07-30T10:00:05Z", "bank@example.com")

    const forAntonio = await findPreparedFrozenThisTurn(CHANNEL, ANTONIO, antonioPrior)
    const forLuca = await findPreparedFrozenThisTurn(CHANNEL, LUCA, lucaPrior)

    expect(forAntonio?.id).toBe("antonio-draft")
    expect(forAntonio?.to_address).toBe("bank@example.com")
    expect(forLuca?.id).toBe("luca-draft")
    expect(forLuca?.to_address).toBe("accountant@example.com")
    // Neither draft is lost: both got a card, and they are different rows.
    expect(forAntonio?.id).not.toBe(forLuca?.id)
  })

  it("REGRESSION: a failing turn cancels only its own draft, never the colleague's live one", async () => {
    const antonioPrior = await snapshotPendingPreparedIds(CHANNEL, ANTONIO)
    freeze("luca-draft", LUCA, "2026-07-30T10:00:00Z", "accountant@example.com")
    freeze("antonio-draft", ANTONIO, "2026-07-30T10:00:05Z", "bank@example.com")

    await cancelPreparedFrozenThisTurn(CHANNEL, ANTONIO, antonioPrior)

    expect(table.rows.find(r => r.id === "antonio-draft")!.status).toBe("cancelled")
    expect(table.rows.find(r => r.id === "luca-draft")!.status).toBe("pending")
  })
})

describe("a card only ever belongs to the turn that froze it", () => {
  it("does not resurface the same person's OWN earlier unconfirmed draft", async () => {
    freeze("yesterday", ANTONIO, "2026-07-29T09:00:00Z", "old@example.com")
    const prior = await snapshotPendingPreparedIds(CHANNEL, ANTONIO)
    expect(await findPreparedFrozenThisTurn(CHANNEL, ANTONIO, prior)).toBeNull()
  })

  it("returns null on a turn that froze nothing", async () => {
    const prior = await snapshotPendingPreparedIds(CHANNEL, ANTONIO)
    expect(await findPreparedFrozenThisTurn(CHANNEL, ANTONIO, prior)).toBeNull()
  })

  it("ignores rows that are no longer pending", async () => {
    const prior = await snapshotPendingPreparedIds(CHANNEL, ANTONIO)
    const row = freeze("superseded", ANTONIO, "2026-07-30T10:00:00Z", "x@example.com")
    row.status = "cancelled"
    expect(await findPreparedFrozenThisTurn(CHANNEL, ANTONIO, prior)).toBeNull()
  })

  it("never crosses conversations", async () => {
    const prior = await snapshotPendingPreparedIds(CHANNEL, ANTONIO)
    const other = freeze("elsewhere", ANTONIO, "2026-07-30T10:00:00Z", "x@example.com")
    other.thread_uuid = "a-different-channel"
    expect(await findPreparedFrozenThisTurn(CHANNEL, ANTONIO, prior)).toBeNull()
  })
})

describe("an unreadable snapshot fails to NO CARD, never to a guess", () => {
  it("reports known=false when the snapshot lookup errors", async () => {
    table.failNextSelect = true
    const prior = await snapshotPendingPreparedIds(CHANNEL, ANTONIO)
    expect(prior.known).toBe(false)
  })

  it("suppresses the card, and cancels nothing, when the snapshot is unknown", async () => {
    // Without the snapshot this turn's draft cannot be told from anyone else's, so
    // showing a card risks confirming the wrong email and cancelling risks killing a
    // colleague's. Both directions must decline.
    freeze("someone-elses", LUCA, "2026-07-30T10:00:00Z", "x@example.com")
    const unknown = { ids: new Set<string>(), known: false }
    expect(await findPreparedFrozenThisTurn(CHANNEL, ANTONIO, unknown)).toBeNull()
    await cancelPreparedFrozenThisTurn(CHANNEL, ANTONIO, unknown)
    expect(table.rows.find(r => r.id === "someone-elses")!.status).toBe("pending")
  })
})
