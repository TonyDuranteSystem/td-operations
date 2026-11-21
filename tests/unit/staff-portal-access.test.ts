import { describe, it, expect } from "vitest"
import { takeAwayPortalAccess, givePortalAccess, loginOpensLink, type StaffAccessDeps, type StaffAccessLink } from "@/lib/members/staff-portal-access"

type Info = { fullName: string | null; email: string | null; language: string | null }

function fake(opts: {
  links: StaffAccessLink[]
  /** What the database holds on the SECOND read of the links (right after the write), to simulate a click that landed in between. */
  linksAfterWrite?: StaffAccessLink[]
  tier?: string | null
  info?: Info | null
  /** Per-person info; falls back to `info`. */
  infoById?: Record<string, Info>
  hasLogin?: boolean
  /** Emails that already have a portal login (overrides `hasLogin`). */
  loginEmails?: string[]
  createLogin?: { success: boolean; tempPassword?: string; error?: string }
  mail?: { success: boolean; error?: string }
  setMarkError?: string
  primary?: boolean
  signer?: boolean
}) {
  const marks: Array<{ contactId: string; at: string | null; by: string | null }> = []
  const created: string[] = []
  const mails: Array<{ email: string; language: string; tempPassword: string }> = []
  const resyncs: string[] = []
  let reads = 0
  const defaultInfo: Info | null = opts.info === undefined ? { fullName: "Bob B", email: "bob@x.com", language: "English" } : opts.info
  const d: StaffAccessDeps = {
    listLinks: async () => { reads++; return reads > 1 && opts.linksAfterWrite ? opts.linksAfterWrite : opts.links },
    setMark: async ({ contactId, at, by }) => { marks.push({ contactId, at, by }); return opts.setMarkError ? { error: opts.setMarkError } : {} },
    isPrimary: async () => opts.primary ?? false,
    isSs4Signer: async () => opts.signer ?? false,
    accountTier: async () => opts.tier ?? "active",
    contactInfo: async (id) => opts.infoById?.[id] ?? defaultInfo,
    hasLogin: async (email) => (opts.loginEmails ? opts.loginEmails.includes(email) : (opts.hasLogin ?? false)),
    canSignIn: async (email) => (opts.loginEmails ? opts.loginEmails.includes(email) : (opts.hasLogin ?? false)),
    createLogin: async ({ contactId }) => { created.push(contactId); return opts.createLogin ?? { success: true, tempPassword: "pw-1" } },
    sendWelcome: async (p) => { mails.push({ email: p.email, language: p.language, tempPassword: p.tempPassword }); return opts.mail ?? { success: true } },
    resyncTier: async (_a, reason) => { resyncs.push(reason) },
  }
  return { d, marks, created, mails, resyncs }
}

const open = (id: string, by: string | null = null): StaffAccessLink => ({ contact_id: id, access_revoked_at: null, access_revoked_by: by })
const marked = (id: string): StaffAccessLink => ({ contact_id: id, access_revoked_at: "2026-11-01T00:00:00Z", access_revoked_by: null })

// Two people, "a" with a portal login and "b" without: the shape most of these rules are about.
const people = { infoById: { a: { fullName: "A", email: "a@x.com", language: null }, b: { fullName: "B", email: "b@x.com", language: null } }, loginEmails: ["a@x.com"] }

