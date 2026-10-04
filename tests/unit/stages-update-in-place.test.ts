/**
 * Saving a service must not touch anything the editor does not author.
 *
 * THE BUG (production, months, never fired — admin-only page): the save deleted
 * every row for the service and re-inserted only the nine editor columns. The
 * row has twenty-three. The whole staff workspace descriptor — components,
 * buttons, advance targets — plus the client-facing labels and display settings
 * were destroyed on every Save.
 *
 * WHY THIS FILE IS SHAPED THE WAY IT IS. An earlier attempt at this fix shipped
 * fifteen green tests over six blockers, because the mock ignored WHICH columns
 * a statement named and WHICH rows it filtered on. Reverting the fix left every
 * test passing. So this mock records each operation's table, filter and payload,
 * and the assertions are about the STATEMENTS ISSUED, not just the end state:
 *
 *   - `never deletes by service_type` and `an unchanged stage is updated, never
 *     deleted` are the tests that actually catch a revert to the old shape.
 *   - `never names a column the editor does not own` does NOT catch that revert,
 *     and an earlier version of this comment wrongly claimed it did. The old
 *     code named exactly the same nine columns; the damage was in the fourteen
 *     it OMITTED, and an assertion that inspects the keys present is blind to a
 *     missing one. It is still worth keeping — it catches someone ADDING a
 *     non-editor column to a write — but it is not the revert-catcher.
 *
 * Fixtures carry the NOT NULL columns (client_visible, board_visible) that every
 * real row has. The previous suite used a bare fixture the database can never
 * return, and that impossible row was what made a broken guard look correct.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

interface Op {
  kind: "select" | "update" | "delete" | "insert"
  table: string
  filters: Array<[string, unknown]>
  payload?: Record<string, unknown> | Record<string, unknown>[]
  /** Request headers set on the write — the who-stamp for the service settings history (N1a P2). */
  headers?: Record<string, string>
}

let ops: Op[] = []
let existingRows: Record<string, unknown>[] = []
let failOn: { kind: Op["kind"]; message: string } | null = null
/** What a .maybeSingle() read returns (updateOneStage reads the step's service first). */
let singleRow: Record<string, unknown> | null = null

function maybeFail(kind: Op["kind"]) {
  return failOn?.kind === kind ? { message: failOn.message } : null
}

vi.mock("@/lib/supabase-admin", () => {
  const builder = (table: string) => {
    const op: Op = { kind: "select", table, filters: [] }
    // A finished write: awaitable, and still accepts .setHeader() like the real query builder.
    const done = (result: { error: unknown }) => {
      const t: Record<string, unknown> = {
        then: (a: (v: unknown) => unknown, b?: (e: unknown) => unknown) => Promise.resolve(result).then(a, b),
        setHeader(name: string, value: string) {
          op.headers = { ...(op.headers ?? {}), [name]: value }
          return t
        },
      }
      return t
    }
    const chain: Record<string, unknown> = {
      select(cols?: string) {
        op.kind = "select"
        op.payload = { columns: cols }
        return chain
      },
      update(payload: Record<string, unknown>) {
        op.kind = "update"
        op.payload = payload
        return chain
      },
      delete() {
        op.kind = "delete"
        return chain
      },
      insert(rows: Record<string, unknown>[]) {
        op.kind = "insert"
        op.payload = rows
        ops.push(op)
        return done({ error: maybeFail("insert") })
      },
      eq(col: string, val: unknown) {
        op.filters.push([col, val])
        if (op.kind === "update" || op.kind === "delete") {
          ops.push(op)
          return done({ error: maybeFail(op.kind) })
        }
        return chain
      },
      in(col: string, vals: unknown[]) {
        op.filters.push([col, vals])
        ops.push(op)
        return done({ error: maybeFail(op.kind) })
      },
      order() {
        ops.push(op)
        return Promise.resolve({ data: existingRows, error: maybeFail("select") })
      },
      maybeSingle() {
        ops.push(op)
        return Promise.resolve({ data: singleRow, error: null })
      },
    }
    return chain
  }
  return { supabaseAdmin: { from: builder } }
})

import { replaceStagesForService, updateOneStage, validateStageDraft } from "@/lib/services/stages"
import { SETTINGS_ACTOR_HEADER } from "@/lib/services/settings-actor"

/** Columns the editor authors. Anything else must never appear in a statement. */
const EDITOR_COLUMNS = new Set([
  "service_type",
  "stage_order",
  "stage_name",
  "stage_description",
  "sla_days",
  "auto_advance",
  "notify_client_email",
  "client_description",
  "requires_approval",
  "auto_actions",
])

