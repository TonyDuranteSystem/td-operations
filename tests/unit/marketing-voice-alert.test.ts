import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import {
  VOICE_BASELINE_BACK_MS, VOICE_MAX_AGE_MS, VOICE_MAX_PHRASES, VOICE_SPOKEN_KEEP, baselineFrom, firstNameOf, notSpokenYet, parseSpoken, rememberSpoken, sinceFrom, voicePhrases,
} from "@/lib/marketing/voice-alert"

// Antonio, 29 Oct 2026: "I want notification with sound for new messages. The sound must say Message from Rocco."

describe("what the voice says", () => {
  it("'Message from Rocco' for a message from Rocco", () => {
    expect(voicePhrases([{ sender: "Rocco" }])).toEqual(["Message from Rocco"])
  })
  it("uses the first name only", () => {
    expect(firstNameOf("Antonio Durante")).toBe("Antonio")
    expect(voicePhrases([{ sender: "Cristina Rossi" }])).toEqual(["Message from Cristina"])
  })
  it("one phrase per person, not one per message, in the order they wrote", () => {
    expect(voicePhrases([{ sender: "Rocco" }, { sender: "Cristina" }, { sender: "Rocco" }, { sender: "Rocco" }])).toEqual(["Message from Rocco", "Message from Cristina"])
  })
  it("never more than a few phrases at once", () => {
    const many = ["A", "B", "C", "D", "E"].map(sender => ({ sender }))
    expect(voicePhrases(many)).toHaveLength(VOICE_MAX_PHRASES)
  })
  it("a sender without a name is 'someone', and nothing at all is said for nothing new", () => {
    expect(voicePhrases([{ sender: "" }])).toEqual(["Message from someone"])
    expect(voicePhrases([])).toEqual([])
  })
})

describe("the time an answer starts from", () => {
  const now = new Date("2026-10-30T12:00:00.000Z")
  it("no time, or a time that is not one, is only a request for the clock", () => {
    expect(sinceFrom(null, now)).toBeNull()
    expect(sinceFrom("", now)).toBeNull()
    expect(sinceFrom("yesterday", now)).toBeNull()
  })
  it("a recent time is kept as it is", () => {
    expect(sinceFrom("2026-10-30T11:59:30.000Z", now)).toBe("2026-10-30T11:59:30.000Z")
  })
  it("a page that was asleep is told about the last few minutes at most, never a day of messages", () => {
    expect(sinceFrom("2026-10-29T08:00:00.000Z", now)).toBe(new Date(now.getTime() - VOICE_MAX_AGE_MS).toISOString())
  })
  it("a time in the future is never later than now", () => {
    expect(sinceFrom("2027-01-01T00:00:00.000Z", now)).toBe(now.toISOString())
  })
})

describe("the first look of a page", () => {
  it("starts a few seconds before now, so a message that came in while the request was on its way is not lost", () => {
    const now = new Date("2026-10-30T12:00:10.000Z")
    expect(baselineFrom(now)).toBe(new Date(now.getTime() - VOICE_BASELINE_BACK_MS).toISOString())
    expect(Date.parse(baselineFrom(now))).toBeLessThan(now.getTime())
  })
  it("the route takes its clock before the login checks and hands the early clock back to a page that sent no time", () => {
    const route = readFileSync("app/api/marketing/chat/alerts/route.ts", "utf8")
    expect(route.indexOf("const now = new Date()")).toBeGreaterThan(-1)
    expect(route.indexOf("const now = new Date()")).toBeLessThan(route.indexOf("auth.getUser()"))
    expect(route).toMatch(/now: baselineFrom\(now\)/)
  })
})

describe("saying a message once for the whole browser", () => {
  it("a message already said is not said again (a second tab, or the next round)", () => {
    const items = [{ id: "a" }, { id: "b" }, { id: "c" }]
    expect(notSpokenYet(items, ["b"]).map(i => i.id)).toEqual(["a", "c"])
    expect(notSpokenYet(items, ["a", "b", "c"])).toEqual([])
  })
  it("remembers the new ids, newest last, and forgets the oldest past the limit", () => {
    expect(rememberSpoken(["a"], ["b", "a", "c"])).toEqual(["a", "b", "c"])
    const long = Array.from({ length: VOICE_SPOKEN_KEEP + 5 }, (_, i) => `m${i}`)
    const kept = rememberSpoken([], long)
    expect(kept).toHaveLength(VOICE_SPOKEN_KEEP)
    expect(kept[kept.length - 1]).toBe(`m${VOICE_SPOKEN_KEEP + 4}`)
  })
  it("a stored list that is damaged is an empty list, never an error on a screen", () => {
    expect(parseSpoken(null)).toEqual([])
    expect(parseSpoken("not json")).toEqual([])
    expect(parseSpoken('{"a":1}')).toEqual([])
    expect(parseSpoken('["a",3,"b"]')).toEqual(["a", "b"])
  })
})

