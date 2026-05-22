/**
 * Unit tests for the pure core of the Notification Center act-event helper
 * (lib/notifications/act-event.ts). DB I/O (`emitActionNeeded`) is covered by
 * sandbox/route QA; here we test the pure decisions: column selection, scope
 * routing (ITIN stays on the contact), owner fallback, and validation.
 *
 * sysdoc notification-center-plan / dev_task 529b26cc.
 */

import { describe, it, expect } from "vitest"
import {
  pickInitialColumn,
  resolveActionCard,
  type BoardColumn,
  type ActionEventMeta,
} from "@/lib/notifications/act-event"

const COLUMNS: BoardColumn[] = [
  { slug: "action_needed", order: 10 },
  { slug: "in_progress", order: 20 },
  { slug: "waiting_on_client", order: 30 },
  { slug: "wait_for_irs", order: 40 },
  { slug: "done", order: 50, terminal: true },
]

describe("pickInitialColumn", () => {
  it("returns the lowest-order non-terminal column", () => {
    expect(pickInitialColumn(COLUMNS)).toBe("action_needed")
  })

  it("ignores the terminal column even if it has the lowest order", () => {
    expect(
      pickInitialColumn([
        { slug: "done", order: 1, terminal: true },
        { slug: "triage", order: 5 },
      ]),
    ).toBe("triage")
  })

  it("respects re-ordering (not hardcoded to action_needed)", () => {
    expect(
      pickInitialColumn([
        { slug: "new_intake", order: 5 },
        { slug: "action_needed", order: 10 },
      ]),
    ).toBe("new_intake")
  })

  it("falls back to action_needed when there are no usable columns", () => {
    expect(pickInitialColumn([])).toBe("action_needed")
    expect(pickInitialColumn([{ slug: "done", order: 1, terminal: true }])).toBe("action_needed")
  })
})

describe("resolveActionCard", () => {
  const contactMeta: ActionEventMeta = { next_step: "Review W-7", scope: "contact", default_assignee: "Luca" }
  const accountMeta: ActionEventMeta = { next_step: "Send to India", scope: "account", default_assignee: "Luca" }

  it("rejects an unknown event (meta null)", () => {
    const r = resolveActionCard({
      meta: null,
      initialColumn: "action_needed",
      contact_id: "c1",
      source_ref: "x:1",
      fallbackAssignee: "Luca",
    })
    expect(r.card).toBeNull()
    expect(r.reason).toBe("unknown_event")
  })

  it("contact-scoped event lands on the contact and FORCES account_id null even if an account is passed (ITIN rule)", () => {
    const r = resolveActionCard({
      meta: contactMeta,
      initialColumn: "action_needed",
      contact_id: "c1",
      account_id: "a1",
      source_ref: "itin_submission:1",
      fallbackAssignee: "Luca",
    })
    expect(r.card).not.toBeNull()
    expect(r.card?.contact_id).toBe("c1")
    expect(r.card?.account_id).toBeNull()
    expect(r.card?.action_type).toBe("action_needed")
    expect(r.card?.label).toBe("Review W-7")
    expect(r.card?.assigned_to).toBe("Luca")
    expect(r.card?.source_ref).toBe("itin_submission:1")
    expect(r.card?.message_id).toBeNull()
  })

  it("contact-scoped event without a contact_id is rejected", () => {
    const r = resolveActionCard({
      meta: contactMeta,
      initialColumn: "action_needed",
      account_id: "a1",
      source_ref: "x:2",
      fallbackAssignee: "Luca",
    })
    expect(r.card).toBeNull()
    expect(r.reason).toBe("missing_scope_id")
  })

  it("account-scoped event lands on the account and keeps the contact for linking", () => {
    const r = resolveActionCard({
      meta: accountMeta,
      initialColumn: "action_needed",
      contact_id: "c9",
      account_id: "a9",
      source_ref: "tr:9",
      fallbackAssignee: "Luca",
    })
    expect(r.card).not.toBeNull()
    expect(r.card?.account_id).toBe("a9")
    expect(r.card?.contact_id).toBe("c9")
  })

  it("account-scoped event without an account_id is rejected", () => {
    const r = resolveActionCard({
      meta: accountMeta,
      initialColumn: "action_needed",
      contact_id: "c9",
      source_ref: "x:3",
      fallbackAssignee: "Luca",
    })
    expect(r.card).toBeNull()
    expect(r.reason).toBe("missing_scope_id")
  })

  it("uses the fallback assignee when the event meta has no default_assignee", () => {
    const r = resolveActionCard({
      meta: { next_step: "Do thing", scope: "account" },
      initialColumn: "action_needed",
      account_id: "a1",
      source_ref: "x:4",
      fallbackAssignee: "Marco",
    })
    expect(r.card?.assigned_to).toBe("Marco")
  })

  it("uses the catalog assignee over the fallback when present", () => {
    const r = resolveActionCard({
      meta: { next_step: "Review tax data", scope: "account", default_assignee: "Antonio" },
      initialColumn: "action_needed",
      account_id: "a1",
      source_ref: "x:5",
      fallbackAssignee: "Luca",
    })
    expect(r.card?.assigned_to).toBe("Antonio")
  })
})
