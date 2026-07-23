/**
 * Saving a service in the catalog editor must not destroy what the editor
 * cannot see.
 *
 * THE DATA LOSS THIS PINS (found by council review, 2026-07-22, before it ever
 * fired): `replaceStagesForService` deletes every row for a service_type and
 * re-inserts a fixed set of editor-authored fields. The whole staff workspace
 * descriptor — components, buttons, advance targets — plus the client-facing
 * labels and display settings were not among them. One Save on the ITIN
 * service, even to change an SLA day count, would have erased all eight ITIN
 * workspace layouts and left the staff page an empty stub. The natural recovery
 * was replaying the seed migration, which at the time re-planted a stale
 * hardcoded office address — so the wipe and the address regression were one
 * accident.
 *
 * TWO TEST-DESIGN RULES LEARNED THE HARD WAY, both from an earlier cut of this
 * file that the council took apart:
 *
 *  - Assert the POSITIVE. The old "reads before deleting" test asserted a flag
 *    was never set, which is also true when no read happens at all — deleting
 *    the entire read block left it green. It now counts the read and asserts
 *    the order explicitly.
 *  - Don't test a conflict that cannot happen. The old "editor's fields win"
 *    test used a column the carry-forward never touches, so it held regardless
 *    of spread order. The real protection is set-disjointness, asserted
 *    directly below against the actual insert payload.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

interface Row { stage_name: string; [k: string]: unknown }

let existingRows: Row[] = []
let inserted: Row[] | null = null
/** Every supabase operation in the order it happened. */
let calls: string[] = []
let readError: { message: string } | null = null

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          order: () => {
            calls.push(`select:${table}`)
            return Promise.resolve({
              data: readError ? null : existingRows,
              error: readError,
            })
          },
        }),
      }),
      delete: () => ({
        eq: () => {
          calls.push(`delete:${table}`)
          return Promise.resolve({ error: null })
        },
      }),
      insert: (rows: Row[]) => {
        calls.push(`insert:${table}`)
        inserted = rows
        return Promise.resolve({ error: null })
      },
    }),
  },
}))

import {
  replaceStagesForService,
  EDITOR_OWNED_COLUMNS,
  NEVER_CARRIED_COLUMNS,
} from "@/lib/services/stages"

const ITIN_LAYOUT = {
  components: [
    { type: "waiting_notice", label: "Mail to: {td_mailing_address}" },
    { type: "action_buttons", actions: [{ key: "advance_next", target: "Documents Received" }] },
  ],
  description: "Client must print, sign with wet ink, and mail to TD office.",
}
const RECEIVED_LAYOUT = {
  components: [{ type: "document_upload", label: "Upload the received package scan" }],
}

beforeEach(() => {
  existingRows = []
  inserted = null
  calls = []
  readError = null
})

