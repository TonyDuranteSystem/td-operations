/**
 * The worker's statement of what it can do must be GENERATED from what it can reach
 * (dev job c956d7ee — the false-capability class).
 *
 * History: the sidebar shipped with prose telling the worker "off a client page sending
 * is unavailable — say so plainly". It then offered to "fire it off" from the dashboard
 * anyway, because a sentence in a long prompt is just more text competing with the rest.
 * The same class of failure told Luca he could download a PDF that never existed.
 *
 * The fix is structural: the sentence is derived from the same booleans that decide
 * whether the send tool is loaded at all, so the honest version is the only version.
 * These tests pin that — including the trap where a client has no address on file, where
 * the rail is technically on but every address is refused.
 */

import { describe, it, expect } from "vitest"
import { renderCapabilityBlock, buildWorkerSurfacePrompt } from "@/lib/ai-agent/inbox-worker-prompt"

describe("renderCapabilityBlock — no send rails", () => {
  const block = renderCapabilityBlock({})

  it("states plainly that sending is off", () => {
    expect(block).toMatch(/SENDING IS OFF/i)
  })

  it("forbids offering to send, which is the exact observed failure", () => {
    expect(block).toMatch(/do NOT offer to send/i)
    expect(block).toMatch(/say the word/i) // names the actual phrase it used
  })

  it("forbids claiming a send happened, and forbids inventing a workaround", () => {
    expect(block).toMatch(/do NOT claim anything was sent/i)
    expect(block).toMatch(/NO workaround/i)
  })

  it("still permits drafting — this is an honesty fix, not a capability removal", () => {
    expect(block).toMatch(/drafting is still useful/i)
  })
})

