import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { lanesFor, inLane, resolveLane, laneRecipients, laneLabels, MAX_ATTACHMENTS, MESSAGE_MAX_CHARS, chatUrlFor, checkEdit, checkEmoji, checkSend, cleanFileName, folderFor, isOwnObjectPath, mayDelete, mayEdit, newObjectPath, previewLine, isInvolved, pushRecipients, toTalkMessage, unreadCount, type ChatMessageRow } from "@/lib/marketing/lead-chat"
import { isMarketingAllowedPath } from "@/lib/auth/role-door"

const TEAM = "11111111-1111-4111-8111-111111111111"
const LEAD = "22222222-2222-4222-8222-222222222222"
const OBJ = "33333333-3333-4333-8333-333333333333"

describe("what a chat message may carry", () => {
  it("text is trimmed; empty with nothing attached is refused; too long is refused", () => {
    expect(checkSend({ message: "  ciao  ", attachments: null, teamId: TEAM, leadId: LEAD })).toMatchObject({ ok: true, message: "ciao", attachments: [] })
    expect(checkSend({ message: "   ", attachments: [], teamId: TEAM, leadId: LEAD })).toMatchObject({ ok: false })
    expect(checkSend({ message: "x".repeat(MESSAGE_MAX_CHARS + 1), attachments: null, teamId: TEAM, leadId: LEAD })).toMatchObject({ ok: false })
    expect(checkSend({ message: "x".repeat(MESSAGE_MAX_CHARS), attachments: null, teamId: TEAM, leadId: LEAD })).toMatchObject({ ok: true })
  })
  it("a file counts only if it sits in THIS lead's own folder with one of our object names", () => {
    const ok = `${folderFor(TEAM, LEAD)}${OBJ}.m4a`
    expect(isOwnObjectPath(ok, TEAM, LEAD)).toBe(true)
    expect(isOwnObjectPath(`${folderFor(TEAM, "99999999-9999-4999-8999-999999999999")}${OBJ}.m4a`, TEAM, LEAD)).toBe(false) // another lead
    expect(isOwnObjectPath(`${folderFor("99999999-9999-4999-8999-999999999999", LEAD)}${OBJ}.m4a`, TEAM, LEAD)).toBe(false) // another team
    for (const bad of [`${folderFor(TEAM, LEAD)}../x.m4a`, `${folderFor(TEAM, LEAD)}sub/${OBJ}.m4a`, `${folderFor(TEAM, LEAD)}name.m4a`, `${folderFor(TEAM, LEAD)}${OBJ}.html5x5x5x5x`, "etc/passwd", 5, null]) expect(isOwnObjectPath(bad, TEAM, LEAD)).toBe(false)
    expect(checkSend({ message: "x", attachments: [{ path: "elsewhere/file.png", name: "a" }], teamId: TEAM, leadId: LEAD })).toMatchObject({ ok: false })
  })
  it("at most five files; a voice note is marked as already an ordinary MP4", () => {
    const a = (i: number) => ({ path: `${folderFor(TEAM, LEAD)}${OBJ.slice(0, 35)}${i}.png`, name: `f${i}.png`, mime_type: "image/png", size: 10 })
    expect(checkSend({ message: "", attachments: Array.from({ length: MAX_ATTACHMENTS + 1 }, (_, i) => a(i)), teamId: TEAM, leadId: LEAD })).toMatchObject({ ok: false })
    const v = checkSend({ message: "", attachments: [{ path: `${folderFor(TEAM, LEAD)}${OBJ}.m4a`, name: "voice.m4a", mime_type: "audio/mp4", size: 5 }], teamId: TEAM, leadId: LEAD })
    expect(v).toMatchObject({ ok: true, attachments: [{ flat: true, mime_type: "audio/mp4" }] })
    expect(checkSend({ message: "", attachments: "nope", teamId: TEAM, leadId: LEAD })).toMatchObject({ ok: false })
  })
  it("file names are cleaned; the storage name is ours, with a short plain extension", () => {
    expect(cleanFileName("../../etc/pass\u0000wd.png")).toBe("passwd.png")
    expect(cleanFileName("")).toBe("file")
    expect(newObjectPath(TEAM, LEAD, "Photo.JPG", OBJ)).toBe(`${TEAM}/${LEAD}/${OBJ}.jpg`)
    expect(newObjectPath(TEAM, LEAD, "noext", OBJ)).toBe(`${TEAM}/${LEAD}/${OBJ}.noext`)
  })
  it("edit and reaction input", () => {
    expect(checkEdit("  hi ")).toEqual({ ok: true, message: "hi" })
    expect(checkEdit("   ")).toMatchObject({ ok: false })
    expect(checkEmoji("👍")).toBe("👍")
    expect(checkEmoji("")).toBeNull()
    expect(checkEmoji("x".repeat(17))).toBeNull()
  })
  it("only the author edits; the author or the team owner deletes", () => {
    expect(mayEdit({ sender_id: "a", deleted_at: null }, "a")).toBe(true)
    expect(mayEdit({ sender_id: "a", deleted_at: null }, "b")).toBe(false)
    expect(mayEdit({ sender_id: "a", deleted_at: "x" }, "a")).toBe(false)
    expect(mayDelete({ sender_id: "a" }, "a", false)).toBe(true)
    expect(mayDelete({ sender_id: "a" }, "b", false)).toBe(false)
    expect(mayDelete({ sender_id: "a" }, "b", true)).toBe(true)
  })
})