describe("who is told, and where it is wired", () => {
  const chat = readFileSync("lib/marketing/chat-alerts.ts", "utf8")
  const lead = readFileSync("lib/marketing/lead-chat-server.ts", "utf8")
  const route = readFileSync("app/api/marketing/chat/alerts/route.ts", "utf8")
  it("the lead chats are read through the viewer's lanes, like the unread numbers (a setter is never told about the owners chat)", () => {
    const fn = lead.slice(lead.indexOf("export async function newLeadMessages"), lead.indexOf("export interface Conversation"))
    expect(fn).toMatch(/readMessages</)
    expect(fn).toMatch(/\.in\("lane", lanes\)/)
    expect(fn).toMatch(/\.neq\("sender_id", userId\)/)
    expect(fn).toMatch(/\.is\("deleted_at", null\)/)
  })
  it("the answer carries a first name and a time, never the words of a message", () => {
    expect(chat).not.toMatch(/message:/)
    expect(chat).toMatch(/firstNameOf/)
  })
  it("a person with no chat access is told nothing", () => {
    expect(chat).toMatch(/hasPermission\(ctx\.permissions, "chat"\)\) return \[\]/)
  })
  it("Antonio is asked as himself, never as a role he is viewing as; a login with no team gets the refusal", () => {
    expect(route).toMatch(/isSecureAdmin\(user\) \? await adminMemberContext/)
    expect(route).toMatch(/g\.ok === false\) return NextResponse\.json/)
  })
  it("the alert runs in the CRM (not in embedded windows) and in the team's workspace; the switch is in both menus", () => {
    expect(readFileSync("app/(dashboard)/layout.tsx", "utf8")).toMatch(/<ChromeOnly><MessageVoice \/><\/ChromeOnly>/)
    const app = readFileSync("app/marketing/(app)/layout.tsx", "utf8")
    expect(app).toMatch(/<MessageVoice wakeText=/)
    expect(app).toMatch(/<VoiceSwitch /)
    expect(readFileSync("app/(dashboard)/marketing-leads/layout.tsx", "utf8")).toMatch(/<VoiceSwitch \/>/)
  })
  it("the screen part asks only when Sound is on, asks once for all tabs, and stops after a refusal", () => {
    const c = readFileSync("components/marketing/message-voice.tsx", "utf8")
    expect(c).toMatch(/!voiceOn\(\)\) return/)
    expect(c).toMatch(/tdm-voice-look/)
    expect(c).toMatch(/res\.status === 401 \|\| res\.status === 403\) return 'stop'/)
    expect(c).toMatch(/SpeechSynthesisUtterance/)
    expect(c).toMatch(/u\.lang = 'en-US'/)
  })
  it("a switched-on page nobody has touched shows a clear bar (the browser keeps it silent until a click) and the bar goes at the first click or key", () => {
    const c = readFileSync("components/marketing/message-voice.tsx", "utf8")
    expect(c).toMatch(/data-testid="voice-wake-bar"/)
    expect(c).toMatch(/if \(!on \|\| touched\) return null/)
    expect(c).toMatch(/hasBeenActive/)
    expect(c).toMatch(/addEventListener\('pointerdown', wake/)
    expect(c).toMatch(/addEventListener\('keydown', wake/)
    expect(readFileSync("app/marketing/(app)/layout.tsx", "utf8")).toMatch(/<MessageVoice wakeText=/)
  })
})

describe("Antonio's back link goes to his Home, not to the CRM", () => {
  const layout = readFileSync("app/marketing/(app)/layout.tsx", "utf8")
  it("the owner's top-left link is 'Home' and opens the Marketing Home", () => {
    expect(layout).toMatch(/\{ownerLogin && <Link href="\/marketing-leads"[^>]*data-testid="back-to-home">&#9666; Home<\/Link>\}/)
    expect(layout).not.toMatch(/&#9666; CRM/)
  })
})