describe("takeAwayPortalAccess", () => {
  it("puts the mark on, with the team member's id, and recomputes the person's tier", async () => {
    const f = fake({ links: [open("a"), open("b")], ...people })
    const r = await takeAwayPortalAccess({ accountId: "acc", contactId: "b", staffUserId: "staff-1", now: "2026-11-20T10:00:00Z" }, f.d)
    expect(r.success).toBe(true)
    expect(f.marks).toEqual([{ contactId: "b", at: "2026-11-20T10:00:00Z", by: "staff-1" }])
    expect(f.resyncs).toHaveLength(1)
    expect(r.message).toMatch(/stay an owner/i)
  })

  it("refuses to take away the last person who still has access", async () => {
    const f = fake({ links: [open("a"), marked("b")], ...people })
    const r = await takeAwayPortalAccess({ accountId: "acc", contactId: "a", staffUserId: "s" }, f.d)
    expect(r.success).toBe(false)
    expect(r.error).toBe("last_person")
    expect(f.marks).toEqual([])
  })

  it("the primary contact is never taken away", async () => {
    const f = fake({ links: [open("a"), open("b")], primary: true, ...people })
    const r = await takeAwayPortalAccess({ accountId: "acc", contactId: "a", staffUserId: "s" }, f.d)
    expect(r.success).toBe(false)
    expect(r.error).toBe("primary")
    expect(r.message).toMatch(/primary contact/i)
    expect(f.marks).toEqual([])
  })

  it("a person who is already marked is left alone (no second write)", async () => {
    const f = fake({ links: [open("a"), marked("b")], ...people })
    const r = await takeAwayPortalAccess({ accountId: "acc", contactId: "b", staffUserId: "s" }, f.d)
    expect(r.success).toBe(true)
    expect(f.marks).toEqual([])
  })

  it("a person who is not linked to the company is refused", async () => {
    const f = fake({ links: [open("a")], ...people })
    const r = await takeAwayPortalAccess({ accountId: "acc", contactId: "zzz", staffUserId: "s" }, f.d)
    expect(r.success).toBe(false)
    expect(r.error).toBe("not_linked")
  })

  it("a database error is reported and the tier is not recomputed", async () => {
    const f = fake({ links: [open("a"), open("b")], setMarkError: "boom", ...people })
    const r = await takeAwayPortalAccess({ accountId: "acc", contactId: "b", staffUserId: "s" }, f.d)
    expect(r.success).toBe(false)
    expect(r.error).toBe("boom")
    expect(f.resyncs).toEqual([])
  })

  // ── QA 21 Nov 2026 ────────────────────────────────────────────────────────────────────────────────────────────────────
  it("the SS-4 signer is refused (they sign it in the portal)", async () => {
    const f = fake({ links: [open("a"), open("b")], signer: true, ...people })
    const r = await takeAwayPortalAccess({ accountId: "acc", contactId: "b", staffUserId: "s" }, f.d)
    expect(r.success).toBe(false)
    expect(r.error).toBe("signer")
    expect(r.message).toMatch(/SS-4 signer/)
    expect(f.marks).toEqual([])
  })

  it("refuses when the person who would still have access has no portal login (the company would be unreachable)", async () => {
    // "a" is open but has no login; taking "b" (the only one WITH a login) away leaves nobody who can get in.
    const f = fake({ links: [open("a"), open("b")], infoById: people.infoById, loginEmails: ["b@x.com"] })
    const r = await takeAwayPortalAccess({ accountId: "acc", contactId: "b", staffUserId: "s" }, f.d)
    expect(r.success).toBe(false)
    expect(r.error).toBe("nobody_can_open")
    expect(r.message).toMatch(/portal login/i)
    expect(f.marks).toEqual([])
  })

  it("a keeper with no email cannot open the company either", async () => {
    const f = fake({ links: [open("a"), open("b")], infoById: { a: { fullName: "A", email: null, language: null }, b: people.infoById.b }, loginEmails: ["b@x.com"] })
    const r = await takeAwayPortalAccess({ accountId: "acc", contactId: "b", staffUserId: "s" }, f.d)
    expect(r.error).toBe("nobody_can_open")
  })

  it("a company still being formed: a keeper with an email is enough (their login is made once the EIN is in)", async () => {
    const f = fake({ links: [open("a"), open("b")], tier: "formation", infoById: people.infoById, loginEmails: [] })
    const r = await takeAwayPortalAccess({ accountId: "acc", contactId: "b", staffUserId: "s" }, f.d)
    expect(r.success).toBe(true)
  })

  it("two clicks at the same moment: the second one is undone and says so, nothing is left half-done", async () => {
    // Read 1 (before the write): a and b open, a has a login. Read 2 (after the write): another click has marked a in between.
    const f = fake({ links: [open("a"), open("b")], linksAfterWrite: [marked("a"), open("b")], ...people })
    const r = await takeAwayPortalAccess({ accountId: "acc", contactId: "b", staffUserId: "s", now: "2026-11-21T10:00:00Z" }, f.d)
    expect(r.success).toBe(false)
    expect(r.error).toBe("race")
    expect(f.marks).toEqual([
      { contactId: "b", at: "2026-11-21T10:00:00Z", by: "s" },
      { contactId: "b", at: null, by: null }, // put back exactly as it was
    ])
    expect(f.resyncs).toEqual([])
  })

  it("an undone write puts back the team member who had decided on the link before", async () => {
    const f = fake({ links: [open("a"), open("b", "staff-old")], linksAfterWrite: [marked("a"), open("b", "staff-old")], ...people })
    await takeAwayPortalAccess({ accountId: "acc", contactId: "b", staffUserId: "s" }, f.d)
    expect(f.marks[1]).toEqual({ contactId: "b", at: null, by: "staff-old" })
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

  it("keeps the team member's id on the link, so the form's job never marks it again (QA 21 Nov 2026)", async () => {
    const f = fake({ links: [open("a"), marked("b")] })
    await givePortalAccess({ accountId: "acc", contactId: "b", staffUserId: "staff-9" }, f.d)
    expect(f.marks).toEqual([{ contactId: "b", at: null, by: "staff-9" }])
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

describe("loginOpensLink", () => {
  const future = new Date(Date.now() + 86400000).toISOString()
  const past = new Date(Date.now() - 86400000).toISOString()
  it("a login pointing at this contact opens their link", () => {
    expect(loginOpensLink({ app_metadata: { contact_id: "c1" } }, "c1")).toBe(true)
  })
  it("a login pointing at no contact (older logins) counts", () => {
    expect(loginOpensLink({ app_metadata: {} }, "c1")).toBe(true)
    expect(loginOpensLink({}, "c1")).toBe(true)
  })
  it("a shared login keyed to someone else does NOT open this person's link (co-members who share one email)", () => {
    expect(loginOpensLink({ app_metadata: { contact_id: "other" } }, "c1")).toBe(false)
  })
  it("no login, or a banned one, never counts", () => {
    expect(loginOpensLink(null, "c1")).toBe(false)
    expect(loginOpensLink({ banned_until: future, app_metadata: { contact_id: "c1" } }, "c1")).toBe(false)
    expect(loginOpensLink({ banned_until: past, app_metadata: { contact_id: "c1" } }, "c1")).toBe(true)
  })
})

describe("takeAwayPortalAccess hardening (Bug Hunter, QA 21 Nov 2026)", () => {
  it("a re-check that fails is undone, and the failure is reported", async () => {
    const f = fake({ links: [open("a"), open("b")], ...people })
    let calls = 0
    const base = f.d.listLinks
    f.d.listLinks = async (id) => { calls++; if (calls > 1) throw new Error("db down"); return base(id) }
    const r = await takeAwayPortalAccess({ accountId: "acc", contactId: "b", staffUserId: "s" }, f.d)
    expect(r.success).toBe(false)
    expect(r.error).toBe("check_failed")
    expect(f.marks[1]).toEqual({ contactId: "b", at: null, by: null }) // undone
  })

  it("when the undo itself fails, staff are told the truth, not 'nothing was changed'", async () => {
    const f = fake({ links: [open("a"), open("b")], linksAfterWrite: [marked("a"), open("b")], ...people })
    let writes = 0
    f.d.setMark = async () => { writes++; return writes > 1 ? { error: "write refused" } : {} }
    const r = await takeAwayPortalAccess({ accountId: "acc", contactId: "b", staffUserId: "s" }, f.d)
    expect(r.error).toBe("race")
    expect(r.message).toMatch(/could not be undone/)
    expect(r.message).not.toMatch(/nothing was changed/)
  })
})