/** A realistic row: the NOT NULL columns are always present. */
function realRow(over: Record<string, unknown>) {
  return {
    client_visible: true,
    board_visible: true,
    stage_layout: { components: [{ type: "waiting_notice", label: "Mail to: {td_mailing_address}" }] },
    client_label: "Sign & mail",
    ...over,
  }
}

beforeEach(() => {
  ops = []
  existingRows = []
  failOn = null
  singleRow = null
})

describe("the columns the editor does not own are never touched", () => {
  it("no statement names a non-editor column — the test that catches a revert", async () => {
    existingRows = [
      realRow({ id: "a", stage_name: "Client Signing", stage_order: 1 }),
      realRow({ id: "b", stage_name: "Documents Received", stage_order: 2 }),
    ]

    await replaceStagesForService("ITIN", [
      { id: "a", stage_order: 1, stage_name: "Client Signing", sla_days: 14 },
      { id: "b", stage_order: 2, stage_name: "Documents Received" },
    ])

    const written = ops.filter(o => o.kind === "update" || o.kind === "insert")
    expect(written.length).toBeGreaterThan(0)
    for (const op of written) {
      const rows = Array.isArray(op.payload) ? op.payload : [op.payload ?? {}]
      for (const row of rows) {
        for (const col of Object.keys(row)) {
          expect(
            EDITOR_COLUMNS.has(col),
            `a ${op.kind} names "${col}", which the editor does not author — ` +
              `writing it means a Save can change or erase it`,
          ).toBe(true)
        }
      }
    }
  })

  it("never deletes by service_type — that wholesale delete WAS the bug", async () => {
    existingRows = [realRow({ id: "a", stage_name: "Keep", stage_order: 1 })]

    await replaceStagesForService("ITIN", [{ id: "a", stage_order: 1, stage_name: "Keep" }])

    const deletes = ops.filter(o => o.kind === "delete")
    for (const d of deletes) {
      expect(d.filters.map(f => f[0])).not.toContain("service_type")
    }
  })

  it("an unchanged stage is neither rewritten nor deleted (N1a P2: only real changes are written)", async () => {
    existingRows = [realRow({ id: "a", stage_name: "Keep", stage_order: 1 })]

    await replaceStagesForService("ITIN", [{ id: "a", stage_order: 1, stage_name: "Keep" }])

    expect(ops.some(o => o.kind === "update")).toBe(false)
    expect(ops.some(o => o.kind === "delete")).toBe(false)
  })

  it("an edited stage is updated in place, by id", async () => {
    existingRows = [realRow({ id: "a", stage_name: "Keep", stage_order: 1 })]

    await replaceStagesForService("ITIN", [{ id: "a", stage_order: 1, stage_name: "Keep", sla_days: 3 }])

    expect(ops.some(o => o.kind === "update" && o.filters.some(f => f[0] === "id" && f[1] === "a"))).toBe(true)
  })
})

describe("the unsafe capabilities are refused, not silently mishandled", () => {
  it("REFUSES renaming a stage the CODE matches literally", async () => {
    // "Client Signing" is how a client's ITIN documents are found for the
    // portal. Renaming it would break that silently, so it is declared pinned
    // and the editor refuses — with the reason, not just a refusal.
    existingRows = [realRow({ id: "a", stage_name: "Client Signing", stage_order: 1 })]

    await expect(
      replaceStagesForService("ITIN", [{ id: "a", stage_order: 1, stage_name: "Signing" }]),
    ).rejects.toThrow(/cannot be renamed/)

    expect(ops.filter(o => o.kind !== "select")).toEqual([]) // nothing written
  })

  it("REFUSES a reorder — deliveries hold their own copy of the step number", async () => {
    existingRows = [
      realRow({ id: "a", stage_name: "Alpha", stage_order: 1 }),
      realRow({ id: "b", stage_name: "Beta", stage_order: 2 }),
    ]

    await expect(
      replaceStagesForService("ITIN", [
        { id: "b", stage_order: 1, stage_name: "Beta" },
        { id: "a", stage_order: 2, stage_name: "Alpha" },
      ]),
    ).rejects.toThrow(/order of steps is not available/i)

    expect(ops.filter(o => o.kind !== "select")).toEqual([])
  })

  it("REFUSES clearing every step of a pipeline that has some", async () => {
    existingRows = [
      realRow({ id: "a", stage_name: "Keep", stage_order: 1 }),
      realRow({ id: "b", stage_name: "Also", stage_order: 2 }),
    ]

    await expect(replaceStagesForService("ITIN", [])).rejects.toThrow(/would remove all 2 steps/)

    expect(ops.filter(o => o.kind !== "select")).toEqual([])
  })

  it("still allows what IS safe: editing a step's own fields", async () => {
    existingRows = [realRow({ id: "a", stage_name: "Keep", stage_order: 1 })]

    await replaceStagesForService("ITIN", [
      { id: "a", stage_order: 1, stage_name: "Keep", sla_days: 14 },
    ])

    const upd = ops.find(o => o.kind === "update")
    expect((upd?.payload as Record<string, unknown>)?.sla_days).toBe(14)
    expect(ops.some(o => o.kind === "delete")).toBe(false)
  })

  it("deletes only the removed stage, by id", async () => {
    existingRows = [
      realRow({ id: "a", stage_name: "Keep", stage_order: 1 }),
      realRow({ id: "b", stage_name: "Remove", stage_order: 2 }),
    ]

    await replaceStagesForService("ITIN", [{ id: "a", stage_order: 1, stage_name: "Keep" }])

    const del = ops.find(o => o.kind === "delete")
    expect(del?.filters).toContainEqual(["id", ["b"]])
  })

  it("inserts a genuinely new stage and updates the existing one", async () => {
    existingRows = [realRow({ id: "a", stage_name: "Old", stage_order: 1 })]

    await replaceStagesForService("ITIN", [
      { id: "a", stage_order: 1, stage_name: "Old" },
      { stage_order: 2, stage_name: "Brand New" },
    ])

    const ins = ops.find(o => o.kind === "insert")
    const rows = ins?.payload as Record<string, unknown>[]
    expect(rows).toHaveLength(1)
    expect(rows[0].stage_name).toBe("Brand New")
    expect(rows[0].stage_layout).toBeUndefined()
  })

  it("treats a submitted id that no longer exists as a new stage", async () => {
    existingRows = []

    await replaceStagesForService("ITIN", [{ id: "ghost", stage_order: 1, stage_name: "S" }])

    expect(ops.some(o => o.kind === "insert")).toBe(true)
    expect(ops.some(o => o.kind === "update")).toBe(false)
  })
})

