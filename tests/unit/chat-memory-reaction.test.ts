/**
 * 🧠 reaction → memory save for the CRM chat surfaces (WS1, dev job a9477d06).
 * The route gates staff-vs-client + add-vs-remove; this module does the save.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

const saveDecisionMemory = vi.fn().mockResolvedValue("mem-1")
vi.mock("@/lib/ai-agent/decision-memory", () => ({
  saveDecisionMemory: (...a: unknown[]) => saveDecisionMemory(...a),
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
  it("saves with client scope + real actor + explicit_save tag", async () => {
    const ok = await saveChatMessageAsMemory({
      messageText: "Bill this client in EUR going forward",
      savedByName: "Luca",
      surface: "portal",
      messageId: "m1",
      accountId: "acct-9",
      contactId: "cnt-9",
    })
    expect(ok).toBe(true)
    expect(saveDecisionMemory).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: "Bill this client in EUR going forward",
        sourceType: "crm_reaction",
        sourceRef: "portal:m1",
        actors: ["luca"],
        tags: ["explicit_save"],
        clientKey: "account:acct-9",
      })
    )
  })

  it("is idempotent — an already-saved message does not re-save", async () => {
    existingRows = [{ id: "already" }]
    const ok = await saveChatMessageAsMemory({
      messageText: "x", savedByName: "Antonio", surface: "team", messageId: "m2",
    })
    expect(ok).toBe(false)
    expect(saveDecisionMemory).not.toHaveBeenCalled()
  })

  it("skips an empty message", async () => {
    const ok = await saveChatMessageAsMemory({
      messageText: "   ", savedByName: "Antonio", surface: "team", messageId: "m3",
    })
    expect(ok).toBe(false)
    expect(saveDecisionMemory).not.toHaveBeenCalled()
  })

  it("saves global (no clientKey) when the thread has no client", async () => {
    await saveChatMessageAsMemory({
      messageText: "internal note worth keeping", savedByName: "Antonio", surface: "team", messageId: "m4",
    })
    const arg = saveDecisionMemory.mock.calls[0][0] as Record<string, unknown>
    expect(arg.clientKey).toBeUndefined()
  })
})
