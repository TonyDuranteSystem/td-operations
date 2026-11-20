import { describe, it, expect } from "vitest"
import { takeAwayPortalAccess, givePortalAccess, type StaffAccessDeps, type StaffAccessLink } from "@/lib/members/staff-portal-access"

function fake(opts: {
  links: StaffAccessLink[]
  tier?: string | null
  info?: { fullName: string | null; email: string | null; language: string | null } | null
  hasLogin?: boolean
  createLogin?: { success: boolean; tempPassword?: string; error?: string }
  mail?: { success: boolean; error?: string }
  setMarkError?: string
  primary?: boolean
}) {
  const marks: Array<{ contactId: string; at: string | null; by: string | null }> = []
  const created: string[] = []
  const mails: Array<{ email: string; language: string; tempPassword: string }> = []
  const resyncs: string[] = []
  const d: StaffAccessDeps = {
    listLinks: async () => opts.links,
    setMark: async ({ contactId, at, by }) => { marks.push({ contactId, at, by }); return opts.setMarkError ? { error: opts.setMarkError } : {} },
    isPrimary: async () => opts.primary ?? false,
    accountTier: async () => opts.tier ?? "active",
    contactInfo: async () => (opts.info === undefined ? { fullName: "Bob B", email: "bob@x.com", language: "English" } : opts.info),
    hasLogin: async () => opts.hasLogin ?? false,
    createLogin: async ({ contactId }) => { created.push(contactId); return opts.createLogin ?? { success: true, tempPassword: "pw-1" } },
    sendWelcome: async (p) => { mails.push({ email: p.email, language: p.language, tempPassword: p.tempPassword }); return opts.mail ?? { success: true } },
    resyncTier: async (_a, reason) => { resyncs.push(reason) },
  }
  return { d, marks, created, mails, resyncs }
}

const open = (id: string): StaffAccessLink => ({ contact_id: id, access_revoked_at: null })
const marked = (id: string): StaffAccessLink => ({ contact_id: id, access_revoked_at: "2026-11-01T00:00:00Z" })

describe("takeAwayPortalAccess", () => {
  it("puts the mark on, with the team member's id, and recomputes the person's tier", async () => {
    const f = fake({ links: [open("a"), open("b")] })
    const r = await takeAwayPortalAccess({ accountId: "acc", contactId: "b", staffUserId: "staff-1", now: "2026-11-20T10:00:00Z" }, f.d)
    expect(r.success).toBe(true)
    expect(f.marks).toEqual([{ contactId: "b", at: "2026-11-20T10:00:00Z", by: "staff-1" }])
    expect(f.resyncs).toHaveLength(1)
    expect(r.message).toMatch(/stay an owner/i)
  })

  it("refuses to take away the last person who still has access", async () => {
    const f = fake({ links: [open("a"), marked("b")] })
    const r = await takeAwayPortalAccess({ accountId: "acc", contactId: "a", staffUserId: "s" }, f.d)
    expect(r.success).toBe(false)
    expect(r.error).toBe("last_person")
    expect(f.marks).toEqual([])
  })

  it("the primary contact is never taken away", async () => {
    const f = fake({ links: [open("a"), open("b")], primary: true })
    const r = await takeAwayPortalAccess({ accountId: "acc", contactId: "a", staffUserId: "s" }, f.d)
    expect(r.success).toBe(false)
    expect(r.error).toBe("primary")
    expect(r.message).toMatch(/primary contact/i)
    expect(f.marks).toEqual([])
  })

  it("a person who is already marked is left alone (no second write)", async () => {
    const f = fake({ links: [open("a"), marked("b")] })
    const r = await takeAwayPortalAccess({ accountId: "acc", contactId: "b", staffUserId: "s" }, f.d)
    expect(r.success).toBe(true)
    expect(f.marks).toEqual([])
  })

  it("a person who is not linked to the company is refused", async () => {
    const f = fake({ links: [open("a")] })
    const r = await takeAwayPortalAccess({ accountId: "acc", contactId: "zzz", staffUserId: "s" }, f.d)
    expect(r.success).toBe(false)
    expect(r.error).toBe("not_linked")
  })

  it("a database error is reported and the tier is not recomputed", async () => {
    const f = fake({ links: [open("a"), open("b")], setMarkError: "boom" })
    const r = await takeAwayPortalAccess({ accountId: "acc", contactId: "b", staffUserId: "s" }, f.d)
    expect(r.success).toBe(false)
    expect(r.error).toBe("boom")
    expect(f.resyncs).toEqual([])
  })
})

