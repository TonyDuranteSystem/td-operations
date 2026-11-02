/**
 * TD Marketing (dev job 9aec66fa): the workspace Team page (Rocco's screen). Antonio is the Owner above the team, not a "team owner" like Rocco, and a team owner's password is never reset from
 * this page (Antonio does that from the admin Teams page). The reset button stays for the people Rocco manages (his setters).
 */
import { describe, it, expect, vi } from "vitest"
import { createElement, type ComponentProps } from "react"
import { renderToStaticMarkup } from "react-dom/server"

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {}, push: () => {} }) }))

import { TeamManager } from "@/components/marketing/team-manager"
import { LangProvider } from "@/components/marketing/lang-provider"

type Member = ComponentProps<typeof TeamManager>["members"][number]
const ANTONIO: Member = { userId: "u-antonio", email: "antonio@example.test", role: "owner", bundle: null, permissions: [], status: "active", joinedAt: "2026-10-01T00:00:00Z", lastSignInAt: null, isAdmin: true }
const ROCCO: Member = { userId: "u-rocco", email: "rocco@example.test", role: "owner", bundle: null, permissions: [], status: "active", joinedAt: "2026-10-01T00:00:00Z", lastSignInAt: null, isAdmin: false }
const SETTER: Member = { userId: "u-setter", email: "setter@example.test", role: "member", bundle: null, permissions: [], status: "active", joinedAt: "2026-10-01T00:00:00Z", lastSignInAt: null }
const PAUSED_SETTER: Member = { ...SETTER, userId: "u-paused", email: "paused@example.test", status: "paused" }

function page(me: string, lang: "en" | "it" = "en", members: Member[] = [ANTONIO, ROCCO, SETTER]) {
  return renderToStaticMarkup(createElement(LangProvider, { lang } as ComponentProps<typeof LangProvider>, createElement(TeamManager, { me, iAmOwner: true, workspaceUrl: "https://app.example.test/marketing", roles: [], grantable: [], members, invites: [] })))
}
const resetFor = (html: string, email: string) => html.includes(`aria-label="Reset password for ${email}"`)

describe("Team page: reset buttons", () => {
  it("Antonio looking at Rocco's page gets NO reset on Rocco's row (the admin does it from the Teams page)", () => {
    const html = page(ANTONIO.userId)
    expect(resetFor(html, ROCCO.email)).toBe(false)
  })
  it("Rocco gets no reset on Antonio's row or on his own, only on his setter", () => {
    const html = page(ROCCO.userId)
    expect(resetFor(html, ANTONIO.email)).toBe(false)
    expect(resetFor(html, ROCCO.email)).toBe(false)
    expect(resetFor(html, SETTER.email)).toBe(true)
  })
  it("the setter keeps its reset for the manager, but a paused setter has none", () => {
    const html = page(ROCCO.userId, "en", [ANTONIO, ROCCO, SETTER, PAUSED_SETTER])
    expect(resetFor(html, SETTER.email)).toBe(true)
    expect(resetFor(html, PAUSED_SETTER.email)).toBe(false)
  })
})

describe("Team page: who is the Owner", () => {
  it("Antonio's row says Owner and Rocco's says Team owner", () => {
    const html = page(ROCCO.userId)
    const antonio = html.slice(html.indexOf(ANTONIO.email), html.indexOf(ROCCO.email))
    const rocco = html.slice(html.indexOf(ROCCO.email), html.indexOf(SETTER.email))
    expect(antonio).toContain(">Owner<")
    expect(antonio).not.toContain("Team owner")
    expect(rocco).toContain(">Team owner<")
  })
  it("in Italian: Proprietario for Antonio, Responsabile del team for Rocco", () => {
    const html = page(ROCCO.userId, "it")
    const antonio = html.slice(html.indexOf(ANTONIO.email), html.indexOf(ROCCO.email))
    const rocco = html.slice(html.indexOf(ROCCO.email), html.indexOf(SETTER.email))
    expect(antonio).toContain(">Proprietario<")
    expect(rocco).toContain(">Responsabile del team<")
  })
})