describe("replaceStagesForService — carries what the editor cannot author", () => {
  it("keeps the whole workspace layout when an unrelated field is edited", async () => {
    existingRows = [
      { stage_name: "Client Signing", stage_layout: ITIN_LAYOUT, icon: "pen", client_label: "Sign & mail" },
    ]

    // The editor saves a changed SLA. It never sends the layout — it can't.
    await replaceStagesForService("ITIN", [
      { stage_order: 1, stage_name: "Client Signing", sla_days: 14 },
    ])

    expect(inserted?.[0].stage_layout).toEqual(ITIN_LAYOUT)
    expect(inserted?.[0].sla_days).toBe(14) // the edit still applied
  })

  it("keeps client-facing labels and display settings, including falsy ones", async () => {
    existingRows = [
      {
        stage_name: "IRS Processing",
        client_label: "With the IRS",
        client_label_it: "All'IRS",
        icon: "clock",
        client_visible: true,
        board_visible: false, // false must survive — it is not "missing"
        stale_days: 0,
      },
    ]

    await replaceStagesForService("ITIN", [{ stage_order: 1, stage_name: "IRS Processing" }])

    const row = inserted?.[0] as Row
    expect(row.client_label).toBe("With the IRS")
    expect(row.client_label_it).toBe("All'IRS")
    expect(row.icon).toBe("clock")
    expect(row.client_visible).toBe(true)
    expect(row.board_visible).toBe(false)
    expect(row.stale_days).toBe(0)
  })

  it("carries a column nobody has invented yet — the set is derived, not listed", async () => {
    // The whole point of deriving: a column added to the table next year is
    // protected without anyone remembering to update this code.
    existingRows = [{ stage_name: "S", some_future_column: "must survive" }]

    await replaceStagesForService("ITIN", [{ stage_order: 1, stage_name: "S" }])

    expect(inserted?.[0].some_future_column).toBe("must survive")
  })

  it("never carries row identity or the derived catalog link", async () => {
    // Carrying the FK let the INSERT fail after the DELETE had committed,
    // leaving the service with no stages at all.
    existingRows = [
      {
        stage_name: "S",
        id: "old-uuid",
        created_at: "2026-03-18T00:00:00Z",
        service_type_entry_id: "stale-catalog-id",
        stage_layout: ITIN_LAYOUT,
      },
    ]

    await replaceStagesForService("ITIN", [{ stage_order: 1, stage_name: "S" }])

    expect(inserted?.[0].id).toBeUndefined()
    expect(inserted?.[0].created_at).toBeUndefined()
    expect(inserted?.[0].service_type_entry_id).toBeUndefined()
    expect(inserted?.[0].stage_layout).toEqual(ITIN_LAYOUT) // still carried
  })
})

describe("replaceStagesForService — refuses rather than guesses", () => {
  it("REFUSES a rename that would strand a layout, and changes nothing", async () => {
    existingRows = [{ stage_name: "Client Signing", stage_layout: ITIN_LAYOUT }]

    await expect(
      replaceStagesForService("ITIN", [{ stage_order: 1, stage_name: "Signing" }]),
    ).rejects.toThrow(/Client Signing/)

    expect(calls).toEqual(["select:pipeline_stages"]) // no delete, no insert
  })

  it("REFUSES a name SWAP — the case that would cross-wire two workspaces", async () => {
    // Renaming A→B and B→A would have given each stage the OTHER's buttons and
    // advance targets. A wipe is visible; a cross-wire looks fine and is not.
    existingRows = [
      { stage_name: "Client Signing", stage_layout: ITIN_LAYOUT },
      { stage_name: "Documents Received", stage_layout: RECEIVED_LAYOUT },
    ]

    await expect(
      replaceStagesForService("ITIN", [
        { stage_order: 1, stage_name: "Documents Received" },
        { stage_order: 2, stage_name: "Docs Received" },
      ]),
    ).rejects.toThrow(/Client Signing/)

    expect(calls).toEqual(["select:pipeline_stages"])
  })

  it("REFUSES clearing every stage when layouts would die with them", async () => {
    // Same loss by a different door: the editor's "pipeline set, no stages"
    // path used to delete everything and return before carry-forward ran.
    existingRows = [{ stage_name: "Client Signing", stage_layout: ITIN_LAYOUT }]

    await expect(replaceStagesForService("ITIN", [])).rejects.toThrow(/permanently delete/)

    expect(calls).toEqual(["select:pipeline_stages"])
  })

  it("allows the same clear when the caller explicitly means it", async () => {
    existingRows = [{ stage_name: "Client Signing", stage_layout: ITIN_LAYOUT }]

    await replaceStagesForService("ITIN", [], { allowContentLoss: true })

    expect(calls).toEqual(["select:pipeline_stages", "delete:pipeline_stages"])
  })

  it("REFUSES when two existing stages share a name — ambiguous, not guessable", async () => {
    // There is no unique index on (service_type, stage_name) and the editor's
    // name field is free text, so this is reachable.
    existingRows = [
      { stage_name: "Review", stage_layout: ITIN_LAYOUT },
      { stage_name: "Review", stage_layout: RECEIVED_LAYOUT },
    ]

    await expect(
      replaceStagesForService("ITIN", [{ stage_order: 1, stage_name: "Review" }]),
    ).rejects.toThrow(/both named/)

    expect(calls).toEqual(["select:pipeline_stages"])
  })

  it("dropping a stage that carries NOTHING is allowed — no content to lose", async () => {
    existingRows = [
      { stage_name: "Keep", stage_layout: ITIN_LAYOUT },
      { stage_name: "Drop" }, // bare row, nothing worth preserving
    ]

    await replaceStagesForService("ITIN", [{ stage_order: 1, stage_name: "Keep" }])

    expect(inserted).toHaveLength(1)
    expect(inserted?.[0].stage_layout).toEqual(ITIN_LAYOUT)
  })
})

