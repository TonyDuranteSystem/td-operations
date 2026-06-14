import { describe, it, expect } from "vitest"
import {
  END_SENTINEL,
  formatUserMessage,
  isEndSignal,
  eventToRow,
  sessionIdFromEvent,
} from "../../scripts/mac-mini/code-task-stream.mjs"

describe("formatUserMessage", () => {
  it("produces a single NDJSON user-message line", () => {
    const line = formatUserMessage("hello")
    expect(line.endsWith("\n")).toBe(true)
    const obj = JSON.parse(line.trim())
    expect(obj).toEqual({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "hello" }] },
    })
  })
  it("escapes quotes/newlines so the line stays valid JSON", () => {
    const line = formatUserMessage('say "hi"\nthen stop')
    expect(line.split("\n").filter(Boolean).length).toBe(1) // one JSON line (newline only at end)
    expect(JSON.parse(line.trim()).message.content[0].text).toBe('say "hi"\nthen stop')
  })
  it("handles null/undefined as empty text", () => {
    expect(JSON.parse(formatUserMessage(null).trim()).message.content[0].text).toBe("")
  })
})

describe("isEndSignal", () => {
  it("matches the sentinel (trimmed)", () => {
    expect(isEndSignal(END_SENTINEL)).toBe(true)
    expect(isEndSignal("  " + END_SENTINEL + "  ")).toBe(true)
  })
  it("rejects normal text", () => {
    expect(isEndSignal("end")).toBe(false)
    expect(isEndSignal("")).toBe(false)
    expect(isEndSignal(null)).toBe(false)
  })
})

describe("eventToRow", () => {
  it("keeps assistant events with content", () => {
    const ev = { type: "assistant", message: { content: [{ type: "text", text: "hi" }] } }
    expect(eventToRow(ev)).toEqual({ event_type: "assistant", payload: { content: ev.message.content } })
  })
  it("keeps tool_result user events", () => {
    const ev = { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "x", content: "ok" }] } }
    expect(eventToRow(ev)?.event_type).toBe("tool_result")
  })
  it("skips plain user echoes (no tool_result)", () => {
    expect(eventToRow({ type: "user", message: { content: [{ type: "text", text: "hi" }] } })).toBeNull()
  })
  it("maps result with the error flag and text", () => {
    expect(eventToRow({ type: "result", subtype: "success", is_error: false, result: "done" })).toEqual({
      event_type: "result",
      payload: { subtype: "success", is_error: false, result: "done" },
    })
  })
  it("treats a non-success subtype result faithfully", () => {
    const row = eventToRow({ type: "result", subtype: "error_max_turns", is_error: true, result: "" })
    expect(row?.payload).toMatchObject({ subtype: "error_max_turns", is_error: true })
  })
  it("keeps system init with session_id", () => {
    expect(eventToRow({ type: "system", subtype: "init", session_id: "abc" })).toEqual({
      event_type: "system",
      payload: { subtype: "init", session_id: "abc" },
    })
  })
  it("skips noise (rate_limit_event, control) and junk", () => {
    expect(eventToRow({ type: "rate_limit_event" })).toBeNull()
    expect(eventToRow(null)).toBeNull()
    expect(eventToRow("nope")).toBeNull()
  })
})

describe("sessionIdFromEvent", () => {
  it("returns the session_id when present", () => {
    expect(sessionIdFromEvent({ type: "system", session_id: "sid-1" })).toBe("sid-1")
  })
  it("returns null when absent", () => {
    expect(sessionIdFromEvent({ type: "assistant" })).toBeNull()
    expect(sessionIdFromEvent(null)).toBeNull()
  })
})
