import { describe, it, expect, vi, beforeEach } from "vitest"
import { hashInviteToken } from "@/lib/marketing/invite-rules"

const TOKEN = "T".repeat(43)
const TEAM = "11111111-1111-4111-8111-111111111111"
const future = () => new Date(Date.now() + 5 * 86_400_000).toISOString()

type Row = Record<string, unknown>
const state: { invites: Row[]; contact: Row | null; updates: Row[]; ilikeArgs: string[]; claimError: { message: string } | null; releaseError: { message: string } | null; onTeamRead: (() => void) | null } = { invites: [], contact: null, updates: [], ilikeArgs: [], claimError: null, releaseError: null, onTeamRead: null }
const gmailPost = vi.fn(async (..._a: unknown[]) => ({ id: "m1" }))

vi.mock("@/lib/gmail", () => ({ gmailPost: (...a: unknown[]) => gmailPost(...a) }))
vi.mock("@/lib/supabase-admin", () => {
  const builder = (table: string) => {
    const f: Record<string, unknown> = {}
    const b: Record<string, unknown> = {
      select: () => b,
      eq: (c: string, v: unknown) => { f[c] = v; return b },
      is: () => b,
      ilike: (_c: string, v: string) => { state.ilikeArgs.push(v); return b },
      limit: () => b,
      update: (patch: Row) => {
        state.updates.push(patch)
        const nullCols: string[] = []
        const chain: Record<string, unknown> = {
          eq: () => chain,
          is: (col: string) => { nullCols.push(col); return chain },
          // the claim: a conditional update that only changes a row where EVERY named column is still null (like the real database does)
          select: async () => {
            if (state.claimError) return { data: null, error: state.claimError }
            const row = state.invites.find(i => i.id === "i1")
            if (!row || nullCols.some(c => row[c] !== null && row[c] !== undefined)) return { data: [], error: null }
            Object.assign(row, patch)
            return { data: [{ id: "i1" }], error: null }
          },
          // the release (awaited right after .eq)
          then: (res: (v: unknown) => unknown) => {
            if (!state.releaseError) { const row = state.invites.find(i => i.id === "i1"); if (row) Object.assign(row, patch) }
            return res({ error: state.releaseError })
          },
        }
        return chain
      },
      maybeSingle: async () => {
        if (table === "marketing_invites") return { data: state.invites.find(i => i.token_hash === f.token_hash) ?? null }
        if (table === "marketing_teams") { state.onTeamRead?.(); return { data: { name: "Rocco's sales team" } } }
        if (table === "contacts") return { data: state.contact }
        return { data: null }
      },
    }
    return b
  }
  return { supabaseAdmin: { from: builder } }
})

import { previewInviteEmail, sendInviteEmail } from "@/lib/marketing/invite-email-server"

const invite = (over: Row = {}): Row => ({ id: "i1", team_id: TEAM, email_lower: "rocco@tonydurante.us", member_role: "member", token_hash: hashInviteToken(TOKEN), expires_at: future(), used_at: null, revoked_at: null, created_by: "antonio.durante@tonydurante.us", emailed_at: null, ...over })
const scope = { teamId: null, allowOwnerInvite: true, actorLabel: "antonio.durante@tonydurante.us" }

beforeEach(() => { state.invites = [invite()]; state.contact = null; state.updates = []; state.ilikeArgs = []; state.claimError = null; state.releaseError = null; state.onTeamRead = null; gmailPost.mockClear(); gmailPost.mockImplementation(async () => ({ id: "m1" })) })

describe("previewInviteEmail", () => {
  it("shows the exact email: to the invited address, from support, in Italian by default, with the app's own link", async () => {
    const r = await previewInviteEmail(TOKEN, scope)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.data.to).toBe("rocco@tonydurante.us")
      expect(r.data.from).toBe("support@tonydurante.us")
      expect(r.data.lang).toBe("it")
      expect(r.data.subject).toBe("Il tuo accesso a TD Marketing")
      expect(r.data.html).toContain(`/marketing/accept?token=${TOKEN}`)
      expect(r.data.html).toContain("Ciao Rocco,")
    }
    expect(gmailPost).not.toHaveBeenCalled()
  })
  it("Antonio's preview uses the language and first name of the invited person's CRM record", async () => {
    state.contact = { first_name: "Roccò", language: "English" }
    const r = await previewInviteEmail(TOKEN, scope)
    expect(r.ok && r.data.subject).toBe("Your access to TD Marketing")
    expect(r.ok && r.data.html).toContain("Hi Roccò,")
  })
  it("a team manager's preview NEVER reads the CRM: it cannot tell him that an address is a TD client", async () => {
    state.contact = { first_name: "Giovanni", language: "English" }
    const r = await previewInviteEmail(TOKEN, { teamId: TEAM, allowOwnerInvite: false, actorLabel: "rocco@x.us" })
    expect(r.ok).toBe(true)
    if (r.ok) { expect(r.data.lang).toBe("it"); expect(r.data.html).not.toContain("Giovanni"); expect(r.data.html).toContain("Ciao Rocco,") }
    expect(state.ilikeArgs).toHaveLength(0)
  })
  it("the person can choose the language of the email (it wins over the CRM)", async () => {
    state.contact = { first_name: "Roccò", language: "English" }
    const r = await previewInviteEmail(TOKEN, scope, "it")
    expect(r.ok && r.data.lang).toBe("it")
    expect(r.ok && r.data.subject).toBe("Il tuo accesso a TD Marketing")
    const bad = await previewInviteEmail(TOKEN, scope, "klingon")
    expect(bad.ok && bad.data.lang).toBe("en")
  })
  it("an address with a wildcard character (* % _ \\) is never looked up in the CRM", async () => {
    for (const email of ["ale_100@x.com", "a%b@x.com", "a*@x.com", "a\\b@x.com"]) {
      state.invites = [invite({ email_lower: email })]
      await previewInviteEmail(TOKEN, scope)
    }
    expect(state.ilikeArgs).toHaveLength(0)
  })
  it("refuses a token that is not the right shape, an unknown one, a used one, a revoked one and an expired one with the same plain answer", async () => {
    for (const t of ["short", null, 42, "Z".repeat(43)]) { const r = await previewInviteEmail(t, scope); expect(r.ok).toBe(false) }
    for (const over of [{ used_at: new Date().toISOString() }, { revoked_at: new Date().toISOString() }, { expires_at: new Date(Date.now() - 1000).toISOString() }]) {
      state.invites = [invite(over)]
      const r = await previewInviteEmail(TOKEN, scope)
      expect(r.ok).toBe(false)
    }
  })
  it("a team member's scope only reaches invitations of his own team", async () => {
    const r = await previewInviteEmail(TOKEN, { teamId: "22222222-2222-4222-8222-222222222222", allowOwnerInvite: false, actorLabel: "rocco@x.us" })
    expect(r.ok).toBe(false)
    const mine = await previewInviteEmail(TOKEN, { teamId: TEAM, allowOwnerInvite: false, actorLabel: "rocco@x.us" })
    expect(mine.ok).toBe(true)
  })
  it("an owner's invitation can only be emailed by Antonio's scope", async () => {
    state.invites = [invite({ member_role: "owner" })]
    const r = await previewInviteEmail(TOKEN, { teamId: TEAM, allowOwnerInvite: false, actorLabel: "rocco@x.us" })
    expect(r).toMatchObject({ ok: false, status: 403 })
    expect((await previewInviteEmail(TOKEN, scope)).ok).toBe(true)
  })
})