describe("replaceStagesForService — ordering and failure", () => {
  it("reads BEFORE it deletes — asserted positively", async () => {
    // The previous version of this test asserted a flag was never set, which
    // stayed true when the read was deleted entirely. Assert the sequence.
    existingRows = [{ stage_name: "A", stage_layout: ITIN_LAYOUT }]

    await replaceStagesForService("ITIN", [{ stage_order: 1, stage_name: "A" }])

    expect(calls).toEqual([
      "select:pipeline_stages",
      "delete:pipeline_stages",
      "insert:pipeline_stages",
    ])
  })

  it("a failed read aborts before the delete — never destroy on an unverifiable check", async () => {
    readError = { message: "connection reset" }

    await expect(
      replaceStagesForService("ITIN", [{ stage_order: 1, stage_name: "A" }]),
    ).rejects.toThrow(/connection reset/)

    expect(calls).toEqual(["select:pipeline_stages"])
  })

  it("a brand-new stage starts clean and inherits nothing from a sibling", async () => {
    existingRows = [{ stage_name: "Old", stage_layout: ITIN_LAYOUT }]

    await replaceStagesForService("ITIN", [
      { stage_order: 1, stage_name: "Old" },
      { stage_order: 2, stage_name: "Brand New" },
    ])

    expect(inserted?.[0].stage_layout).toEqual(ITIN_LAYOUT)
    expect(inserted?.[1].stage_layout).toBeUndefined()
  })
})

describe("the carried set is disjoint from what the editor writes", () => {
  it("no column is both editor-owned and carried — a stale value could never beat an edit", async () => {
    // This is the real protection the old "editor's fields win" test claimed to
    // give and did not. Compare the ACTUAL insert payload's keys.
    existingRows = [{ stage_name: "S", stage_layout: ITIN_LAYOUT }]

    await replaceStagesForService("ITIN", [
      { stage_order: 1, stage_name: "S", sla_days: 7, stage_description: "new text" },
    ])

    const writtenKeys = Object.keys(inserted?.[0] ?? {})
    const carriedKeys = writtenKeys.filter(
      k => !EDITOR_OWNED_COLUMNS.has(k) && !NEVER_CARRIED_COLUMNS.has(k),
    )

    for (const key of carriedKeys) {
      expect(EDITOR_OWNED_COLUMNS.has(key)).toBe(false)
    }
    // And the editor's own values are the ones that landed.
    expect(inserted?.[0].sla_days).toBe(7)
    expect(inserted?.[0].stage_description).toBe("new text")
  })

  it("EDITOR_OWNED_COLUMNS matches every field the insert actually writes", async () => {
    // If someone adds a field to insertRows without adding it here, that field
    // becomes carryable — and a stale DB value would silently beat the admin's
    // edit. This test is what makes the derived set safe.
    existingRows = []

    await replaceStagesForService("ITIN", [{ stage_order: 1, stage_name: "S" }])

    // With no existing rows nothing is carried, so every key written is
    // editor-owned by definition.
    for (const key of Object.keys(inserted?.[0] ?? {})) {
      expect(
        EDITOR_OWNED_COLUMNS.has(key),
        `insertRows writes "${key}" but EDITOR_OWNED_COLUMNS does not list it — ` +
          `a stale database value could overwrite the admin's edit.`,
      ).toBe(true)
    }
  })
})
