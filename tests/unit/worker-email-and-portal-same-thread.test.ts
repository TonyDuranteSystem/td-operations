import { describe, it, expect, vi, beforeEach } from "vitest"

/**
 * BOTH KINDS ON ONE CONVERSATION — the scenario Antonio asked to be tested
 * (2026-08-02): Luca replies to a client BY EMAIL and also sends that client a
 * PORTAL CHAT message, on the same Inbox thread, in the same sitting.
 *
 * It is the obvious way to break the freeze-then-Confirm rail, because every
 * moving part is keyed on (thread, actor) and now has to stay keyed on
 * (thread, actor, KIND) as well:
 *
 *   - supersede must not cancel across kinds — freezing a portal draft must
 *     leave a pending email draft alone, and vice versa. If it did cancel
 *     across kinds, asking for a portal message would silently kill the email
 *     the staff member was still reading, and their Confirm would then hit a
 *     cancelled row ("this draft is no longer available") with no explanation.
 *
 *   - the card lookup must return the row THIS turn froze, whatever its kind,
 *     so an email turn can never render a portal card (no picker, no language
 *     dropdown → an unsendable card) and a portal turn can never render an
 *     email card (which would show "Confirm email to null", because the
 *     database physically forbids a portal row from holding an address).
 *
 * Neither property is visible in the UI until it is already wrong, and both are
 * one `.eq()` away from being lost in a refactor — so they are pinned here.
 *
 * These are the real exported functions; only the Supabase client is faked, and
 * the fake RECORDS the filters so the assertions are about what was actually
 * sent to the database, not about what the code looks like.
 */

type Row = { id: string; kind: string; status: string; created_at: string; [k: string]: unknown }

const state = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  /** Every UPDATE the code issued: its patch plus the filters it carried. */
  updates: [] as Array<{ patch: Record<string, unknown>; filters: Record<string, unknown>; not: Record<string, unknown> }>,
}))

vi.mock("@/lib/supabase-admin", () => {
  const makeBuilder = () => {
    const q: Record<string, unknown> = {}
    const filters: Record<string, unknown> = {}
    const not: Record<string, unknown> = {}
    let mode: "select" | "update" | "insert" = "select"
    let patch: Record<string, unknown> = {}
    let inserted: Record<string, unknown> = {}
    let order: { col: string; asc: boolean } | null = null

    const matching = () =>
      state.rows.filter(
        (r) =>
          Object.entries(filters).every(([k, v]) => r[k] === v) &&
          Object.entries(not).every(([k, v]) => r[k] !== v),
      )

    q.from = () => q
    q.select = () => q
    q.insert = (row: Record<string, unknown>) => {
      mode = "insert"
      inserted = { ...row }
      return q
    }
    q.update = (p: Record<string, unknown>) => {
      mode = "update"
      patch = p
      return q
    }
    q.eq = (col: string, val: unknown) => {
      filters[col] = val
      return q
    }
    q.neq = (col: string, val: unknown) => {
      not[col] = val
      return q
    }
    q.is = (col: string, val: unknown) => {
      filters[col] = val
      return q
    }
    q.order = (col: string, opts?: { ascending?: boolean }) => {
      order = { col, asc: opts?.ascending !== false }
      return q
    }
    q.single = async () => {
      if (mode === "insert") {
        const row = { id: inserted.id ?? `row-${state.rows.length + 1}`, ...inserted }
        state.rows.push(row)
        return { data: row, error: null }
      }
      return { data: matching()[0] ?? null, error: null }
    }
    q.maybeSingle = q.single
    // Bare awaited chains (the supersede UPDATE, and the SELECT that ends in
    // .order()) resolve through this.
    q.then = (resolve: (v: unknown) => void) => {
      if (mode === "update") {
        state.updates.push({ patch, filters: { ...filters }, not: { ...not } })
        for (const r of matching()) Object.assign(r, patch)
        return Promise.resolve({ error: null }).then(resolve)
      }
      let data = matching()
      if (order) {
        const { col, asc } = order
        data = [...data].sort((a, b) =>
          asc ? String(a[col]).localeCompare(String(b[col])) : String(b[col]).localeCompare(String(a[col])),
        )
      }
      return Promise.resolve({ data, error: null }).then(resolve)
    }
    return q
  }
  return { supabaseAdmin: new Proxy({}, { get: (_t, prop) => (makeBuilder() as Record<string, unknown>)[prop as string] }) }
})

import {
  supersedeEarlierDrafts,
  snapshotPendingPreparedIds,
  findPreparedFrozenThisTurn,
} from "@/lib/inbox/worker-email-send"

const THREAD = "thread-chiara"
const ACTOR = "luca@tonydurante.us"

/** A pending row already sitting on the thread, as the database would hold it. */
function seed(row: Partial<Row> & { id: string; kind: string }) {
  state.rows.push({
    thread_uuid: THREAD,
    actor: ACTOR,
    status: "pending",
    created_at: "2026-08-02T10:00:00Z",
    to_address: null,
    subject: null,
    body: "…",
    attachments: [],
    proposed_account_id: null,
    proposed_contact_id: null,
    draft_locale: null,
    ...row,
  })
}

beforeEach(() => {
  state.rows = []
  state.updates = []
})

