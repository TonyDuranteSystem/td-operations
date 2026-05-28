/**
 * Portal Chats conversation-list ordering (lib/portal-chats/sort-threads).
 *
 * Behavior (confirmed with Antonio 2026-05-28):
 *  - A thread with an unhandled "What's New" item pins to the TOP, like a new
 *    message — and stays pinned until "Mark handled" (count → 0), NOT on read.
 *  - Unread client messages also pin to the top (unchanged).
 *  - Non-pinned threads sort newest-first; pinned threads sort newest-first
 *    among themselves.
 */

import { describe, it, expect } from "vitest"
import {
  sortPortalThreads,
  whatsNewCountForThread,
  threadNeedsAttention,
  type SortableThread,
  type WhatsNewCounts,
} from "@/lib/portal-chats/sort-threads"

const t = (
  id: string,
  last_message_at: string,
  unread_count = 0,
  kind: "account" | "contact" = "account"
): SortableThread & { id: string } => ({
  id,
  account_id: kind === "account" ? id : null,
  contact_id: kind === "contact" ? id : null,
  unread_count,
  last_message_at,
})

describe("whatsNewCountForThread", () => {
  it("resolves account-level then contact-level", () => {
    const counts: WhatsNewCounts = { by_account: { A: 3 }, by_contact: { C: 5 } }
    expect(whatsNewCountForThread({ account_id: "A", contact_id: null }, counts)).toBe(3)
    expect(whatsNewCountForThread({ account_id: null, contact_id: "C" }, counts)).toBe(5)
    expect(whatsNewCountForThread({ account_id: "X", contact_id: null }, counts)).toBe(0)
    expect(whatsNewCountForThread({ account_id: "A", contact_id: null }, null)).toBe(0)
  })
})

describe("threadNeedsAttention", () => {
  it("is true for unread messages OR unhandled What's New", () => {
    expect(threadNeedsAttention(t("A", "2026-01-01", 2))).toBe(true)
    expect(threadNeedsAttention(t("A", "2026-01-01", 0), { by_account: { A: 1 } })).toBe(true)
    expect(threadNeedsAttention(t("A", "2026-01-01", 0), { by_account: { A: 0 } })).toBe(false)
    expect(threadNeedsAttention(t("A", "2026-01-01", 0))).toBe(false)
  })
})

describe("sortPortalThreads", () => {
  it("pins a thread with an unhandled What's New item above newer, calm threads", () => {
    const older = t("WN", "2026-01-01T10:00:00Z", 0) // has What's New, older message
    const newer = t("CALM", "2026-05-01T10:00:00Z", 0) // newer, nothing pending
    const counts: WhatsNewCounts = { by_account: { WN: 1 } }
    const sorted = sortPortalThreads([newer, older], counts)
    expect(sorted.map((x) => (x as { id: string }).id)).toEqual(["WN", "CALM"])
  })

  it("drops a thread back to time-order once its What's New is handled (count 0)", () => {
    const wasFlagged = t("WN", "2026-01-01T10:00:00Z", 0)
    const newer = t("CALM", "2026-05-01T10:00:00Z", 0)
    const counts: WhatsNewCounts = { by_account: { WN: 0 } } // handled → 0
    const sorted = sortPortalThreads([wasFlagged, newer], counts)
    expect(sorted.map((x) => (x as { id: string }).id)).toEqual(["CALM", "WN"])
  })

  it("keeps unread messages pinning to the top (unchanged behavior)", () => {
    const unread = t("UNREAD", "2026-01-01T10:00:00Z", 4)
    const newer = t("CALM", "2026-05-01T10:00:00Z", 0)
    const sorted = sortPortalThreads([newer, unread])
    expect(sorted.map((x) => (x as { id: string }).id)).toEqual(["UNREAD", "CALM"])
  })

  it("within the pinned group, sorts newest-first", () => {
    const wnOld = t("WN_OLD", "2026-01-01T10:00:00Z", 0)
    const wnNew = t("WN_NEW", "2026-03-01T10:00:00Z", 0)
    const counts: WhatsNewCounts = { by_account: { WN_OLD: 1, WN_NEW: 2 } }
    const sorted = sortPortalThreads([wnOld, wnNew], counts)
    expect(sorted.map((x) => (x as { id: string }).id)).toEqual(["WN_NEW", "WN_OLD"])
  })

  it("does not mutate the input array", () => {
    const input = [t("A", "2026-01-01T10:00:00Z"), t("B", "2026-05-01T10:00:00Z")]
    const before = input.map((x) => (x as { id: string }).id)
    sortPortalThreads(input)
    expect(input.map((x) => (x as { id: string }).id)).toEqual(before)
  })
})

describe("sortPortalThreads — manual conversation pin (above everything)", () => {
  it("puts a pinned conversation above unread and What's New", () => {
    const pinned = { ...t("PIN", "2026-01-01T10:00:00Z", 0), is_pinned: true } // old, but pinned
    const unread = t("UNREAD", "2026-05-01T10:00:00Z", 5) // newer + unread
    const wn = t("WN", "2026-04-01T10:00:00Z", 0)
    const counts: WhatsNewCounts = { by_account: { WN: 2 } }
    const sorted = sortPortalThreads([unread, wn, pinned], counts)
    expect(sorted.map((x) => (x as { id: string }).id)).toEqual(["PIN", "UNREAD", "WN"])
  })

  it("sorts multiple pinned conversations newest-first among themselves", () => {
    const pinOld = { ...t("PIN_OLD", "2026-01-01T10:00:00Z"), is_pinned: true }
    const pinNew = { ...t("PIN_NEW", "2026-03-01T10:00:00Z"), is_pinned: true }
    const sorted = sortPortalThreads([pinOld, pinNew])
    expect(sorted.map((x) => (x as { id: string }).id)).toEqual(["PIN_NEW", "PIN_OLD"])
  })
})
