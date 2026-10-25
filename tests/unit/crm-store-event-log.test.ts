import { describe, it, expect, vi } from "vitest"
import { logStoreEvent, rollBackOrAlarm, unexpectedPlaceMessage } from "@/lib/crm-store/event-log"

const row = { event: "marked_signed", owner_id: "o1", file_id: "f1", folder_id: "d1", name_snapshot: "a.pdf", details: {} }

describe("logStoreEvent", () => {
  it("writes once when the insert works", async () => {
    const insert = vi.fn(async () => ({ error: null })); const alarm = vi.fn()
    expect(await logStoreEvent(row, { insert, alarm })).toBe(true)
    expect(insert).toHaveBeenCalledTimes(1); expect(alarm).not.toHaveBeenCalled()
  })
  it("retries once and succeeds without an alarm", async () => {
    const insert = vi.fn().mockResolvedValueOnce({ error: { message: "blip" } }).mockResolvedValueOnce({ error: null }); const alarm = vi.fn()
    expect(await logStoreEvent(row, { insert, alarm })).toBe(true)
    expect(insert).toHaveBeenCalledTimes(2); expect(alarm).not.toHaveBeenCalled()
  })
  it("raises the alarm (not just a log line) when both attempts fail, and never throws", async () => {
    const insert = vi.fn(async () => ({ error: { message: "down" } })); const alarm = vi.fn()
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    expect(await logStoreEvent(row, { insert, alarm })).toBe(false)
    expect(insert).toHaveBeenCalledTimes(2)
    expect(alarm).toHaveBeenCalledWith("store_event_not_logged", expect.objectContaining({ event: "marked_signed", fileId: "f1", ownerId: "o1" }))
    spy.mockRestore()
  })
  it("treats a thrown insert like a failed one and survives a throwing alarm", async () => {
    const insert = vi.fn(async () => { throw new Error("socket") }); const alarm = vi.fn(async () => { throw new Error("alarm down") })
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    await expect(logStoreEvent(row, { insert, alarm })).resolves.toBe(false)
    spy.mockRestore()
  })
})

describe("rollBackOrAlarm", () => {
  it("returns true when the put-back worked", async () => {
    const alarm = vi.fn()
    expect(await rollBackOrAlarm("x", {}, async () => ({ error: null }), { alarm })).toBe(true)
    expect(alarm).not.toHaveBeenCalled()
  })
  it("returns false and alarms when supabase-js resolves with an error (it does not throw)", async () => {
    const alarm = vi.fn(); const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    expect(await rollBackOrAlarm("rename put-back", { fileId: "f1" }, async () => ({ error: { message: "rls" } }), { alarm })).toBe(false)
    expect(alarm).toHaveBeenCalledWith("store_putback_failed", expect.objectContaining({ fileId: "f1", what: "rename put-back", error: "rls" }))
    spy.mockRestore()
  })
  it("also catches a thrown step", async () => {
    const alarm = vi.fn(); const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    expect(await rollBackOrAlarm("x", {}, async () => { throw new Error("boom") }, { alarm })).toBe(false)
    expect(alarm).toHaveBeenCalled(); spy.mockRestore()
  })
  it("the user message says the file may be in an unexpected place, not 'not moved'", () => {
    expect(unexpectedPlaceMessage("The CRM list failed.")).toMatch(/unexpected place/)
  })
})
