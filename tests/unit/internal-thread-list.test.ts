import { describe, it, expect } from "vitest"
import { shapeThread, sortThreads, isMissingFunction } from "@/lib/internal/thread-list"

const base = { id: "t1", title: "Some title", created_at: "2026-09-01T10:00:00+00:00", account_id: null, contact_id: null }

describe("shaping a thread row exactly as the old per-thread route did", () => {
  it("the name is account, else contact, else the thread's title, else 'Team Thread'", () => {
    const row = { thread: base, account_name: null, contact_name: null, unread_count: 0, last_message_at: null, last_message: null, source_message: null }
    expect(shapeThread({ ...row, account_name: "Acme LLC", contact_name: "Mario" }).company_name).toBe("Acme LLC")
    expect(shapeThread({ ...row, contact_name: "Mario" }).company_name).toBe("Mario")
    expect(shapeThread(row).company_name).toBe("Some title")
    expect(shapeThread({ ...row, thread: { ...base, title: null } }).company_name).toBe("Team Thread")
  })
  it("the unread count arrives as a number even when the database sends text", () => {
    expect(shapeThread({ thread: base, account_name: null, contact_name: null, unread_count: "7", last_message_at: null, last_message: null, source_message: null }).unread_count).toBe(7)
  })
  it("a thread with no messages uses its own creation time and has no preview", () => {
    const r = shapeThread({ thread: base, account_name: null, contact_name: null, unread_count: 0, last_message_at: null, last_message: null, source_message: null })
    expect(r.last_message_at).toBe(base.created_at); expect(r.last_message_preview).toBeNull()
  })
  it("the preview is the first 80 characters of the last message", () => {
    const r = shapeThread({ thread: base, account_name: null, contact_name: null, unread_count: 0, last_message_at: "2026-09-02T00:00:00+00:00", last_message: "x".repeat(200), source_message: "src" })
    expect(r.last_message_preview).toBe("x".repeat(80)); expect(r.source_message).toBe("src")
  })
  it("every original thread column is kept", () => {
    expect(shapeThread({ thread: { ...base, resolution: "done" }, account_name: null, contact_name: null, unread_count: 0, last_message_at: null, last_message: null, source_message: null }).resolution).toBe("done")
  })
})

describe("ordering and fallback", () => {
  it("newest activity first", () => {
    const out = sortThreads([{ last_message_at: "2026-09-01T00:00:00Z" }, { last_message_at: "2026-09-03T00:00:00Z" }, { last_message_at: "2026-09-02T00:00:00Z" }])
    expect(out.map((x) => x.last_message_at.slice(0, 10))).toEqual(["2026-09-03", "2026-09-02", "2026-09-01"])
  })
  it("a missing database function (migration not run yet) is recognised, real errors are not", () => {
    expect(isMissingFunction({ code: "PGRST202", message: "Could not find the function" })).toBe(true)
    expect(isMissingFunction({ code: "42883", message: "function does not exist" })).toBe(true)
    expect(isMissingFunction({ code: "57014", message: "statement timeout" })).toBe(false)
    expect(isMissingFunction(null)).toBe(false)
  })
})
