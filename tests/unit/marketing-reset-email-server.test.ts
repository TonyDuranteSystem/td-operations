/**
 * TD Marketing (dev job 9aec66fa): emailing a password-reset link made on the admin Teams page. The recipient is always the login the link was made for, the exact email is shown before it is sent,
 * only a link made on the Teams page (not a person's own "Forgot password?" link) can be emailed from here, and a failed send says nothing was sent.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
import { hashInviteToken } from "@/lib/marketing/invite-rules"
import { buildResetEmail } from "@/lib/marketing/reset-email"

const TOKEN = "T".repeat(43)
const future = () => new Date(Date.now() + 20 * 3_600_000).toISOString()
type Row = Record<string, unknown>
const state: { row: Row | null; readError: { message: string } | null; contact: Row | null; ilike: string[]; eq: Array<[string, unknown]> } = { row: null, readError: null, contact: null, ilike: [], eq: [] }
const gmailPost = vi.fn(async (..._a: unknown[]) => ({ id: "m1" }))

vi.mock("@/lib/gmail", () => ({ gmailPost: (...a: unknown[]) => gmailPost(...a) }))
vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      const b: Record<string, unknown> = {
        select: () => b,
        eq: (c: string, v: unknown) => { state.eq.push([c, v]); return b },
        ilike: (_c: string, v: string) => { state.ilike.push(v); return b },
        limit: () => b,
        maybeSingle: async () => table === "marketing_password_resets" ? { data: state.row, error: state.readError } : { data: state.contact, error: null },
      }
      return b
    },
  },
}))

import { previewResetEmail, sendResetEmail } from "@/lib/marketing/reset-email-server"

const openRow = (over: Row = {}): Row => ({ id: "r1", email_lower: "rocco@example.test", requested_by: "antonio@example.test", used_at: null, revoked_at: null, expires_at: future(), ...over })
const raw = () => Buffer.from(String((gmailPost.mock.calls[0][1] as { raw: string }).raw), "base64url").toString("utf8")

beforeEach(() => { state.row = openRow(); state.readError = null; state.contact = null; state.ilike = []; state.eq = []; gmailPost.mockClear(); gmailPost.mockImplementation(async () => ({ id: "m1" })) })

describe("previewResetEmail", () => {
  it("shows the exact email, to the login's own address, with the link rebuilt from the app's address and the token", async () => {
    const r = await previewResetEmail(TOKEN, "antonio@example.test")
    expect(r.ok).toBe(true)
    if (r.ok === false) return
    expect(r.data.to).toBe("rocco@example.test")
    expect(r.data.from).toBe("support@tonydurante.us")
    expect(r.data.replyTo).toBe("antonio@example.test")
    expect(r.data.lang).toBe("it")
    expect(r.data.html).toContain(`/marketing/reset?token=${TOKEN}`)
    expect(state.eq).toContainEqual(["token_hash", hashInviteToken(TOKEN)])
  })
  it("says who made the link (not 'you asked'), by the maker's first name", async () => {
    const r = await previewResetEmail(TOKEN, "antonio@example.test", "en")
    expect(r.ok).toBe(true)
    if (r.ok === false) return
    expect(r.data.lang).toBe("en")
    expect(r.data.html).toContain("Antonio made a link for you")
    expect(r.data.html).not.toContain("You asked")
  })
  it("the language follows the CRM contact when there is one (R109), and the name too", async () => {
    state.contact = { first_name: "Rocco", language: "English" }
    const r = await previewResetEmail(TOKEN, "antonio@example.test")
    expect(r.ok).toBe(true)
    if (r.ok === false) return
    expect(r.data.lang).toBe("en")
    expect(r.data.html).toContain("Hi Rocco,")
  })
  it("no reply-to when the maker is the recipient himself", async () => {
    const r = await previewResetEmail(TOKEN, "rocco@example.test")
    expect(r.ok).toBe(true)
    if (r.ok === false) return
    expect(r.data.replyTo).toBeNull()
  })
  it("a person's own Forgot-password link is never emailed from here", async () => {
    state.row = openRow({ requested_by: "self" })
    const r = await previewResetEmail(TOKEN, "antonio@example.test")
    expect(r.ok).toBe(false)
  })
  it.each([["used", { used_at: new Date().toISOString() }], ["cancelled", { revoked_at: new Date().toISOString() }], ["expired", { expires_at: new Date(Date.now() - 1000).toISOString() }]])("a %s link is no longer open (400)", async (_n, over) => {
    state.row = openRow(over as Row)
    const r = await previewResetEmail(TOKEN, "antonio@example.test")
    expect(r).toMatchObject({ ok: false, status: 400, error: "This link is no longer open. Make a new one." })
  })
  it("an unknown link is no longer open too", async () => {
    state.row = null
    expect(await previewResetEmail(TOKEN, "antonio@example.test")).toMatchObject({ ok: false, status: 400 })
  })
  it.each([undefined, null, "", "short", 42, "x".repeat(300)])("a token of %j is refused before anything is read", async t => {
    const r = await previewResetEmail(t, "antonio@example.test")
    expect(r).toMatchObject({ ok: false, status: 400 })
    expect(state.eq).toHaveLength(0)
  })
  it("a database read error is a 502 that says to try again", async () => {
    state.readError = { message: "boom" }
    expect(await previewResetEmail(TOKEN, "antonio@example.test")).toMatchObject({ ok: false, status: 502 })
  })
  it("an address with a wildcard character is never looked up in the CRM", async () => {
    state.row = openRow({ email_lower: "ro_cco@example.test" })
    await previewResetEmail(TOKEN, "antonio@example.test")
    expect(state.ilike).toHaveLength(0)
  })
})

describe("sendResetEmail", () => {
  it("sends one email to the login's address with an encoded subject, and nothing else is stored", async () => {
    const r = await sendResetEmail(TOKEN, "antonio@example.test", "en")
    expect(r).toMatchObject({ ok: true, data: { to: "rocco@example.test", from: "support@tonydurante.us" } })
    expect(gmailPost).toHaveBeenCalledTimes(1)
    const mime = raw()
    expect(mime).toMatch(/^To: rocco@example\.test/m)
    expect(mime).toMatch(/^Reply-To: antonio@example\.test/m)
    const enc = /^Subject: =\?utf-8\?B\?([A-Za-z0-9+/=]+)\?=/m.exec(mime)
    expect(enc).not.toBeNull()
    expect(Buffer.from(enc![1], "base64").toString("utf8")).toBe("Choose a new password for TD Marketing")
  })
  it("a link that is no longer open sends nothing", async () => {
    state.row = openRow({ used_at: new Date().toISOString() })
    expect(await sendResetEmail(TOKEN, "antonio@example.test")).toMatchObject({ ok: false, status: 400 })
    expect(gmailPost).not.toHaveBeenCalled()
  })
  it("a person's own Forgot link sends nothing", async () => {
    state.row = openRow({ requested_by: "self" })
    expect((await sendResetEmail(TOKEN, "antonio@example.test")).ok).toBe(false)
    expect(gmailPost).not.toHaveBeenCalled()
  })
  it("when Gmail fails the answer says nothing was sent (502) and the link is untouched", async () => {
    gmailPost.mockRejectedValueOnce(new Error("gmail 500"))
    const r = await sendResetEmail(TOKEN, "antonio@example.test")
    expect(r).toMatchObject({ ok: false, status: 502 })
    if (r.ok === false) expect(r.error).toMatch(/Nothing was sent/)
  })
})

describe("buildResetEmail (the words)", () => {
  const base = { toName: "Rocco", link: "https://app.example/marketing/reset?token=abc", expiresAt: "2026-11-03T00:00:00.000Z" }
  it("the person's own request keeps its words ('You asked')", () => {
    const m = buildResetEmail({ ...base, lang: "en" })
    expect(m.html).toContain("You asked to change the password")
    expect(m.html).toContain("If it was not you, ignore this email")
  })
  it("a link made by Antonio says who made it, in both languages", () => {
    const en = buildResetEmail({ ...base, lang: "en", kind: "owner", senderName: "Antonio" })
    expect(en.html).toContain("Antonio made a link for you to choose a new password")
    expect(en.html).toContain("If you did not expect this, ignore this email")
    const it = buildResetEmail({ ...base, lang: "it", kind: "owner", senderName: "Antonio" })
    expect(it.html).toContain("Antonio ti ha preparato un link")
    expect(it.html).toContain("Se non te lo aspettavi")
  })
  it("a blank sender name falls back to Antonio, and the link is escaped", () => {
    const m = buildResetEmail({ ...base, lang: "en", kind: "owner", senderName: "  ", link: 'https://x/"><script>' })
    expect(m.html).toContain("Antonio made a link")
    expect(m.html).not.toContain("<script>")
  })
})