describe("sendInviteEmail", () => {
  it("claims the invitation, sends ONE email to the invited address only, and says who sent it", async () => {
    const r = await sendInviteEmail(TOKEN, scope)
    expect(r.ok).toBe(true)
    expect(gmailPost).toHaveBeenCalledTimes(1)
    const [endpoint, body] = gmailPost.mock.calls[0] as [string, { raw: string }]
    expect(endpoint).toBe("/messages/send")
    const mime = Buffer.from(body.raw, "base64url").toString("utf8")
    expect(mime).toContain("To: rocco@tonydurante.us")
    expect(mime).not.toContain("Subject: Il tuo")
    expect(state.updates).toHaveLength(1)
    expect(state.updates[0]).toMatchObject({ emailed_by: "antonio.durante@tonydurante.us" })
    expect(typeof state.updates[0].emailed_at).toBe("string")
  })
  it("sends in the language chosen", async () => {
    await sendInviteEmail(TOKEN, scope, "en")
    const body = gmailPost.mock.calls[0][1] as { raw: string }
    const mime = Buffer.from(body.raw, "base64url").toString("utf8")
    const subj = /Subject: =\?utf-8\?B\?([A-Za-z0-9+/=]+)\?=/.exec(mime)
    expect(Buffer.from(subj![1], "base64").toString("utf8")).toBe("Your access to TD Marketing")
  })
  it("two people pressing Send one after the other (or together): the invitation is sent ONCE, the second gets 409 and sends nothing", async () => {
    const first = await sendInviteEmail(TOKEN, scope)
    const second = await sendInviteEmail(TOKEN, scope)
    expect(first.ok).toBe(true)
    expect(second).toMatchObject({ ok: false, status: 409 })
    expect(gmailPost).toHaveBeenCalledTimes(1)
  })
  it("an invitation revoked in the instant between being read and being claimed is not emailed", async () => {
    state.onTeamRead = () => { state.invites[0].revoked_at = new Date().toISOString() }
    const r = await sendInviteEmail(TOKEN, scope)
    expect(r).toMatchObject({ ok: false, status: 409 })
    expect(gmailPost).not.toHaveBeenCalled()
  })
  it("before the database step (no emailed_at column) NOTHING is sent and the answer says why", async () => {
    state.claimError = { message: "column emailed_at does not exist" }
    const r = await sendInviteEmail(TOKEN, scope)
    expect(r).toMatchObject({ ok: false, status: 503 })
    expect(gmailPost).not.toHaveBeenCalled()
  })
  it("when the send fails the claim is released so it can be tried again, and the answer says nothing was sent", async () => {
    gmailPost.mockImplementationOnce(async () => { throw new Error("gmail down") })
    const r = await sendInviteEmail(TOKEN, scope)
    expect(r).toMatchObject({ ok: false, status: 502 })
    expect(state.updates).toHaveLength(2)
    expect(state.updates[1]).toMatchObject({ emailed_at: null, emailed_by: null })
    expect(state.invites[0].emailed_at).toBeNull()
  })
  it("when the send fails AND the claim cannot be given back, the answer says the invitation may show as emailed, and to make a new link", async () => {
    gmailPost.mockImplementationOnce(async () => { throw new Error("gmail down") })
    state.releaseError = { message: "db down" }
    const r = await sendInviteEmail(TOKEN, scope)
    expect(r.ok).toBe(false)
    expect(!r.ok && r.error).toMatch(/may now show as emailed.*new link/)
  })
  it("a refused scope sends nothing and claims nothing", async () => {
    const r = await sendInviteEmail(TOKEN, { teamId: "22222222-2222-4222-8222-222222222222", allowOwnerInvite: false, actorLabel: "x" })
    expect(r.ok).toBe(false)
    expect(gmailPost).not.toHaveBeenCalled()
    expect(state.updates).toHaveLength(0)
  })
})
