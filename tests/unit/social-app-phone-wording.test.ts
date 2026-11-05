/**
 * TD Social — what a lock screen may show (dev job 2072bc3e, Step 2 pull request C2). "Who, never what": only a direct or group message a person typed in TD Talk
 * with no client attached may show typed text; everything else is fixed words plus at most one cleaned name.
 */
import { describe, it, expect } from "vitest"
import { ALERT_KINDS, type AlertKind } from "@/lib/push/alert-kinds"
import { BODY_MAX, NAME_MAX, TITLE_MAX, phoneTabFor, phoneWording } from "@/lib/app/phone-wording"

const SECRET_TITLE = "Maria Rossi EIN 12-3456789"
const SECRET_BODY = "SSN 123-45-6789 balance $48,210.55 passport YA1234567"

const w = (kind: unknown, extra: Record<string, unknown> = {}) => phoneWording({ kind, title: SECRET_TITLE, body: SECRET_BODY, ...extra } as Parameters<typeof phoneWording>[0])

describe("the typed-text kind is the ONLY one that shows typed text", () => {
  it("a direct or group chat message shows its own title and text (cut, cleaned)", () => {
    expect(w("talk_direct_message")).toEqual({ title: SECRET_TITLE, body: SECRET_BODY })
    expect(phoneWording({ kind: "talk_direct_message", title: "Luca", body: "x".repeat(500) })!.body.length).toBeLessThanOrEqual(BODY_MAX)
    expect(phoneWording({ kind: "talk_direct_message", title: "T".repeat(500), body: "" })!.title.length).toBeLessThanOrEqual(TITLE_MAX)
  })

  it("EVERY other kind, whatever the web title and body say, shows neither of them (a sweep over the whole list)", () => {
    const allowedToQuoteTheSender: AlertKind[] = ["talk_direct_message", "supabase_notice"]
    for (const kind of ALERT_KINDS) {
      if (allowedToQuoteTheSender.includes(kind)) continue
      for (const dm of [true, false]) {
        const out = w(kind, { dm, name: "Acme LLC" })
        if (!out) continue
        const shown = `${out.title} ${out.body}`
        expect(shown, `${kind} (dm=${dm})`).not.toContain("12-3456789")
        expect(shown, `${kind} (dm=${dm})`).not.toContain("123-45-6789")
        expect(shown, `${kind} (dm=${dm})`).not.toContain("48,210")
        expect(shown, `${kind} (dm=${dm})`).not.toContain("YA1234567")
        expect(shown, `${kind} (dm=${dm})`).not.toContain("Maria")
      }
    }
  })

  it("the system notice shows its own system-written text (it is not typed by a person or a client)", () => {
    expect(phoneWording({ kind: "supabase_notice", title: "Supabase is slow", body: "Region us-east-1" })).toEqual({ title: "Supabase is slow", body: "Region us-east-1" })
  })
})

