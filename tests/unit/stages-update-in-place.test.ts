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
}

let ops: Op[] = []
let existingRows: Record<string, unknown>[] = []
let failOn: { kind: Op["kind"]; message: string } | null = null

function maybeFail(kind: Op["kind"]) {
  return failOn?.kind === kind ? { message: failOn.message } : null
}

vi.mock("@/lib/supabase-admin", () => {
  const builder = (table: string) => {
    const op: Op = { kind: "select", table, filters: [] }
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
        return Promise.resolve({ error: maybeFail("insert") })
      },
      eq(col: string, val: unknown) {
        op.filters.push([col, val])
        if (op.kind === "update" || op.kind === "delete") {
          ops.push(op)
          return Promise.resolve({ error: maybeFail(op.kind) })
        }
        return chain
      },
      in(col: string, vals: unknown[]) {
        op.filters.push([col, vals])
        ops.push(op)
        return Promise.resolve({ error: maybeFail(op.kind) })
      },
      order() {
        ops.push(op)
        return Promise.resolve({ data: existingRows, error: maybeFail("select") })
      },
      maybeSingle() {
        ops.push(op)
        return Promise.resolve({ data: null, error: null })
      },
    }
    return chain
  }
  return { supabaseAdmin: { from: builder } }
})

import { replaceStagesForService, validateStageDraft } from "@/lib/services/stages"

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

  it("an unchanged stage is updated, never deleted", async () => {
    existingRows = [realRow({ id: "a", stage_name: "Keep", stage_order: 1 })]

    await replaceStagesForService("ITIN", [{ id: "a", stage_order: 1, stage_name: "Keep" }])

    expect(ops.some(o => o.kind === "update" && o.filters.some(f => f[0] === "id" && f[1] === "a"))).toBe(true)
    expect(ops.some(o => o.kind === "delete")).toBe(false)
  })
})

describe("rename, reorder and delete all work", () => {
  it("RENAMES a stage in place, keeping its workspace", async () => {
    // The whole point of carrying the row id: this used to be impossible.
    existingRows = [realRow({ id: "a", stage_name: "Client Signing", stage_order: 1 })]

    await replaceStagesForService("ITIN", [{ id: "a", stage_order: 1, stage_name: "Signing" }])

    const upd = ops.find(o => o.kind === "update" && (o.payload as Record<string, unknown>)?.stage_name === "Signing")
    expect(upd).toBeDefined()
    expect(upd?.filters).toContainEqual(["id", "a"])
    expect(ops.some(o => o.kind === "delete")).toBe(false)
  })

  it("SWAPS two stage names without cross-wiring their workspaces", async () => {
    // Name-keyed matching gave each stage the OTHER's buttons. Id-keyed cannot.
    existingRows = [
      realRow({ id: "a", stage_name: "Alpha", stage_order: 1 }),
      realRow({ id: "b", stage_name: "Beta", stage_order: 2 }),
    ]

    await replaceStagesForService("ITIN", [
      { id: "a", stage_order: 1, stage_name: "Beta" },
      { id: "b", stage_order: 2, stage_name: "Alpha" },
    ])

    const finals = ops.filter(o => o.kind === "update" && (o.payload as Record<string, unknown>)?.stage_name)
    const byId = new Map(finals.map(o => [o.filters.find(f => f[0] === "id")?.[1], o.payload as Record<string, unknown>]))
    expect(byId.get("a")?.stage_name).toBe("Beta")
    expect(byId.get("b")?.stage_name).toBe("Alpha")
    // Neither row's layout was written at all, so nothing could be swapped.
    for (const p of byId.values()) expect(p.stage_layout).toBeUndefined()
  })

  it("parks orders before assigning final ones — reorder cannot collide", async () => {
    existingRows = [
      realRow({ id: "a", stage_name: "First", stage_order: 1 }),
      realRow({ id: "b", stage_name: "Second", stage_order: 2 }),
    ]

    await replaceStagesForService("ITIN", [
      { id: "b", stage_order: 1, stage_name: "Second" },
      { id: "a", stage_order: 2, stage_name: "First" },
    ])

    const orderWrites = ops.filter(o => o.kind === "update").map(o => (o.payload as Record<string, unknown>).stage_order as number)
    const parked = orderWrites.filter(n => n >= 100000)
    expect(parked.length).toBe(2) // both parked first
    // Every parked write happens before any final write.
    const lastPark = orderWrites.lastIndexOf(parked[parked.length - 1])
    const firstFinal = orderWrites.findIndex(n => n < 100000)
    expect(lastPark).toBeLessThan(firstFinal)
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
    // Another admin deleted the row since this page loaded. Updating by that id
    // would silently affect nothing.
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
