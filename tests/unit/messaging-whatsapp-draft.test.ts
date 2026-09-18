/**
 * Tests for lib/messaging/whatsapp-draft.ts — shared draft persistence for
 * both WhatsApp composers (the new-conversation popup and the in-thread
 * reply box).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { loadWhatsAppDraft, saveWhatsAppDraft } from "@/lib/messaging/whatsapp-draft"

/**
 * This suite runs under vitest's default `node` environment, which has no
 * real `localStorage` global — stub a minimal in-memory implementation so
 * the module's real read/write/JSON logic is exercised, not just its
 * catch-and-return-empty fallback path (same pattern as
 * tests/unit/capture-recent-destinations.test.ts).
 */
function fakeLocalStorage() {
  const store = new Map<string, string>()
  return {
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    setItem: (key: string, value: string) => {
      store.set(key, value)
    },
    removeItem: (key: string) => {
      store.delete(key)
    },
    clear: () => store.clear(),
  }
}

beforeEach(() => {
  vi.stubGlobal("localStorage", fakeLocalStorage())
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe("saveWhatsAppDraft / loadWhatsAppDraft", () => {
  it("round-trips a saved draft", () => {
    saveWhatsAppDraft("reply", "group-1", "Ciao, dimmi pure")
    expect(loadWhatsAppDraft("reply", "group-1")).toBe("Ciao, dimmi pure")
  })

  it("keeps 'new' and 'reply' drafts for the same id separate", () => {
    saveWhatsAppDraft("new", "id-1", "a fresh message")
    saveWhatsAppDraft("reply", "id-1", "a reply")
    expect(loadWhatsAppDraft("new", "id-1")).toBe("a fresh message")
    expect(loadWhatsAppDraft("reply", "id-1")).toBe("a reply")
  })

  it("clears the stored draft when saved with blank text", () => {
    saveWhatsAppDraft("reply", "group-2", "something")
    saveWhatsAppDraft("reply", "group-2", "   ")
    expect(loadWhatsAppDraft("reply", "group-2")).toBe("")
  })

  it("returns empty for a conversation with no saved draft", () => {
    expect(loadWhatsAppDraft("reply", "never-saved")).toBe("")
  })

  it("expires a draft older than 7 days", () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"))
    saveWhatsAppDraft("reply", "group-3", "old draft")

    vi.setSystemTime(new Date("2026-01-09T00:00:01Z")) // just past 7 days
    expect(loadWhatsAppDraft("reply", "group-3")).toBe("")
  })

  it("still returns a draft saved just under the 7-day limit", () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"))
    saveWhatsAppDraft("reply", "group-4", "still fresh")

    vi.setSystemTime(new Date("2026-01-07T23:59:00Z"))
    expect(loadWhatsAppDraft("reply", "group-4")).toBe("still fresh")
  })
})
