import { describe, it, expect, vi, beforeEach } from "vitest"

/**
 * CAN THE PICKED TARGET ACTUALLY RECEIVE A PORTAL MESSAGE?
 *
 * Antonio, 2026-08-02: "before the send is allowed, check whether the chosen target
 * already has access to the system and if it accessed."
 *
 * Two real failures this replaces, both found on 2026-08-01/02:
 *
 *  - A LEAD was refused with "there's no portal chat to send to". FALSE. Sending an
 *    offer creates a portal login and hangs it on a CONTACT, so the same person shows
 *    in the picker twice — lead and contact — and the contact receives fine. Verified
 *    on the sandbox row: lead "Uxio Lead Test" and a contact with the same email, with
 *    a real auth user created 2026-04-20 carrying that contact's id.
 *
 *  - A CONTACT WITH NO PORTAL was fully sendable: Confirm succeeded, the card said
 *    "posted", and the person got a "you have a new message" email pointing at a
 *    portal they cannot open.
 */

const state = vi.hoisted(() => ({
  lead: null as Record<string, unknown> | null,
  contact: null as Record<string, unknown> | null,
  account: null as Record<string, unknown> | null,
  links: [] as Array<{ contact_id: string }>,
  contactsIn: [] as Array<{ full_name: string | null; email: string | null }>,
  contactIdByEmail: null as string | null,
  authUsers: {} as Record<string, { last_sign_in_at: string | null } | null>,
  authThrows: false,
}))

vi.mock("@/lib/supabase-admin", () => {
  const builder = (table: string) => {
    const b: Record<string, unknown> = {}
    b.from = () => b
    b.select = () => b
    b.eq = () => b
    b.in = () => b
    b.maybeSingle = async () => ({
      data: table === "leads" ? state.lead : table === "contacts" ? state.contact : state.account,
    })
    b.then = (res: (v: unknown) => void) =>
      Promise.resolve({ data: table === "account_contacts" ? state.links : state.contactsIn }).then(res)
    return b
  }
  return { supabaseAdmin: { from: (t: string) => builder(t) } }
})
vi.mock("@/lib/auth-admin-helpers", () => ({
  findAuthUserByEmail: async (email: string) => {
    if (state.authThrows) throw new Error('auth down')
    return state.authUsers[email.toLowerCase()] ?? null
  },
}))
vi.mock("@/lib/operations/find-contact-by-email", () => ({
  findContactIdByEmail: async () => state.contactIdByEmail,
}))

import { checkPortalReachability } from "@/lib/portal/recipient-reachability"

beforeEach(() => {
  state.lead = null
  state.contact = null
  state.account = null
  state.links = []
  state.contactsIn = []
  state.contactIdByEmail = null
  state.authUsers = {}
  state.authThrows = false
})

describe("a LEAD resolves to the person's contact — the refusal that was wrong", () => {
  it("is reachable when the lead's email has a contact WITH a portal login", async () => {
    state.lead = { email: "housedurante@icloud.com", full_name: "Uxio Lead Test" }
    state.contactIdByEmail = "contact-1"
    state.contact = { full_name: "Uxio Lead Test", email: "housedurante@icloud.com" }
    state.authUsers["housedurante@icloud.com"] = { last_sign_in_at: null }

    const r = await checkPortalReachability({ type: "lead", id: "lead-1" })
    expect(r.reachable).toBe(true)
    // Addressed to the CONTACT — that is where the portal login lives.
    if (r.reachable) expect(r.target).toEqual({ contactId: "contact-1" })
  })

  it("reports 'has access, never signed in' rather than blocking", async () => {
    // Access existing and never being used are different facts, and only the staff
    // member can judge whether that matters for this message.
    state.lead = { email: "a@b.com", full_name: "New Lead" }
    state.contactIdByEmail = "contact-1"
    state.contact = { full_name: "New Lead", email: "a@b.com" }
    state.authUsers["a@b.com"] = { last_sign_in_at: null }

    const r = await checkPortalReachability({ type: "lead", id: "lead-1" })
    expect(r.reachable).toBe(true)
    if (r.reachable) expect(r.neverSignedIn).toBe(true)
  })

  it("refuses a lead with no contact yet, and says WHY", async () => {
    state.lead = { email: "nobody@b.com", full_name: "Cold Lead" }
    state.contactIdByEmail = null
    const r = await checkPortalReachability({ type: "lead", id: "lead-1" })
    expect(r.reachable).toBe(false)
    if (!r.reachable) expect(r.reason).toMatch(/offer is sent/i)
  })
})