describe("bad drafts are refused before anything is written", () => {
  it("rejects a blank stage name — Add Stage seeds one", async () => {
    existingRows = [realRow({ id: "a", stage_name: "Real", stage_order: 1 })]

    await expect(
      replaceStagesForService("ITIN", [
        { id: "a", stage_order: 1, stage_name: "Real" },
        { stage_order: 2, stage_name: "" },
      ]),
    ).rejects.toThrow(/no name/)

    expect(ops).toEqual([]) // not even a read
  })

  it("rejects duplicate stage names, ignoring case and padding", async () => {
    await expect(
      replaceStagesForService("ITIN", [
        { stage_order: 1, stage_name: "Review" },
        { stage_order: 2, stage_name: " review " },
      ]),
    ).rejects.toThrow(/both called/)

    expect(ops).toEqual([])
  })

  it("validateStageDraft passes a clean draft", () => {
    expect(validateStageDraft([
      { stage_order: 1, stage_name: "A" },
      { stage_order: 2, stage_name: "B" },
    ])).toBeNull()
  })
})

describe("failure part-way through never empties the pipeline", () => {
  it("a failed read stops before any write", async () => {
    failOn = { kind: "select", message: "connection reset" }
    existingRows = []

    await expect(
      replaceStagesForService("ITIN", [{ stage_order: 1, stage_name: "S" }]),
    ).rejects.toThrow(/connection reset/)

    expect(ops.filter(o => o.kind !== "select")).toEqual([])
  })

  it("a failed insert leaves the surviving stages in place", async () => {
    // The old shape deleted everything first, so this left an EMPTY pipeline —
    // and the admin's natural retry then wiped the layouts for good.
    existingRows = [realRow({ id: "a", stage_name: "Keep", stage_order: 1 })]
    failOn = { kind: "insert", message: "statement timeout" }

    await expect(
      replaceStagesForService("ITIN", [
        { id: "a", stage_order: 1, stage_name: "Keep" },
        { stage_order: 2, stage_name: "New" },
      ]),
    ).rejects.toThrow(/statement timeout/)

    // The existing row was never deleted, so nothing was lost.
    const deletes = ops.filter(o => o.kind === "delete")
    expect(deletes).toEqual([])
  })
})