describe("how a message is shown", () => {
  const row = (over: Partial<ChatMessageRow> & { id: string }): ChatMessageRow => ({ sender_id: "u1", sender_name: "Cristina", message: "ciao", attachments: null, reply_to_id: null, edited_at: null, deleted_at: null, created_at: "2026-10-23T10:00:00Z", ...over })
  it("a reply carries a preview of the quoted message; reactions and signed links are attached; a deleted message loses its words and files", () => {
    const q = row({ id: "q", message: "domanda" })
    const m = row({ id: "m", message: "risposta", reply_to_id: "q", attachments: [{ path: "p/1.png", name: "1.png", mime_type: "image/png" }, { path: "gone", name: "x" }] })
    const byId = new Map([[q.id, q], [m.id, m]])
    const shown = toTalkMessage(m, byId, [{ message_id: "m", user_id: "u2", user_name: "Rocco", emoji: "👍" }, { message_id: "other", user_id: "u2", user_name: "Rocco", emoji: "❤️" }], p => (p === "p/1.png" ? "https://signed/1" : null))
    expect(shown.reply_to_preview).toMatchObject({ id: "q", message: "domanda", sender_name: "Cristina" })
    expect(shown.attachments).toEqual([{ path: "p/1.png", name: "1.png", mime_type: "image/png", url: "https://signed/1" }])
    expect(shown.reactions).toEqual([{ emoji: "👍", reactor_id: "u2", reactor_name: "Rocco" }])
    const gone = toTalkMessage(row({ id: "d", deleted_at: "2026-10-23T11:00:00Z", attachments: [{ path: "p/1.png", name: "1.png" }] }), byId, [], () => "https://x")
    expect(gone).toMatchObject({ message: "", attachments: null })
  })
  it("the Messages list / notification line: the words, else what was attached", () => {
    expect(previewLine({ message: "  ciao   Rocco ", attachments: null, deleted_at: null })).toBe("ciao Rocco")
    expect(previewLine({ message: "", attachments: [{ mime_type: "audio/mp4" }], deleted_at: null })).toBe("Voice message")
    expect(previewLine({ message: "", attachments: [{ mime_type: "image/png" }], deleted_at: null })).toBe("Photo")
    expect(previewLine({ message: "", attachments: [{ name: "costi.pdf" }], deleted_at: null })).toBe("costi.pdf")
    expect(previewLine({ message: "x".repeat(200), attachments: null, deleted_at: null }).length).toBeLessThanOrEqual(90)
    expect(previewLine({ message: "secret", attachments: null, deleted_at: "x" })).toBe("This message was deleted")
  })
})

describe("unread numbers and who is told", () => {
  const m = (sender: string, at: string, del: string | null = null) => ({ sender_id: sender, created_at: at, deleted_at: del })
  it("counts only other people's messages after my read marker; deleted ones do not count; no marker = all of theirs", () => {
    const list = [m("a", "2026-10-23T10:00:00Z"), m("me", "2026-10-23T10:05:00Z"), m("a", "2026-10-23T10:10:00Z"), m("a", "2026-10-23T10:20:00Z", "x")]
    expect(unreadCount(list, "me", null)).toBe(2)
    expect(unreadCount(list, "me", "2026-10-23T10:06:00Z")).toBe(1)
    expect(unreadCount(list, "me", "2026-10-23T11:00:00Z")).toBe(0)
  })
  it("a notification goes to every active member who may chat, never to the sender, a removed or a paused person", () => {
    const members = [
      { user_id: "s", status: "active", permissions: ["chat", "leads.mark"] }, { user_id: "r", status: "active", permissions: ["chat", "leads.read", "leads.pick"] },
      { user_id: "x", status: "removed", permissions: ["chat", "leads.mark"] }, { user_id: "p", status: "paused", permissions: ["chat", "leads.mark"] }, { user_id: "n", status: "active", permissions: ["leads.read", "leads.mark"] },
      { user_id: "ad", status: "active", permissions: ["chat", "leads.read", "content.manage"] },
    ]
    expect(pushRecipients(members, "s")).toEqual(["r"])
  })
  it("only people who work the leads are involved: the ad person with the chat is not (the ticks and the notifications are not about him)", () => {
    expect(isInvolved(["chat", "leads.mark"])).toBe(true)
    expect(isInvolved(["chat", "leads.pick"])).toBe(true)
    expect(isInvolved(["chat", "leads.read", "content.manage"])).toBe(false)
    expect(isInvolved(["leads.mark"])).toBe(false)
  })
  it("a tapped notification goes to the board with that lead's chat open — an address under /marketing", () => {
    const url = chatUrlFor(LEAD)
    expect(url).toBe(`/marketing/board?chat=${LEAD}`)
    expect(isMarketingAllowedPath(url)).toBe(true)
  })
  it("a notification for one of a lead's two chats names it, so that chat opens", () => {
    expect(chatUrlFor(LEAD, "setter")).toBe(`/marketing/board?chat=${LEAD}&lane=setter`)
    expect(isMarketingAllowedPath(chatUrlFor(LEAD, "owners"))).toBe(true)
  })
})

