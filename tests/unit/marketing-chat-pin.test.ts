import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { nextPinned, pinnedMessages } from "@/lib/talk/pins"
import { messageSignature, type TalkMessage } from "@/lib/talk/chat-model"
import { toTalkMessage, visibleToSetter } from "@/lib/marketing/lead-chat"
import { pinFailure } from "@/lib/marketing/lead-chat-server"

const M = (id: string, pinned_at: string | null, deleted_at: string | null = null) => ({ id, pinned_at, deleted_at })
const read = (p: string) => readFileSync(p, "utf8")

describe("the pinned bar", () => {
  it("lists pinned messages, newest pin first; unpinned and deleted ones are left out", () => {
    const list = [M("a", "2026-10-28T10:00:00Z"), M("b", null), M("c", "2026-10-28T11:00:00Z"), M("d", "2026-10-28T12:00:00Z", "2026-10-28T12:30:00Z")]
    expect(pinnedMessages(list).map(m => m.id)).toEqual(["c", "a"])
    expect(pinnedMessages([])).toEqual([])
  })
  it("steps through the pins one by one and wraps round", () => {
    const pins = [{ id: "c" }, { id: "a" }]
    expect(nextPinned(pins, "c")?.id).toBe("a")
    expect(nextPinned(pins, "a")?.id).toBe("c")
    expect(nextPinned(pins, null)?.id).toBe("c")
    expect(nextPinned([], null)).toBeNull()
  })
})

describe("a pin travels with the message", () => {
  const row = { id: "m1", sender_id: "u", sender_name: "U", message: "hi", attachments: null, reply_to_id: null, edited_at: null, deleted_at: null, created_at: "2026-10-28T10:00:00Z" }
  it("the screen gets the pin time, or null when the database has no pin column", () => {
    expect(toTalkMessage({ ...row, pinned_at: "2026-10-28T10:05:00Z" }, new Map(), [], () => null).pinned_at).toBe("2026-10-28T10:05:00Z")
    expect(toTalkMessage(row, new Map(), [], () => null).pinned_at).toBeNull()
  })
  it("pinning or unpinning redraws the chat (it is part of the fingerprint)", () => {
    const a = { id: "m1", message: "hi" } as TalkMessage
    expect(messageSignature([a])).not.toBe(messageSignature([{ ...a, pinned_at: "2026-10-28T10:05:00Z" }]))
  })
  it("a setter is never shown a pin of a message she may not read (the bar is built from what she was given)", () => {
    const hidden = { sender_id: "rocco", mentions: [] as string[] }
    expect(visibleToSetter(hidden, "ale", new Set(["ale"]))).toBe(false)
    expect(visibleToSetter({ ...hidden, mentions: ["ale"] }, "ale", new Set(["ale"]))).toBe(true)
  })
})

describe("pinning without the database change says so plainly", () => {
  it("a missing column is a clear message, anything else a plain failure", () => {
    expect(pinFailure({ code: "42703" })).toMatchObject({ ok: false, status: 503, error: expect.stringContaining("not switched on") })
    expect(pinFailure({ code: "PGRST204", message: "Could not find the 'pinned_at' column of 'marketing_lead_messages' in the schema cache" })).toMatchObject({ status: 503 })
    expect(pinFailure({ code: "XX000" })).toMatchObject({ ok: false, status: 500 })
  })
})

describe("wiring", () => {
  it("both routes go through the same visibility gates as edit/delete/Mark unread", () => {
    expect(read("lib/marketing/lead-chat-server.ts")).toMatch(/setLeadMessagePinned[\s\S]{0,400}messageInTeam\(ctx, messageId\)/)
    expect(read("lib/marketing/team-chat-server.ts")).toMatch(/setThreadMessagePinned[\s\S]{0,400}myMessage\(ctx, messageId\)/)
    expect(read("app/api/marketing/chat/[leadId]/pin/route.ts")).toContain("openChat(leadId)")
    expect(read("app/api/marketing/team-chat/[threadId]/pin/route.ts")).toContain("openThread(threadId)")
  })
  it("the Pin menu item is opt-in: TD Talk and the portal chat never pass it", () => {
    expect(read("components/marketing/lead-chat.tsx")).toContain("onTogglePin")
    for (const f of ["components/talk/talk-app.tsx", "components/portal/portal-chat.tsx"]) {
      try { expect(read(f)).not.toContain("onTogglePin") } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e }
    }
  })
  it("the migration has an UNDO and both tables get both columns", () => {
    const up = read("scripts/migrations/20261028-2300-marketing-chat-pin.sql")
    for (const t of ["marketing_lead_messages", "marketing_team_messages"]) for (const c of ["pinned_at", "pinned_by"]) expect(up).toContain(`ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS ${c}`)
    expect(read("scripts/migrations/20261028-2300-marketing-chat-pin.UNDO.sql")).toContain("DROP COLUMN IF EXISTS pinned_at")
  })
})
