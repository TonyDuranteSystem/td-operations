import { describe, it, expect } from "vitest"
import { resolveMailbox, allowedMailboxes, DEFAULT_MAILBOX } from "../../lib/ai-agent/gmail-mailbox"

const ALLOWED = ["support@tonydurante.us", "antonio.durante@tonydurante.us"]

describe("resolveMailbox", () => {
  it("returns null (default mailbox) when no as_user is given", () => {
    expect(resolveMailbox(undefined, ALLOWED)).toBeNull()
    expect(resolveMailbox("", ALLOWED)).toBeNull()
    expect(resolveMailbox("   ", ALLOWED)).toBeNull()
  })

  it("allows Antonio's personal inbox (case-insensitive, trimmed)", () => {
    expect(resolveMailbox("antonio.durante@tonydurante.us", ALLOWED)).toBe("antonio.durante@tonydurante.us")
    expect(resolveMailbox("  Antonio.Durante@TonyDurante.us  ", ALLOWED)).toBe("antonio.durante@tonydurante.us")
  })

  it("allows the support mailbox", () => {
    expect(resolveMailbox("support@tonydurante.us", ALLOWED)).toBe("support@tonydurante.us")
  })

  it("rejects a non-allow-listed mailbox (prompt-injection guard)", () => {
    expect(() => resolveMailbox("luca@tonydurante.us", ALLOWED)).toThrow(/not permitted/)
    expect(() => resolveMailbox("client@example.com", ALLOWED)).toThrow(/not permitted/)
  })
})

describe("allowedMailboxes", () => {
  it("defaults to support@ + Antonio's address when no env override", () => {
    const prev = process.env.GMAIL_WORKER_ALLOWED_MAILBOXES
    delete process.env.GMAIL_WORKER_ALLOWED_MAILBOXES
    expect(allowedMailboxes()).toEqual(["support@tonydurante.us", "antonio.durante@tonydurante.us"])
    if (prev !== undefined) process.env.GMAIL_WORKER_ALLOWED_MAILBOXES = prev
  })

  it("honors a comma-separated env override (normalized)", () => {
    const prev = process.env.GMAIL_WORKER_ALLOWED_MAILBOXES
    process.env.GMAIL_WORKER_ALLOWED_MAILBOXES = " Support@tonydurante.us , ops@tonydurante.us "
    expect(allowedMailboxes()).toEqual(["support@tonydurante.us", "ops@tonydurante.us"])
    if (prev === undefined) delete process.env.GMAIL_WORKER_ALLOWED_MAILBOXES
    else process.env.GMAIL_WORKER_ALLOWED_MAILBOXES = prev
  })

  it("DEFAULT_MAILBOX is support@", () => {
    expect(DEFAULT_MAILBOX).toBe("support@tonydurante.us")
  })
})