describe("email + portal on the SAME thread — supersede never crosses kinds", () => {
  it("freezing a PORTAL draft leaves the pending EMAIL draft untouched", async () => {
    seed({ id: "email-1", kind: "email", to_address: "chiara@example.com", subject: "Re: password" })
    seed({ id: "portal-1", kind: "portal", created_at: "2026-08-02T10:05:00Z" })

    await supersedeEarlierDrafts({ threadUuid: THREAD, actor: ACTOR, kind: "portal", keepId: "portal-1" })

    const email = state.rows.find((r) => r.id === "email-1")!
    expect(email.status).toBe("pending") // still the staff member's to confirm
    // And the filter itself carried the kind — the property, not just the outcome.
    expect(state.updates.at(-1)!.filters.kind).toBe("portal")
    expect(state.updates.at(-1)!.not.id).toBe("portal-1")
  })

  it("freezing an EMAIL draft leaves the pending PORTAL draft untouched", async () => {
    seed({ id: "portal-1", kind: "portal" })
    seed({ id: "email-2", kind: "email", to_address: "chiara@example.com", subject: "Re: password", created_at: "2026-08-02T10:05:00Z" })

    await supersedeEarlierDrafts({ threadUuid: THREAD, actor: ACTOR, kind: "email", keepId: "email-2" })

    expect(state.rows.find((r) => r.id === "portal-1")!.status).toBe("pending")
    expect(state.updates.at(-1)!.filters.kind).toBe("email")
  })

  it("still supersedes an EARLIER draft of the SAME kind (the redraft case is not weakened)", async () => {
    seed({ id: "email-old", kind: "email", to_address: "chiara@example.com", subject: "v1" })
    seed({ id: "email-new", kind: "email", to_address: "chiara@example.com", subject: "v2", created_at: "2026-08-02T10:05:00Z" })

    await supersedeEarlierDrafts({ threadUuid: THREAD, actor: ACTOR, kind: "email", keepId: "email-new" })

    expect(state.rows.find((r) => r.id === "email-old")!.status).toBe("cancelled")
    expect(state.rows.find((r) => r.id === "email-new")!.status).toBe("pending")
  })

  it("never reaches across ACTORS, even for the same kind and thread", async () => {
    seed({ id: "email-mine", kind: "email", to_address: "a@b.c", subject: "s", created_at: "2026-08-02T10:05:00Z" })
    state.rows.push({
      id: "email-theirs",
      thread_uuid: THREAD,
      actor: "antonio@tonydurante.us",
      kind: "email",
      status: "pending",
      created_at: "2026-08-02T09:00:00Z",
    })

    await supersedeEarlierDrafts({ threadUuid: THREAD, actor: ACTOR, kind: "email", keepId: "email-mine" })

    expect(state.rows.find((r) => r.id === "email-theirs")!.status).toBe("pending")
  })
})

describe("email + portal on the SAME thread — the card shown is the one THIS turn froze", () => {
  it("a portal turn returns the PORTAL row even though an email draft is still pending", async () => {
    // Turn 1 already froze an email and the staff member has not confirmed it.
    seed({ id: "email-1", kind: "email", to_address: "chiara@example.com", subject: "Re: password" })

    // Turn 2 starts: snapshot sees the email row as pre-existing…
    const prior = await snapshotPendingPreparedIds(THREAD, ACTOR)
    expect(prior.known).toBe(true)
    expect(prior.ids.has("email-1")).toBe(true)

    // …then the portal freeze lands.
    seed({ id: "portal-1", kind: "portal", created_at: "2026-08-02T10:05:00Z", draft_locale: "it" })

    const frozen = await findPreparedFrozenThisTurn(THREAD, ACTOR, prior)
    expect(frozen?.id).toBe("portal-1")
    expect(frozen?.kind).toBe("portal")
    // A portal row carries no email fields — that is what makes an email card
    // impossible to render for it.
    expect(frozen?.to_address).toBeNull()
    expect(frozen?.subject).toBeNull()
  })

  it("an email turn returns the EMAIL row even though a portal draft is still pending", async () => {
    seed({ id: "portal-1", kind: "portal", draft_locale: "it" })

    const prior = await snapshotPendingPreparedIds(THREAD, ACTOR)
    expect(prior.ids.has("portal-1")).toBe(true)

    seed({
      id: "email-1",
      kind: "email",
      to_address: "chiara@example.com",
      subject: "Re: password",
      created_at: "2026-08-02T10:05:00Z",
    })

    const frozen = await findPreparedFrozenThisTurn(THREAD, ACTOR, prior)
    expect(frozen?.id).toBe("email-1")
    expect(frozen?.kind).toBe("email")
    expect(frozen?.to_address).toBe("chiara@example.com")
  })

  it("a turn that froze NOTHING shows no card, even with both kinds pending", async () => {
    // The staff member just asked a question. Neither pending row is theirs to
    // re-confirm, and resurfacing one as "this turn's draft" would be a card
    // they never asked for, pre-aimed at a client.
    seed({ id: "email-1", kind: "email", to_address: "chiara@example.com", subject: "s" })
    seed({ id: "portal-1", kind: "portal" })

    const prior = await snapshotPendingPreparedIds(THREAD, ACTOR)
    expect(await findPreparedFrozenThisTurn(THREAD, ACTOR, prior)).toBeNull()
  })
})
