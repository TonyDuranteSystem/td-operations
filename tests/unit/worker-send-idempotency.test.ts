/**
 * Cross-run double-send guard (2026-07-17 council WS0): a stuck worker turn is
 * recovered + re-run by the Slack cron and re-sends the same client message.
 * claimWorkerSend records a one-time marker; a re-run hits the DB unique index
 * and is told to skip. Degrades to "allow" if the marker table isn't there yet.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

let insertError: { code?: string } | null = null
const insertSpy = vi.fn()

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: () => ({
      insert: (row: unknown) => {
        insertSpy(row)
        return Promise.resolve({ error: insertError })
      },
    }),
  },
}))

import { claimWorkerSend } from "@/lib/ai-agent/worker-tools"

beforeEach(() => {
  insertError = null
  insertSpy.mockClear()
})

describe("claimWorkerSend", () => {
  it("no originating message id → allows (cannot dedup), no insert attempted", async () => {
    await expect(claimWorkerSend(null, "portal_message", "acct-1", "hi")).resolves.toBe(true)
    await expect(claimWorkerSend(undefined, "portal_message", "acct-1", "hi")).resolves.toBe(true)
    expect(insertSpy).not.toHaveBeenCalled()
  })

  it("fresh send → inserts a marker and allows", async () => {
    insertError = null
    await expect(claimWorkerSend("msg-1", "portal_message", "acct-1", "hello")).resolves.toBe(true)
    expect(insertSpy).toHaveBeenCalledWith(
      expect.objectContaining({ source_message_id: "msg-1", kind: "portal_message", target: "acct-1" })
    )
  })

  it("duplicate (unique violation 23505) → BLOCKS the re-send", async () => {
    insertError = { code: "23505" }
    await expect(claimWorkerSend("msg-1", "portal_message", "acct-1", "hello")).resolves.toBe(false)
  })

  it("marker table missing / other DB error → allows (never blocks a real send)", async () => {
    insertError = { code: "42P01" } // undefined_table
    await expect(claimWorkerSend("msg-1", "portal_message", "acct-1", "hello")).resolves.toBe(true)
  })

  it("same content → same hash (a real re-run reproduces the identical marker)", async () => {
    await claimWorkerSend("msg-1", "portal_message", "acct-1", "identical body")
    const firstRow = insertSpy.mock.calls[0][0] as { content_hash: string }
    insertSpy.mockClear()
    await claimWorkerSend("msg-1", "portal_message", "acct-1", "identical body")
    const secondRow = insertSpy.mock.calls[0][0] as { content_hash: string }
    expect(secondRow.content_hash).toBe(firstRow.content_hash)
  })

  it("different content → different hash (a genuine 2nd distinct message is allowed)", async () => {
    await claimWorkerSend("msg-1", "portal_message", "acct-1", "first message")
    const firstRow = insertSpy.mock.calls[0][0] as { content_hash: string }
    insertSpy.mockClear()
    await claimWorkerSend("msg-1", "portal_message", "acct-1", "second, different message")
    const secondRow = insertSpy.mock.calls[0][0] as { content_hash: string }
    expect(secondRow.content_hash).not.toBe(firstRow.content_hash)
  })
})
