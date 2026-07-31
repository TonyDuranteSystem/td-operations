/**
 * The portal-chat nudge body. The wording is client-facing and bilingual, so it
 * gets pinned: the portal is the only bilingual surface, and an English message
 * to an Italian client is a real (and previously shipped) defect class.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

const insert = vi.fn()
const maybeSingle = vi.fn()

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      if (table === "contacts") {
        return { select: () => ({ eq: () => ({ maybeSingle }) }) }
      }
      return { insert }
    },
  },
}))

vi.mock("@/lib/config", () => ({ PORTAL_BASE_URL: "https://portal.tonydurante.us" }))

import { postSignatureChatNudge } from "@/lib/esign/chat-nudge"

beforeEach(() => {
  insert.mockReset().mockResolvedValue({ error: null })
  maybeSingle.mockReset().mockResolvedValue({ data: { language: "English" } })
})

const base = { contactId: "c1", accountId: "a1", documentName: "Form 1120 2025", kind: "reminder" as const }

describe("postSignatureChatNudge", () => {
  it("writes an admin message, not a system one — system messages never reach the client", () => {
    return postSignatureChatNudge(base).then(ok => {
      expect(ok).toBe(true)
      expect(insert.mock.calls[0][0].sender_type).toBe("admin")
    })
  })

  it("writes in Italian for an Italian client (language is free text)", async () => {
    maybeSingle.mockResolvedValue({ data: { language: "Italian" } })
    await postSignatureChatNudge(base)
    const row = insert.mock.calls[0][0]
    expect(row.message).toContain("in attesa della tua firma")
    expect(row.topic).toBe("Documenti da firmare")
  })

  it("writes in English for everyone else, including a blank language", async () => {
    for (const language of ["English", "", null, "gibberish"]) {
      insert.mockClear()
      maybeSingle.mockResolvedValue({ data: { language } })
      await postSignatureChatNudge(base)
      const row = insert.mock.calls[0][0]
      expect(row.message).toContain("waiting for your signature")
      expect(row.topic).toBe("Documents to sign")
    }
  })

  it("says 'reopened' rather than 'still waiting' after a reopen", async () => {
    await postSignatureChatNudge({ ...base, kind: "reopened" })
    expect(insert.mock.calls[0][0].message).toContain("reopened")
  })

  it("names the document and links to the signing page", async () => {
    await postSignatureChatNudge(base)
    const msg = insert.mock.calls[0][0].message
    expect(msg).toContain("Form 1120 2025")
    expect(msg).toContain("https://portal.tonydurante.us/portal/sign")
  })

  it("no-ops for a third party with no CRM contact — they have no portal", async () => {
    const ok = await postSignatureChatNudge({ ...base, contactId: null })
    expect(ok).toBe(false)
    expect(insert).not.toHaveBeenCalled()
  })

  it("never throws when the write fails — a chat write must not break a sent reminder", async () => {
    insert.mockResolvedValue({ error: { message: "boom" } })
    await expect(postSignatureChatNudge(base)).resolves.toBe(false)
  })

  it("survives a missing contact row", async () => {
    maybeSingle.mockResolvedValue({ data: null })
    await expect(postSignatureChatNudge(base)).resolves.toBe(true)
    expect(insert.mock.calls[0][0].message).toContain("waiting for your signature")
  })
})