describe("N1a P2 — one recorded door for step changes", () => {
  it("stamps EVERY write (park, delete, update, insert) with who made it", async () => {
    existingRows = [
      realRow({ id: "a", stage_name: "Keep", stage_order: 1 }),
      realRow({ id: "b", stage_name: "Drop me", stage_order: 2 }),
    ]
    await replaceStagesForService(
      "Shipping",
      [
        { id: "a", stage_order: 1, stage_name: "Keep" },
        { stage_order: 3, stage_name: "New step" },
      ],
      { actor: "luca@tonydurante.us" },
    )
    const writes = ops.filter(o => o.kind !== "select")
    expect(writes.map(w => w.kind)).toEqual(expect.arrayContaining(["update", "delete", "insert"]))
    for (const w of writes) expect(w.headers?.[SETTINGS_ACTOR_HEADER]).toBe("luca@tonydurante.us")
  })

  it("an unnamed caller is still stamped, never blank", async () => {
    existingRows = [realRow({ id: "a", stage_name: "Keep", stage_order: 1 })]
    await replaceStagesForService("Shipping", [{ id: "a", stage_order: 1, stage_name: "Keep", sla_days: 2 }])
    const upd = ops.find(o => o.kind === "update")!
    expect(upd.headers?.[SETTINGS_ACTOR_HEADER]).toBe("app:service-editor")
  })

  it("'needs approval' is kept when the caller never loaded it, written when it did, false for a new step", async () => {
    existingRows = [
      realRow({ id: "a", stage_name: "A", stage_order: 1 }),
      realRow({ id: "b", stage_name: "B", stage_order: 2 }),
    ]
    await replaceStagesForService("Shipping", [
      { id: "a", stage_order: 1, stage_name: "A", sla_days: 6 },
      { id: "b", stage_order: 2, stage_name: "B", requires_approval: true },
      { stage_order: 3, stage_name: "C" },
    ])
    // The real field update, not the temporary park renumbering that runs first when a step is added.
    const realUpdate = (id: string) =>
      ops.find(o => o.kind === "update" && o.filters.some(f => f[1] === id) && "stage_name" in (o.payload ?? {}))!
    const updA = realUpdate("a")
    const updB = realUpdate("b")
    const ins = ops.find(o => o.kind === "insert")!
    expect(updA.payload).not.toHaveProperty("requires_approval")
    expect(updB.payload).toMatchObject({ requires_approval: true })
    expect((ins.payload as Record<string, unknown>[])[0]).toMatchObject({ requires_approval: false })
  })

  it("the /config single-step edit changes only that step, through the same save, stamped with the admin", async () => {
    singleRow = { service_type: "Shipping" }
    existingRows = [
      realRow({ id: "a", stage_name: "Preparing", stage_order: 1, sla_days: 2 }),
      realRow({ id: "b", stage_name: "Shipped", stage_order: 2, sla_days: 5 }),
    ]
    const res = await updateOneStage("b", { sla_days: 9 }, "antonio.durante@tonydurante.us")
    expect(res.serviceType).toBe("Shipping")
    const updA = ops.find(o => o.kind === "update" && o.filters.some(f => f[1] === "a"))
    const updB = ops.find(o => o.kind === "update" && o.filters.some(f => f[1] === "b"))!
    // The other step is not re-saved: an edit to step b can never put back an old value on step a.
    expect(updA).toBeUndefined()
    expect(updB.payload).toMatchObject({ stage_name: "Shipped", sla_days: 9 })
    expect(updB.headers?.[SETTINGS_ACTOR_HEADER]).toBe("antonio.durante@tonydurante.us")
    expect(ops.some(o => o.kind === "delete" || o.kind === "insert")).toBe(false)
  })

  it("the /config single-step edit gets the guards: a code-matched step can't be renamed from there either", async () => {
    singleRow = { service_type: "ITIN" }
    existingRows = [realRow({ id: "a", stage_name: "Client Signing", stage_order: 1 })]
    await expect(updateOneStage("a", { stage_name: "Signing" }, "x@y.com")).rejects.toThrow(/cannot be renamed/)
    expect(ops.some(o => o.kind === "update")).toBe(false)
  })

  it("a step deleted meanwhile is refused with a plain message", async () => {
    singleRow = null
    await expect(updateOneStage("gone", { sla_days: 1 }, "x@y.com")).rejects.toThrow(/no longer exists/)
  })
})

describe("stepPatchChanges — only real changes are written", () => {
  it("treats the editor's 'unset' spellings as no change", async () => {
    const { stepPatchChanges } = await import("@/lib/services/stages")
    expect(stepPatchChanges(
      { stage_name: "A", auto_advance: null, requires_approval: null, auto_actions: null, stage_description: null },
      { stage_name: "A", auto_advance: false, requires_approval: false, auto_actions: [], stage_description: "" },
    )).toBe(false)
  })
  it("sees a real change", async () => {
    const { stepPatchChanges } = await import("@/lib/services/stages")
    expect(stepPatchChanges({ sla_days: 3 }, { sla_days: 4 })).toBe(true)
    expect(stepPatchChanges({ auto_advance: false }, { auto_advance: true })).toBe(true)
    expect(stepPatchChanges({ auto_actions: null }, { auto_actions: [{ type: "second_installment_target" }] })).toBe(true)
  })
})