describe("who gets a phone alert at all", () => {
  it("channel and topic messages never go to a phone", () => {
    expect(w("talk_room_message")).toBeNull()
    expect(w("talk_room_message", { dm: true })).toBeNull()
  })

  it("Claude's replies and shared items go only when they are a direct or group chat message", () => {
    expect(w("claude_reply", { dm: false })).toBeNull()
    expect(w("claude_reply", { dm: true })).toEqual({ title: "Claude replied", body: "" })
    expect(w("shared_item", { dm: false, name: "Luca" })).toBeNull()
    expect(w("shared_item", { dm: true, name: "Luca" })).toEqual({ title: "Luca shared something with you", body: "" })
    expect(w("shared_item", { dm: true })).toEqual({ title: "Something was shared with you", body: "" })
  })

  it("the fixed-word kinds go regardless of dm", () => {
    for (const dm of [true, false]) {
      expect(w("client_thread_message", { dm })).toEqual({ title: "New message in a client chat", body: "" })
      expect(w("staff_note", { dm })).toEqual({ title: "New staff note", body: "" })
      expect(w("approval", { dm })).toEqual({ title: "A proposal needs a decision", body: "" })
      expect(w("test_alert", { dm })).toEqual({ title: "Test notification", body: "Alerts are working." })
      expect(w("general_notification", { dm })).toEqual({ title: "New notification", body: "" })
    }
  })

  it("a client chat shows the company, or 'a client' when there is none", () => {
    expect(w("client_chat", { name: "Acme LLC" })).toEqual({ title: "Chat: Acme LLC", body: "" })
    expect(w("client_chat")).toEqual({ title: "Chat: a client", body: "" })
    expect(w("client_chat", { name: "   " })).toEqual({ title: "Chat: a client", body: "" })
  })

  it("a kind that is not on the list (a typo, a future kind, a non-string) shows 'New notification'", () => {
    for (const kind of ["made_up", "", "CLIENT_CHAT", undefined, null, 5, {}]) {
      expect(w(kind)).toEqual({ title: "New notification", body: "" })
    }
  })
})

describe("Marketing is in Italian, with the lead's name and no text", () => {
  it("each kind has its wording, with or without a name", () => {
    expect(w("marketing_lead_chat", { name: "Giulia Bianchi" })).toEqual({ title: "Nuovo messaggio · Giulia Bianchi", body: "" })
    expect(w("marketing_lead_chat")).toEqual({ title: "Nuovo messaggio", body: "" })
    expect(w("marketing_team_chat", { name: "Rocco" })).toEqual({ title: "Nuovo messaggio da Rocco", body: "" })
    expect(w("marketing_team_chat")).toEqual({ title: "Nuovo messaggio nel team", body: "" })
    expect(w("marketing_lead_moved", { name: "Giulia" })).toEqual({ title: "Chiamata spostata · Giulia", body: "" })
    expect(w("marketing_call")).toEqual({ title: "Nuova chiamata", body: "" })
    expect(w("marketing_news", { name: "ignored" })).toEqual({ title: "Novità in TD Marketing", body: "" })
  })
})

describe("names are never trusted as typed", () => {
  // built from numbers so no invisible character sits in this file
  const c = (...codes: number[]) => String.fromCharCode(...codes)

  it("control characters, line breaks and direction marks are removed, and the name is cut by whole characters", () => {
    const hostile = `Acme${c(0x202e)}${c(10)}LLC${c(0x200b)}${c(0)}`
    expect(w("client_chat", { name: hostile })).toEqual({ title: "Chat: Acme LLC", body: "" })
    const long = "😀".repeat(NAME_MAX + 20)
    const out = w("client_chat", { name: long })!
    expect(Array.from(out.title.replace("Chat: ", "")).length).toBe(NAME_MAX)
    expect(out.title).not.toContain("�")
  })

  it("a name that is not text is ignored", () => {
    for (const name of [5, {}, [], true]) expect(w("client_chat", { name })).toEqual({ title: "Chat: a client", body: "" })
  })
})

describe("which tab an alert belongs to (a muted tab sends no phone alert)", () => {
  it("maps each kind to its tab, or none", () => {
    expect(phoneTabFor("talk_direct_message")).toBe("talk")
    expect(phoneTabFor("claude_reply")).toBe("talk")
    expect(phoneTabFor("shared_item")).toBe("talk")
    expect(phoneTabFor("client_chat")).toBe("portal")
    expect(phoneTabFor("client_thread_message")).toBe("portal")
    for (const k of ["marketing_lead_chat", "marketing_team_chat", "marketing_lead_moved", "marketing_call", "marketing_news"] as const) expect(phoneTabFor(k)).toBe("marketing")
    for (const k of ["staff_note", "approval", "supabase_notice", "test_alert", "general_notification", "talk_room_message"] as const) expect(phoneTabFor(k)).toBeNull()
  })
})