describe("the marketing worker file", () => {
  const sw = readFileSync(join(process.cwd(), "public/marketing-sw.js"), "utf8")
  const run = (raw: unknown) => {
    const self = { location: { origin: "https://app.example" }, addEventListener: () => undefined, skipWaiting: () => undefined, clients: {}, registration: {} }
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    return new Function("self", "URL", "fetch", "clients", `${sw}; return marketingUrlFor(${JSON.stringify(raw)})`)(self, URL, () => Promise.resolve(), {})
  }
  it("a tap can only ever go to an address under /marketing", () => {
    expect(run(`/marketing/board?chat=${LEAD}`)).toBe(`/marketing/board?chat=${LEAD}`)
    expect(run("/dashboard")).toBe("/marketing/board")
    expect(run("https://evil.example/marketing/board")).toBe("/marketing/board")
    expect(run("//evil.example")).toBe("/marketing/board")
    expect(run(null)).toBe("/marketing/board")
    expect(run("/marketing-evil")).toBe("/marketing/board")
  })
  it("it caches nothing", () => {
    expect(sw).not.toMatch(/caches\.|cache\.put|cache\.add/i)
  })
})

describe("the two chats of a lead (lanes)", () => {
  const SETTER = ["leads.read", "leads.call", "leads.mark", "leads.worklist", "team.notes", "whatsapp", "chat"]
  const SELLER = ["leads.read", "leads.pick", "leads.call", "leads.mark", "team.notes", "whatsapp", "chat", "inbox", "calls.host", "documents", "documents.manage"]
  it("a setter has only the setter lane, Antonio on his own login only the owners lane, Rocco both; Antonio viewing as a setter sees the setter lane, viewing as the owner both", () => {
    expect(lanesFor({ permissions: SETTER, admin: false, viewAs: false })).toEqual(["setter"])
    expect(lanesFor({ permissions: SELLER, admin: true, viewAs: false })).toEqual(["owners"])
    expect(lanesFor({ permissions: SELLER, admin: false, viewAs: false })).toEqual(["owners", "setter"])
    expect(lanesFor({ permissions: SETTER, admin: true, viewAs: true })).toEqual(["setter"])
    expect(lanesFor({ permissions: SELLER, admin: true, viewAs: true })).toEqual(["owners", "setter"])
  })
  it("who is in which lane", () => {
    const setter = { permissions: SETTER, isAdmin: false }, rocco = { permissions: SELLER, isAdmin: false }, antonio = { permissions: SELLER, isAdmin: true }
    expect([setter, rocco, antonio].map(m => inLane(m, "owners"))).toEqual([false, true, true])
    expect([setter, rocco, antonio].map(m => inLane(m, "setter"))).toEqual([true, true, false])
  })
  it("a request names its lane; a person with one lane needs not name it; a lane she may not use is refused", () => {
    expect(resolveLane("setter", ["setter"])).toBe("setter")
    expect(resolveLane(undefined, ["setter"])).toBe("setter")
    expect(resolveLane("owners", ["setter"])).toBeNull()
    expect(resolveLane("nonsense", ["owners", "setter"])).toBeNull()
    expect(resolveLane(undefined, ["owners", "setter"])).toBe("owners")
    expect(resolveLane("setter", ["owners", "setter"])).toBe("setter")
  })
  it("a message in a lane tells only that lane's people, the sender and paused people excepted; nobody needs an @", () => {
    const m = [
      { user_id: "cristina", status: "active", permissions: SETTER, isAdmin: false },
      { user_id: "rocco", status: "active", permissions: SELLER, isAdmin: false },
      { user_id: "antonio", status: "active", permissions: SELLER, isAdmin: true },
      { user_id: "anna", status: "paused", permissions: SETTER, isAdmin: false },
    ]
    expect(laneRecipients(m, "rocco", "setter")).toEqual(["cristina"])
    expect(laneRecipients(m, "rocco", "owners")).toEqual(["antonio"])
    expect(laneRecipients(m, "cristina", "setter")).toEqual(["rocco"])
  })
  it("the buttons are named after the other side", () => {
    const names = { admin: "Antonio", seller: "Rocco", setters: "Cristina" }
    expect(laneLabels(["owners", "setter"], names, { isSetter: false, isAdmin: false })).toEqual([{ lane: "owners", label: "Discuss with Antonio" }, { lane: "setter", label: "Discuss with Cristina" }])
    expect(laneLabels(["setter"], names, { isSetter: true, isAdmin: false })).toEqual([{ lane: "setter", label: "Discuss with Rocco" }])
    expect(laneLabels(["owners"], names, { isSetter: false, isAdmin: true })).toEqual([{ lane: "owners", label: "Chat with Rocco" }])
  })
})
