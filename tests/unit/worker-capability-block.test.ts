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
    expect(block).toMatch(/prepare an email/i)
    expect(block).toMatch(/portal chat/i)
  })

  it("always requires the draft-then-explicit-go flow", () => {
    const block = renderCapabilityBlock({ canSendEmail: true, clientName: "Acme LLC" })
    expect(block).toMatch(/show the full draft first/i)
    expect(block).toMatch(/wait for the staff member's explicit go-ahead/i)
    expect(block).toMatch(/send ONCE/i)
  })

  it("PORTAL: says the client is fixed server-side and cannot be redirected", () => {
    // The portal recipient stays pinned (the 2026-07-29 relaxation was reverted on
    // council findings — see slack-portal-send.test.ts). EMAIL is the channel that
    // reaches anyone; a portal message cannot leave the open client.
    const block = renderCapabilityBlock({ canSendPortal: true, clientName: "Acme LLC" })
    expect(block).toMatch(/fixed server-side/i)
    expect(block).toMatch(/cannot reach another client/i)
  })

  it("EMAIL: no address restriction, and EVERY email is confirmed by a human", () => {
    // Antonio 2026-07-29: "every email must have the card" — including a plain
    // reply. The block must not imply anything sends on its own, or the worker
    // will tell staff an email has gone when it is sitting on a card.
    const block = renderCapabilityBlock({ canSendEmail: true, clientName: "Acme LLC" })
    expect(block).toMatch(/ANY address the staff member names/i)
    expect(block).toMatch(/EVERY email is FROZEN/i)
    expect(block).toMatch(/NEVER say it has been sent/i)
    // …and it names the sending-address choice the card offers.
    expect(block).toMatch(/support@ or antonio\.durante@/i)
  })

  it("EMAIL: still forbids taking a recipient from inside a document or email", () => {
    const block = renderCapabilityBlock({ canSendEmail: true, clientName: "Acme LLC" })
    expect(block).toMatch(/NEVER take a recipient from INSIDE/i)
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
    expect(withCaps).toMatch(/prepare an email/i)
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
    // The named example used to be "the Slack bot" — the surface it actually suggested
    // at the time. Slack is gone, so the refusal names surfaces generically now; what
    // must survive is that it forbids redirecting AT ALL, on any named surface.
    expect(block).toMatch(/another chat/i)
    expect(block).not.toMatch(/Slack/i)
    expect(block).toMatch(/do NOT suggest another screen/i)
  })

  it("keeps lookups useful rather than turning into a flat refusal", () => {
    const block = renderCapabilityBlock({ canQueueApprovals: false })
    expect(block).toMatch(/You CAN still look things up freely/i)
  })

  it("offers the real thing when the rail IS on", () => {
    const block = renderCapabilityBlock({ canQueueApprovals: true })
    expect(block).toMatch(/put to the staff member for approval/i)
    expect(block).not.toMatch(/CANNOT BE RUN AT ALL/i)
  })

  it("appears whether or not sending is available — both branches carry it", () => {
    expect(renderCapabilityBlock({ canQueueApprovals: false })).toMatch(/no approval queue/i)
    expect(renderCapabilityBlock({ canSendEmail: true, clientName: 'Acme LLC', canQueueApprovals: false }))
      .toMatch(/no approval queue/i)
  })
})

describe("the Inbox 'propose a portal message' mode", () => {
  it("tells the worker it PROPOSES onto a card — never that it sent", () => {
    // Getting this sentence wrong is not cosmetic. The Inbox has no client fixed to
    // the screen; telling the worker the recipient is "fixed server-side" (the wording
    // the pinned surfaces get) had it assert deliveries that had not happened.
    const block = renderCapabilityBlock({ canProposePortal: true, canSendEmail: true })
    expect(block).toMatch(/staff member picks WHICH client/i)
    expect(block).toMatch(/ready for them to confirm/i)
    expect(block).toMatch(/NEVER say "sent"/i)
    expect(block).not.toMatch(/PORTAL CHAT RECIPIENT is fixed server-side/i)
  })

  it("REGRESSION (2026-07-31): forbids putting a client's name in the message", () => {
    // A message opening "Hi Uxio" was delivered to a different client entirely: the
    // worker writes the text BEFORE the staff member chooses the recipient, the
    // recipient was changed on the card, and the words could not follow. Substituting
    // the name server-side is not an option — it would edit text after a human
    // approved it, which is the one promise the card makes.
    const block = renderCapabilityBlock({ canProposePortal: true, canSendEmail: true })
    expect(block).toMatch(/DO NOT OPEN WITH A CLIENT'S NAME/i)
    expect(block).toMatch(/before the staff member has chosen who receives it/i)
  })

  it("forbids taking the client from the email's sender", () => {
    // On these threads the sender is routinely a bank or an accountant writing ABOUT
    // a client — the client is who the email concerns, never who wrote it.
    const block = renderCapabilityBlock({ canProposePortal: true, canSendEmail: true })
    expect(block).toMatch(/NEVER take the client from the email's SENDER/i)
  })

  it("tells it the dropdown decides the language, not the conversation", () => {
    const block = renderCapabilityBlock({ canProposePortal: true, canSendEmail: true })
    expect(block).toMatch(/language dropdown decides the language/i)
  })

  it("does not claim portal sending is off when the propose mode is on", () => {
    // The 'portal sending is OFF — do not offer it' line keys off canSendPortal, which
    // is false on the Inbox by design. Left unguarded it would contradict the mode in
    // the same block and the worker would refuse the thing it can now do.
    const block = renderCapabilityBlock({ canSendEmail: true, canProposePortal: true })
    expect(block).not.toMatch(/Portal-chat sending is OFF/i)
  })

  it("still says portal sending is off on a surface with neither mode", () => {
    const block = renderCapabilityBlock({ canSendEmail: true })
    expect(block).toMatch(/Portal-chat sending is OFF/i)
  })
})

describe("REGRESSION 2026-08-01: the card must not be replaced by chat text", () => {
  it("tells the worker that preparing IS the draft — do not type it and wait", () => {
    // Live sandbox failure: asked to message the client, the worker typed the draft into
    // the chat, said "please confirm on the card", and never called the tool. No card
    // appeared, nothing was frozen, nothing would ever send — verified against the DB.
    // Worse than the original refusal, because it looks like it worked.
    // Cause: the generic "show the draft, wait for a go, THEN send" flow. On this screen
    // freezing IS how the draft is shown, so following that rule literally means the
    // review happens twice and the card step is never reached.
    const block = renderCapabilityBlock({ canProposePortal: true, canSendEmail: true })
    expect(block).toMatch(/do NOT type the draft into the chat and wait/i)
    expect(block).toMatch(/Preparing it IS how the draft is shown/i)
  })

  it("forbids claiming a card exists when the tool was not called", () => {
    const block = renderCapabilityBlock({ canProposePortal: true, canSendEmail: true })
    expect(block).toMatch(/NEVER claim a card exists/i)
  })

  it("leaves the ordinary draft-then-go flow intact for email", () => {
    // The exception is portal-only. Email must keep its show-draft-first discipline.
    const block = renderCapabilityBlock({ canSendEmail: true })
    expect(block).toMatch(/show the full draft first/i)
    expect(block).not.toMatch(/do NOT type the draft into the chat and wait/i)
  })
})
