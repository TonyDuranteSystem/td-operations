/**
 * The old instruction told the assistant to wait for a SEPARATE follow-up
 * message ("send it") before ever calling the tool that locks in a draft —
 * a holdover from before every send became a human-confirmed freeze
 * (2026-07-29). Calling the tool only freezes a draft now; it never sends by
 * itself. Waiting for a second turn before calling it is exactly what let a
 * file's attach-ref expire out from under a real conversation (dev job
 * eefac886, Luca — Payset/Dragos, "not available this turn"). This pins the
 * correction: the assistant is told it's safe to call the tool THIS turn
 * once the ask is already clear, rather than always waiting for a reply.
 */

import { describe, it, expect } from "vitest"
import { buildWorkerSurfacePrompt, renderCapabilityBlock } from "@/lib/ai-agent/inbox-worker-prompt"

describe("Inbox surface email flow — timing fix", () => {
  it("no longer tells the model to always wait for a separate go-ahead before calling send_email", () => {
    const prompt = buildWorkerSurfacePrompt("inbox")
    expect(prompt).not.toContain("wait for their explicit go-ahead, THEN call send_email ONCE")
  })

  it("says calling it immediately is safe when the ask is already clear", () => {
    const prompt = buildWorkerSurfacePrompt("inbox")
    expect(prompt).toContain("call send_email in this SAME turn")
    expect(prompt).toMatch(/freezes the draft.*confirmation click.*does not send/)
  })

  it("still allows waiting when the ask is genuinely ambiguous — the safety property isn't removed, just made conditional", () => {
    const prompt = buildWorkerSurfacePrompt("inbox")
    expect(prompt).toMatch(/genuinely unclear whether they want it sent yet.*wait for their explicit go-ahead/)
  })
})

describe("renderCapabilityBlock — the shared flow line (Inbox, Portal Chats, dashboard sidebar all use this)", () => {
  it("no longer forces waiting for a second turn before calling the send tool", () => {
    const block = renderCapabilityBlock({ canSendEmail: true })
    expect(block).not.toContain('wait for the staff member\'s explicit go-ahead ("send it", "send", "go ahead", or clearly equivalent), THEN send ONCE.')
  })

  it("tells the model calling the tool this turn is safe once the ask is already clear", () => {
    const block = renderCapabilityBlock({ canSendEmail: true })
    expect(block).toContain("call the send tool in this SAME turn")
  })

  it("still applies to the portal-message surface, not just email", () => {
    const block = renderCapabilityBlock({ canSendPortal: true })
    expect(block).toContain("call the send tool in this SAME turn")
  })
})
