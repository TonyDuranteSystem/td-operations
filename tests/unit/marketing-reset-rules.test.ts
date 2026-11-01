/**
 * TD Marketing password reset (dev job 9aec66fa): the pure rules and the email text. Each rule is a way a reset link could be turned into taking over a login that is not a team member's.
 */
import { describe, it, expect } from "vitest"
import {
  FORGOT_ANSWER, GENERIC_RESET_ERROR, MAX_OWNER_RESETS_PER_HOUR, MAX_SELF_REQUESTS_PER_HOUR, RESET_TTL_OWNER_MS, RESET_TTL_SELF_MS,
  eligibleForForgot, mayResetMember, overOwnerLimit, overSelfLimit, resetExpiry, resetUrl,
} from "@/lib/marketing/reset-rules"
import { buildResetEmail } from "@/lib/marketing/reset-email"
import { buildInviteMime } from "@/lib/marketing/invite-email"

const base = {
  actorKind: "owner" as const, actorUserId: "owner-1", targetUserId: "member-1",
  targetAuthRole: "marketing", targetBanned: false, targetMemberRole: "member" as const, targetStatus: "active",
}

describe("mayResetMember", () => {
  it("an owner may make a link for an active member", () => {
    expect(mayResetMember(base)).toEqual({ ok: true })
  })
  it("never for yourself", () => {
    const r = mayResetMember({ ...base, targetUserId: "owner-1" })
    expect(r.ok).toBe(false)
  })
  it("never for a login that is not a marketing login (Antonio's own CRM login can be a member)", () => {
    for (const role of ["admin", "team", "client", "partner", undefined, null, ""]) {
      expect(mayResetMember({ ...base, targetAuthRole: role }).ok, String(role)).toBe(false)
    }
  })
  it("not for someone who is not on the team, was removed, or is paused", () => {
    expect(mayResetMember({ ...base, targetMemberRole: null, targetStatus: null }).ok).toBe(false)
    expect(mayResetMember({ ...base, targetStatus: "removed" }).ok).toBe(false)
    const paused = mayResetMember({ ...base, targetStatus: "paused" })
    expect(paused.ok).toBe(false)
    expect(paused.ok === false && paused.error).toMatch(/Resume/)
  })
  it("not for a closed (banned) login", () => {
    expect(mayResetMember({ ...base, targetBanned: true }).ok).toBe(false)
  })
  it("a team owner's link is made only by Antonio", () => {
    expect(mayResetMember({ ...base, targetMemberRole: "owner" }).ok).toBe(false)
    expect(mayResetMember({ ...base, actorKind: "member", targetMemberRole: "owner" }).ok).toBe(false)
    expect(mayResetMember({ ...base, actorKind: "admin", actorUserId: "antonio", targetMemberRole: "owner" })).toEqual({ ok: true })
  })
})

describe("eligibleForForgot", () => {
  const ok = { authRole: "marketing", banned: false, memberStatus: "active", teamStatus: "active" }
  it("a marketing login, active member, active team", () => expect(eligibleForForgot(ok)).toBe(true))
  it("any other kind of login, a paused/removed member, a switched-off team or a closed login gets nothing", () => {
    for (const authRole of ["client", "admin", "team", "partner", undefined]) expect(eligibleForForgot({ ...ok, authRole }), String(authRole)).toBe(false)
    expect(eligibleForForgot({ ...ok, memberStatus: "paused" })).toBe(false)
    expect(eligibleForForgot({ ...ok, memberStatus: "removed" })).toBe(false)
    expect(eligibleForForgot({ ...ok, memberStatus: null })).toBe(false)
    expect(eligibleForForgot({ ...ok, teamStatus: "paused" })).toBe(false)
    expect(eligibleForForgot({ ...ok, banned: true })).toBe(false)
  })
})

describe("limits, expiry and the link", () => {
  it("a self-asked link lasts an hour, an owner-made one a day", () => {
    const now = new Date("2026-11-01T12:00:00.000Z")
    expect(new Date(resetExpiry(now, "self")).getTime() - now.getTime()).toBe(RESET_TTL_SELF_MS)
    expect(new Date(resetExpiry(now, "owner")).getTime() - now.getTime()).toBe(RESET_TTL_OWNER_MS)
    expect(RESET_TTL_SELF_MS).toBe(3600000)
    expect(RESET_TTL_OWNER_MS).toBe(86400000)
  })
  it("hourly limits", () => {
    expect(overSelfLimit(MAX_SELF_REQUESTS_PER_HOUR - 1)).toBe(false)
    expect(overSelfLimit(MAX_SELF_REQUESTS_PER_HOUR)).toBe(true)
    expect(overOwnerLimit(MAX_OWNER_RESETS_PER_HOUR - 1)).toBe(false)
    expect(overOwnerLimit(MAX_OWNER_RESETS_PER_HOUR)).toBe(true)
  })
  it("the link is built from the app's own address and the token", () => {
    expect(resetUrl("https://app.example", "TOK")).toBe("https://app.example/marketing/reset?token=TOK")
  })
  it("the answers do not reveal anything", () => {
    expect(FORGOT_ANSWER).toMatch(/^If this email belongs/)
    expect(GENERIC_RESET_ERROR).not.toMatch(/expired|revoked|already|not found|no such/i)
  })
})

describe("buildResetEmail", () => {
  const input = { lang: "it" as const, toName: "Rocco", link: "https://app.example/marketing/reset?token=abc_DEF-1", expiresAt: "2026-11-01T13:00:00.000Z" }
  it("Italian: subject, greeting, button text, link once in each part, and the 'not you' line", () => {
    const m = buildResetEmail(input)
    expect(m.subject).toBe("Scegli una nuova password per TD Marketing")
    expect(m.text).toContain("Ciao Rocco,")
    expect(m.text.split(input.link)).toHaveLength(2)
    expect(m.html).toContain(`href="${input.link}"`)
    expect(m.text).toMatch(/Se non sei stato tu, ignora questa email/)
  })
  it("English version", () => {
    const m = buildResetEmail({ ...input, lang: "en", toName: null })
    expect(m.subject).toBe("Choose a new password for TD Marketing")
    expect(m.text.startsWith("Hi,")).toBe(true)
    expect(m.text).toMatch(/If it was not you, ignore this email/)
  })
  it("a name with markup cannot inject HTML", () => {
    const m = buildResetEmail({ ...input, toName: "<img src=x onerror=alert(1)>" })
    expect(m.html).not.toContain("<img")
  })
  it("the finished message has an RFC 2047 subject (R041) and the link only in the body", () => {
    const mime = buildInviteMime("rocco@tonydurante.us", buildResetEmail(input), "b", null)
    expect(mime).toMatch(/^Subject: =\?utf-8\?B\?/m)
    expect(mime).not.toContain("Subject: Scegli")
    expect(mime).toContain("To: rocco@tonydurante.us")
  })
})
