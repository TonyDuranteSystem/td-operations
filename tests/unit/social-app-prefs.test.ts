/**
 * TD Social — the alert switches (dev job 2072bc3e, Step 2 pull request B). Defaults are RULES (not names), only real things can be switched,
 * and a request is checked key by key.
 */
import { describe, it, expect, vi } from "vitest"

vi.mock("@/lib/supabase/server", () => ({ createClient: () => ({ auth: { getUser: async () => ({ data: { user: null } }) } }) }))

import { effectivePrefs, parsePrefsPatch, emailKey, MAX_PREF_KEYS } from "@/lib/app/prefs"
import { tabsFor, type AppIdentity } from "@/lib/app/tabs"

const who = (o: Partial<AppIdentity>): AppIdentity => ({ authRole: "", isAdmin: false, isStaff: false, marketingChat: false, ...o })
const adminTabs = tabsFor(who({ authRole: "admin", isAdmin: true, isStaff: true, marketingChat: true }))
const teamTabs = tabsFor(who({ authRole: "team", isStaff: true }))
const marketingTabs = tabsFor(who({ authRole: "marketing", marketingChat: true }))

describe("effectivePrefs: the defaults are rules", () => {
  it("a person who sees TWO mailboxes gets email alerts on neither by default; WhatsApp is on", () => {
    expect(effectivePrefs(adminTabs, null)).toEqual({ mutedTabs: [], whatsapp: true, email: { support: false, antonio: false } })
  })

  it("a person whose ONLY mailbox is support gets its email alerts on by default", () => {
    expect(effectivePrefs(teamTabs, null)).toEqual({ mutedTabs: [], whatsapp: true, email: { support: true } })
  })

  it("a marketing login has no WhatsApp or email switch at all", () => {
    expect(effectivePrefs(marketingTabs, null)).toEqual({ mutedTabs: [] })
  })

  it("a stored override beats the default, in either direction, key by key", () => {
    const p = effectivePrefs(adminTabs, { alerts: { whatsapp: false, [emailKey("support")]: true } })
    expect(p.whatsapp).toBe(false)
    expect(p.email).toEqual({ support: true, antonio: false })
    const t = effectivePrefs(teamTabs, { alerts: { [emailKey("support")]: false } })
    expect(t.email).toEqual({ support: false })
  })

  it("only tabs the person really has can be muted; duplicates collapse; the list is sorted", () => {
    const p = effectivePrefs(teamTabs, { muted_tabs: ["portal", "marketing", "talk", "portal", "nonsense"] })
    expect(p.mutedTabs).toEqual(["portal", "talk"])
  })

  it("garbage in storage is ignored, never trusted", () => {
    const p = effectivePrefs(adminTabs, { alerts: { whatsapp: "no", [emailKey("support")]: 1, [emailKey("antonio")]: null }, muted_tabs: null })
    expect(p).toEqual({ mutedTabs: [], whatsapp: true, email: { support: false, antonio: false } })
  })

  it("a person with no tab has nothing to switch", () => {
    expect(effectivePrefs([], { muted_tabs: ["talk"], alerts: { whatsapp: false } })).toEqual({ mutedTabs: [] })
  })
})

describe("parsePrefsPatch: a request is checked key by key", () => {
  it("accepts muting a tab, unmuting another and two alert switches", () => {
    const r = parsePrefsPatch({ mute: { talk: true, portal: false }, alerts: { whatsapp: false, [emailKey("support")]: true } }, teamTabs)
    expect(r).toEqual({ ok: true, value: { mute: { talk: true, portal: false }, alerts: { whatsapp: false, "email:support": true } } })
  })

  it("accepts one section on its own", () => {
    expect(parsePrefsPatch({ mute: { talk: true } }, teamTabs).ok).toBe(true)
    expect(parsePrefsPatch({ alerts: { whatsapp: true } }, teamTabs).ok).toBe(true)
  })

  it("refuses a tab the person does not have", () => {
    const r = parsePrefsPatch({ mute: { marketing: true } }, teamTabs)
    expect(r.ok).toBe(false)
    if (r.ok === false) expect(r.code).toBe("NOT_ALLOWED")
  })

  it("refuses a mailbox the person may not open (staff 'team' and antonio@)", () => {
    const r = parsePrefsPatch({ alerts: { [emailKey("antonio")]: true } }, teamTabs)
    expect(r.ok).toBe(false)
    expect(parsePrefsPatch({ alerts: { [emailKey("antonio")]: true } }, adminTabs).ok).toBe(true)
  })

  it("refuses a WhatsApp or email switch for a login without that tab", () => {
    expect(parsePrefsPatch({ alerts: { whatsapp: true } }, marketingTabs).ok).toBe(false)
    expect(parsePrefsPatch({ alerts: { [emailKey("support")]: true } }, marketingTabs).ok).toBe(false)
  })

  it("refuses unknown fields, wrong shapes and values that are not true / false", () => {
    for (const body of [null, undefined, "x", 5, [], { mute: [] }, { mute: "talk" }, { alerts: [true] }, { other: {} },
      { mute: { talk: "yes" } }, { mute: { talk: 1 } }, { alerts: { whatsapp: null } }, { alerts: { whatsapp: "true" } }]) {
      expect(parsePrefsPatch(body, teamTabs).ok, JSON.stringify(body)).toBe(false)
    }
  })

  it("refuses an empty request (a typo must not silently do nothing)", () => {
    for (const body of [{}, { mute: {} }, { alerts: {} }, { mute: {}, alerts: {} }]) {
      const r = parsePrefsPatch(body, teamTabs)
      expect(r.ok).toBe(false)
      if (r.ok === false) expect(r.code).toBe("EMPTY")
    }
  })

  it("refuses a request with too many keys", () => {
    const many = Object.fromEntries(Array.from({ length: MAX_PREF_KEYS + 1 }, (_, i) => [`k${i}`, true]))
    const r = parsePrefsPatch({ alerts: many }, teamTabs)
    expect(r.ok).toBe(false)
  })

  it("a prototype-pollution style key is just an unknown key", () => {
    const r = parsePrefsPatch(JSON.parse('{"mute":{"__proto__":true}}'), teamTabs)
    expect(r.ok).toBe(false)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  it("echoes only what was asked, with strict booleans", () => {
    const r = parsePrefsPatch({ mute: { talk: true } }, teamTabs)
    expect(r.ok && Object.keys(r.value.alerts)).toEqual([])
  })
})
