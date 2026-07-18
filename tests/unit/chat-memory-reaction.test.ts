/**
 * 🧠 reaction → memory save for the CRM chat surfaces (WS1, dev job a9477d06).
 * The route gates staff-vs-client + add-vs-remove; this module does the save.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

const saveDecisionMemory = vi.fn().mockResolvedValue("mem-1")
vi.mock("@/lib/ai-agent/decision-memory", () => ({
  saveDecisionMemory: (...a: unknown[]) => saveDecisionMemory(...a),
}))

// 🧠 now distills the marked message into a general, client-free lesson (Antonio:
// "🧠 = make it global"). Mock the distiller so the test stays model-free.
const distillMarkedMessage = vi.fn()
vi.mock("@/lib/ai-agent/lesson-capture", () => ({
  distillMarkedMessage: (...a: unknown[]) => distillMarkedMessage(...a),
}))

let existingRows: Array<{ id: string }> = []
vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            limit: () => Promise.resolve({ data: existingRows }),
          }),
        }),
      }),
    }),
  },
}))

import {
  isBrainEmoji,
  deriveClientKey,
  saveChatMessageAsMemory,
  messageFingerprint,
} from "@/lib/ai-agent/chat-memory-reaction"

beforeEach(() => {
  saveDecisionMemory.mockClear()
  distillMarkedMessage.mockReset()
  // Default: the distiller produces a clean general lesson.
  distillMarkedMessage.mockResolvedValue({
    situation: "When a client should be billed in a specific currency going forward",
    decision: "Bill that client in the agreed currency from now on",
    reasoning: "Matches the agreed billing terms",
  })
  existingRows = []
})

describe("isBrainEmoji", () => {
  it("matches only the brain emoji", () => {
    expect(isBrainEmoji("🧠")).toBe(true)
    expect(isBrainEmoji(" 🧠 ")).toBe(true)
    expect(isBrainEmoji("👍")).toBe(false)
    expect(isBrainEmoji("brain")).toBe(false)
    expect(isBrainEmoji("")).toBe(false)
    expect(isBrainEmoji(null)).toBe(false)
  })
})

describe("deriveClientKey", () => {
  it("account wins over contact; canonical form", () => {
    expect(deriveClientKey("a1", "c1")).toBe("account:a1")
    expect(deriveClientKey(null, "c1")).toBe("contact:c1")
    expect(deriveClientKey(null, null)).toBeNull()
    expect(deriveClientKey(undefined, undefined)).toBeNull()
  })
})

describe("messageFingerprint", () => {
  it("is stable and non-empty", () => {
    expect(messageFingerprint("hello")).toBe(messageFingerprint("hello"))
    expect(messageFingerprint("a")).not.toBe(messageFingerprint("b"))
  })
})

describe("saveChatMessageAsMemory", () => {
  it("distills to a GLOBAL lesson (no clientKey) even from a client's Portal chat", async () => {
    const ok = await saveChatMessageAsMemory({
      messageText: "Bill this client in EUR going forward",
      savedByName: "Luca",
      surface: "portal",
      messageId: "m1",
      accountId: "acct-9",
      contactId: "cnt-9",
    })
    expect(ok).toBe(true)
    // the raw message is passed to the distiller, not saved verbatim
    expect(distillMarkedMessage).toHaveBeenCalledWith("Bill this client in EUR going forward")
    const arg = saveDecisionMemory.mock.calls[0][0] as Record<string, unknown>
    expect(arg.decision).toBe("Bill that client in the agreed currency from now on") // distilled
    expect(arg.sourceType).toBe("crm_reaction")
    expect(arg.sourceRef).toBe("portal:m1")
    expect(arg.actors).toEqual(["luca"])
    expect(arg.tags).toEqual(["explicit_save"])
    // GLOBAL — the client scope is intentionally gone (🧠 = make it global)
    expect(arg.clientKey).toBeUndefined()
  })

  it("is idempotent — an already-saved message does not re-save", async () => {
    existingRows = [{ id: "already" }]
    const ok = await saveChatMessageAsMemory({
      messageText: "x", savedByName: "Antonio", surface: "team", messageId: "m2",
    })
    expect(ok).toBe(false)
    expect(saveDecisionMemory).not.toHaveBeenCalled()
  })

  it("skips an empty message before distilling", async () => {
    const ok = await saveChatMessageAsMemory({
      messageText: "   ", savedByName: "Antonio", surface: "team", messageId: "m3",
    })
    expect(ok).toBe(false)
    expect(distillMarkedMessage).not.toHaveBeenCalled()
    expect(saveDecisionMemory).not.toHaveBeenCalled()
  })

  it("FAILS CLOSED — nothing saved when the distiller finds nothing general", async () => {
    distillMarkedMessage.mockResolvedValue(null)
    const ok = await saveChatMessageAsMemory({
      messageText: "just a client-specific aside", savedByName: "Antonio", surface: "team", messageId: "m4",
    })
    expect(ok).toBe(false)
    expect(saveDecisionMemory).not.toHaveBeenCalled()
  })
})