describe("givePortalAccess", () => {
  it("lifts the mark (whoever put it there) and, with no login yet, creates the login and sends the welcome email", async () => {
    const f = fake({ links: [open("a"), marked("b")] })
    const r = await givePortalAccess({ accountId: "acc", contactId: "b" }, f.d)
    expect(f.marks).toEqual([{ contactId: "b", at: null, by: null }])
    expect(f.created).toEqual(["b"])
    expect(f.mails).toEqual([{ email: "bob@x.com", language: "en", tempPassword: "pw-1" }])
    expect(r.login).toBe("created_and_emailed")
    expect(f.resyncs).toHaveLength(1)
  })

  it("the welcome email goes out in the person's own language, free text included", async () => {
    const f = fake({ links: [marked("b")], info: { fullName: "Bea", email: "bea@x.com", language: "Italiano" } })
    await givePortalAccess({ accountId: "acc", contactId: "b" }, f.d)
    expect(f.mails[0].language).toBe("it")
  })

  it("a person who already has a login only gets the mark lifted — no new login, no email", async () => {
    const f = fake({ links: [marked("b")], hasLogin: true })
    const r = await givePortalAccess({ accountId: "acc", contactId: "b" }, f.d)
    expect(r.login).toBe("already_had")
    expect(f.created).toEqual([])
    expect(f.mails).toEqual([])
  })

  it("team members who are not admins get the access lifted but no login is created and no email goes out", async () => {
    const f = fake({ links: [marked("b")] })
    const r = await givePortalAccess({ accountId: "acc", contactId: "b", canCreateLogin: false }, f.d)
    expect(r.success).toBe(true)
    expect(r.login).toBe("needs_admin")
    expect(f.marks).toEqual([{ contactId: "b", at: null, by: null }])
    expect(f.created).toEqual([])
    expect(f.mails).toEqual([])
  })

  it("a company still being formed: access is given, the login follows once the EIN is in", async () => {
    const f = fake({ links: [marked("b")], tier: "formation" })
    const r = await givePortalAccess({ accountId: "acc", contactId: "b" }, f.d)
    expect(r.success).toBe(true)
    expect(r.login).toBe("after_ein")
    expect(f.created).toEqual([])
    expect(f.mails).toEqual([])
  })

  it("a person with no email on file gets the access but no login", async () => {
    const f = fake({ links: [marked("b")], info: { fullName: "No Mail", email: null, language: null } })
    const r = await givePortalAccess({ accountId: "acc", contactId: "b" }, f.d)
    expect(r.login).toBe("no_email")
    expect(f.created).toEqual([])
  })

  it("an email that fails is reported, and the access and the login stay", async () => {
    const f = fake({ links: [marked("b")], mail: { success: false, error: "smtp down" } })
    const r = await givePortalAccess({ accountId: "acc", contactId: "b" }, f.d)
    expect(r.success).toBe(true)
    expect(r.login).toBe("created_email_failed")
    expect(r.message).toMatch(/smtp down/)
  })

  it("a login that cannot be created is reported, the access stays given", async () => {
    const f = fake({ links: [marked("b")], createLogin: { success: false, error: "nope" } })
    const r = await givePortalAccess({ accountId: "acc", contactId: "b" }, f.d)
    expect(r.success).toBe(true)
    expect(r.login).toBe("failed")
    expect(f.mails).toEqual([])
  })

  it("a person who is not marked is left alone", async () => {
    const f = fake({ links: [open("b")] })
    const r = await givePortalAccess({ accountId: "acc", contactId: "b" }, f.d)
    expect(r.success).toBe(true)
    expect(f.marks).toEqual([])
    expect(f.created).toEqual([])
  })
})
