import { describe, it, expect, vi, beforeEach } from "vitest"

const state = vi.hoisted(() => ({
  uploads: [] as Array<{ path: string; size: number; contentType: string }>,
  uploadError: null as null | { message: string },
  rpcCalls: [] as Array<Record<string, unknown>>,
  rpcAnswer: { ok: true, id: "ob-1", status: "queued" } as unknown,
  updates: [] as Array<Record<string, unknown>>,
}))

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    storage: { from: () => ({ upload: async (path: string, bytes: Buffer, o: { contentType: string }) => { state.uploads.push({ path, size: bytes.length, contentType: o.contentType }); return { error: state.uploadError } } }) },
    rpc: async (_fn: string, args: Record<string, unknown>) => { state.rpcCalls.push(args); return { data: state.rpcAnswer, error: null } },
    from: () => ({ update: (p: Record<string, unknown>) => { state.updates.push(p); return { eq: async () => ({ error: null }) } } }),
  },
}))

import { sendVoiceCheck, saveVoiceCheck } from "@/lib/messaging/wabridge-voice-check-send"

const NOW = new Date("2026-11-16T14:00:00Z")
beforeEach(() => { state.uploads = []; state.uploadError = null; state.rpcCalls = []; state.rpcAnswer = { ok: true, id: "ob-1", status: "queued" }; state.updates = [] })

describe("sendVoiceCheck", () => {
  it("stores the recording where the queue expects it, queues it as a voice note and records it as sent", async () => {
    const vc = await sendVoiceCheck("chan-1", "chat-1", NOW)
    expect(vc).toMatchObject({ week: "2026-W47", status: "sent", outbox_id: "ob-1" })
    expect(state.uploads).toHaveLength(1)
    expect(state.uploads[0].path).toMatch(/^outbound\/chan-1\/voice-check-2026-W47-[0-9a-f]{8}\.m4a$/)
    expect(state.uploads[0].contentType).toBe("audio/mp4")
    expect(state.uploads[0].size).toBeGreaterThan(10_000)
    expect(state.rpcCalls[0]).toMatchObject({ p_group_id: "chat-1", p_kind: "voice", p_media_mime: "audio/mp4", p_created_by: null })
    expect(String(state.rpcCalls[0].p_content_hash)).toMatch(/^[0-9a-f]{64}$/)
    expect(state.rpcCalls[0].p_client_msg_id).toBe(vc.client_msg_id)
  })
  it("never says 'sent' when the queue refuses; the reason is kept in plain words", async () => {
    state.rpcAnswer = { ok: false, code: "paused", message: "Sending from the CRM is paused — reply from the phone for now." }
    const vc = await sendVoiceCheck("chan-1", "chat-1", NOW)
    expect(vc.status).toBe("send_failed")
    expect(vc.error).toContain("paused")
  })
  it("a failed upload is a failed test, and nothing is queued", async () => {
    state.uploadError = { message: "boom" }
    const vc = await sendVoiceCheck("chan-1", "chat-1", NOW)
    expect(vc.status).toBe("send_failed")
    expect(state.rpcCalls).toEqual([])
  })
  it("saveVoiceCheck writes the state row", async () => {
    expect(await saveVoiceCheck("chan-1", { week: "w", status: "played", sent_at: "t" })).toBe(true)
    expect(state.updates).toEqual([{ voice_check: { week: "w", status: "played", sent_at: "t" } }])
  })
})