describe("a CONTACT with no portal login — the silent dead-end email", () => {
  it("REFUSES, because they would never see the message", async () => {
    state.contact = { full_name: "Spouse Of Client", email: "spouse@b.com" }
    state.authUsers = {} // no auth user
    const r = await checkPortalReachability({ type: "contact", id: "contact-9" })
    expect(r.reachable).toBe(false)
    if (!r.reachable) expect(r.reason).toMatch(/no portal login/i)
  })

  it("allows a contact who does have one, and surfaces their last sign-in", async () => {
    state.contact = { full_name: "Real Client", email: "real@b.com" }
    state.authUsers["real@b.com"] = { last_sign_in_at: "2026-07-01T10:00:00Z" }
    const r = await checkPortalReachability({ type: "contact", id: "contact-1" })
    expect(r.reachable).toBe(true)
    if (r.reachable) {
      expect(r.neverSignedIn).toBe(false)
      expect(r.recipients[0].lastSignInAt).toBe("2026-07-01T10:00:00Z")
    }
  })
})

describe("a COMPANY — every member sees it, so name them", () => {
  it("lists all members, because a company message reaches all of them", async () => {
    // Antonio's routing ruling: a company message is seen by every member. The card
    // must therefore show WHO that is before the send.
    state.account = { company_name: "LUMA Beauty Global LLC" }
    state.links = [{ contact_id: "c1" }, { contact_id: "c2" }]
    state.contactsIn = [
      { full_name: "Adam Mihaly", email: "adam@b.com" },
      { full_name: "Peter Marton Nemeskeri", email: "peter@b.com" },
    ]
    state.authUsers["adam@b.com"] = { last_sign_in_at: "2026-07-20T09:00:00Z" }
    state.authUsers["peter@b.com"] = null

    const r = await checkPortalReachability({ type: "account", id: "acct-1" })
    expect(r.reachable).toBe(true)
    if (r.reachable) {
      expect(r.recipients).toHaveLength(2)
      expect(r.recipients.find(x => x.name === "Peter Marton Nemeskeri")?.hasLogin).toBe(false)
      expect(r.neverSignedIn).toBe(false) // Adam has
    }
  })

  it("REFUSES when nobody at the company has a login", async () => {
    state.account = { company_name: "Dormant LLC" }
    state.links = [{ contact_id: "c1" }]
    state.contactsIn = [{ full_name: "Nobody", email: "nobody@b.com" }]
    state.authUsers = {}
    const r = await checkPortalReachability({ type: "account", id: "acct-1" })
    expect(r.reachable).toBe(false)
    if (!r.reachable) expect(r.reason).toMatch(/Nobody at Dormant LLC/i)
  })

  it("REFUSES a company with nobody linked to it at all", async () => {
    state.account = { company_name: "Empty LLC" }
    state.links = []
    const r = await checkPortalReachability({ type: "account", id: "acct-1" })
    expect(r.reachable).toBe(false)
    if (!r.reachable) expect(r.reason).toMatch(/nobody linked/i)
  })
})

describe("partners", () => {
  it("are refused with the real reason, not 'no longer exists'", async () => {
    const r = await checkPortalReachability({ type: "partner", id: "p1" })
    expect(r.reachable).toBe(false)
    if (!r.reachable) expect(r.reason).toMatch(/Partners don't have a portal chat/i)
  })
})

describe("a lookup failure must not read as 'no access'", () => {
  it("treats an auth-lookup error as access-present rather than blocking the send", async () => {
    // Blocking on an outage would be an invisible, total outage of client messaging —
    // every send refused, with a message saying the client has no portal.
    state.contact = { full_name: "Real Client", email: "boom@b.com" }
    state.authThrows = true
    const r = await checkPortalReachability({ type: "contact", id: "contact-1" })
    expect(r.reachable).toBe(true)
  })
})