describe("renderCapabilityBlock — rails on", () => {
  it("names the client it may reach", () => {
    const block = renderCapabilityBlock({ canSendEmail: true, canSendPortal: true, clientName: "Uxio Test LLC" })
    expect(block).toMatch(/Uxio Test LLC/)
    expect(block).toMatch(/send an email/i)
    expect(block).toMatch(/portal chat/i)
  })

  it("always requires the draft-then-explicit-go flow", () => {
    const block = renderCapabilityBlock({ canSendEmail: true, clientName: "Acme LLC" })
    expect(block).toMatch(/show the full draft first/i)
    expect(block).toMatch(/wait for the staff member's explicit go-ahead/i)
    expect(block).toMatch(/send ONCE/i)
  })

  it("says the recipient is fixed server-side and cannot be redirected", () => {
    const block = renderCapabilityBlock({ canSendPortal: true, clientName: "Acme LLC" })
    expect(block).toMatch(/fixed server-side/i)
    expect(block).toMatch(/cannot reach any other client/i)
  })

  it("EMAIL only: explicitly says portal sending is off, so it cannot offer it", () => {
    const block = renderCapabilityBlock({ canSendEmail: true, canSendPortal: false, clientName: "Acme LLC" })
    expect(block).toMatch(/Portal-chat sending is OFF/i)
    expect(block).not.toMatch(/post a message to/i)
  })

  it("PORTAL only: explicitly says email is off, so it cannot offer it", () => {
    const block = renderCapabilityBlock({ canSendPortal: true, canSendEmail: false, clientName: "Acme LLC" })
    expect(block).toMatch(/Email sending is OFF/i)
    expect(block).not.toMatch(/send an email to/i)
  })

  it("falls back to a generic reference when the client name is unknown", () => {
    const block = renderCapabilityBlock({ canSendPortal: true, clientName: null })
    expect(block).toMatch(/the client whose page is open/i)
  })
})

describe("buildWorkerSurfacePrompt", () => {
  it("appends the capability block when capabilities are supplied", () => {
    const withCaps = buildWorkerSurfacePrompt("dashboard", { canSendEmail: true, clientName: "Acme LLC" })
    expect(withCaps).toMatch(/WHAT YOU CAN ACTUALLY DO RIGHT NOW/i)
    expect(withCaps).toMatch(/Acme LLC/)
  })

  it("omits it entirely when not supplied — an unmigrated surface must not gain a false claim", () => {
    expect(buildWorkerSurfacePrompt("dashboard")).not.toMatch(/WHAT YOU CAN ACTUALLY DO RIGHT NOW/i)
  })

  it("REGRESSION: an off-rail surface never renders a can-send sentence", () => {
    // The whole point. If this fails, the worker is being told it can send when it cannot.
    const off = buildWorkerSurfacePrompt("dashboard", { canSendEmail: false, canSendPortal: false })
    expect(off).toMatch(/SENDING IS OFF/i)
    expect(off).not.toMatch(/You CAN: /)
  })
})

describe("approval-tier tools — no inventing a queue that is switched off", () => {
  it("says plainly they cannot be run, and forbids the exact phrase it was using", () => {
    const block = renderCapabilityBlock({ canQueueApprovals: false })
    expect(block).toMatch(/CANNOT BE RUN AT ALL/i)
    expect(block).toMatch(/There is no approval queue/i)
    expect(block).toMatch(/say the word and I'll queue it/i) // named so it stops saying it
    expect(block).toMatch(/do NOT imply anything is pending/i)
  })

  it("forbids pointing at another surface — it is off everywhere, so that just wastes a trip", () => {
    const block = renderCapabilityBlock({ canQueueApprovals: false })
    expect(block).toMatch(/switched off EVERYWHERE/i)
    expect(block).toMatch(/Slack bot/i) // names the suggestion it actually made
    expect(block).toMatch(/do NOT suggest another screen/i)
  })

  it("keeps lookups useful rather than turning into a flat refusal", () => {
    const block = renderCapabilityBlock({ canQueueApprovals: false })
    expect(block).toMatch(/You CAN still look things up freely/i)
  })

  it("offers the real thing when the rail IS on — a card and one click", () => {
    const block = renderCapabilityBlock({ canQueueApprovals: true })
    expect(block).toMatch(/ONE CLICK/i)
    expect(block).not.toMatch(/CANNOT BE RUN AT ALL/i)
  })

  it("does not send them off to type a code — the abandoned rail's flow", () => {
    // The old transport queued the action and made Antonio type a 6-digit code back over
    // Telegram. It ran three trivial actions in five weeks because the confirmation was
    // somewhere other than the work. If this sentence reappears, the worker starts
    // describing a flow that no longer exists.
    const block = renderCapabilityBlock({ canQueueApprovals: true })
    expect(block).toMatch(/no code to type/i)
  })

  it("forbids claiming the action is already done — nothing runs until the click", () => {
    // The single most damaging thing it could say here. A staff member who reads
    // "I've moved Banking to Documents Received" stops checking, and the stage never moved.
    const block = renderCapabilityBlock({ canQueueApprovals: true })
    expect(block).toMatch(/nothing runs until they click/i)
    expect(block).toMatch(/do NOT say it is done/i)
  })

  it("keeps client sends OFF the card path even with the rail on", () => {
    // A frozen payload cannot reproduce the live recipient check, so sends stay on the
    // draft-and-send flow. The worker must not offer a confirmation card for an email.
    const block = renderCapabilityBlock({ canQueueApprovals: true })
    expect(block).toMatch(/SENDING TO A CLIENT is NOT one of these/i)
  })

  it("tells it how to make a file whether the rail is on OR off", () => {
    // REGRESSION GUARD: the FILES instruction used to live only in the rail-off text, so
    // turning the rail on silently deleted the one thing telling the worker how to
    // produce a document — and without it, it invented a Python sandbox rather than
    // admitting it could not make a file.
    for (const canQueueApprovals of [true, false]) {
      const block = renderCapabilityBlock({ canQueueApprovals })
      expect(block, `rail ${canQueueApprovals}`).toMatch(/pdf_create/)
      expect(block, `rail ${canQueueApprovals}`).toMatch(/NO code execution, no Python, no shell/i)
    }
  })

  it("appears whether or not sending is available — both branches carry it", () => {
    expect(renderCapabilityBlock({ canQueueApprovals: false })).toMatch(/no approval queue/i)
    expect(renderCapabilityBlock({ canSendEmail: true, clientName: 'Acme LLC', canQueueApprovals: false }))
      .toMatch(/no approval queue/i)
  })
})
