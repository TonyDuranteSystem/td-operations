import { describe, it, expect } from "vitest"
import {
  addAttachment,
  checkEditable,
  isOwnDraft,
  removeAttachment,
  type FrozenAttachment,
} from "@/lib/inbox/prepared-attachment-edit"

/**
 * ADDING AND REMOVING FILES ON A DRAFT THAT IS WAITING FOR CONFIRM.
 *
 * The freeze exists so the MODEL cannot change what a human has read. A person
 * editing their OWN draft is not that — but it is the first edit to a frozen
 * payload, so every guard around it is pinned here rather than trusted.
 */

/** Real private-bucket paths — the validator requires a genuine uuid, and using
 *  a fake one here would test the fixture rather than the rule. */
let seq = 0
const path = (_label?: string) => {
  seq += 1
  const hex = seq.toString(16).padStart(12, "0")
  return `worker-chat/0f8fad5b-d9cb-469f-a165-${hex}.pdf`
}
const file = (name: string, size = 100): FrozenAttachment => ({ path: path(name), name, size })

describe("whose draft is it — the surfaces do NOT agree on what identity means", () => {
  // The panels record the owner by EMAIL ("crm-inbox:luca@..."), Team Chat by
  // DISPLAY NAME ("team-chat:Luca"). An email-only comparison therefore locks a
  // person out of their own card in Team Chat — the exact screen this editing
  // was built for. Caught in a live run, not by reading the code.
  const ME = ["luca@tonydurante.us", "Luca"]

  it("recognises the owner on every panel surface (email-shaped)", () => {
    for (const actor of ["crm-inbox:luca@tonydurante.us", "crm-portal:luca@tonydurante.us", "crm-sidebar:luca@tonydurante.us"]) {
      expect(isOwnDraft(actor, ME)).toBe(true)
    }
  })

  it("recognises the owner in TEAM CHAT (display-name-shaped)", () => {
    expect(isOwnDraft("team-chat:Luca", ME)).toBe(true)
  })

  it("is not case-sensitive about either shape", () => {
    expect(isOwnDraft("team-chat:luca", ["LUCA"])).toBe(true)
    expect(isOwnDraft("crm-inbox:LUCA@TONYDURANTE.US", ["luca@tonydurante.us"])).toBe(true)
  })

  it("does NOT recognise a teammate", () => {
    expect(isOwnDraft("team-chat:Antonio", ME)).toBe(false)
    expect(isOwnDraft("crm-inbox:antonio.durante@tonydurante.us", ME)).toBe(false)
  })

  it("fails CLOSED on a draft with no recorded owner, and on an empty identity", () => {
    expect(isOwnDraft(null, ME)).toBe(false)
    expect(isOwnDraft("team-chat:", ME)).toBe(false)
    expect(isOwnDraft("team-chat:Luca", [null, "", undefined])).toBe(false)
  })
})

describe("who may edit a frozen draft, and when", () => {
  const row = { status: "pending", actor: "crm-inbox:luca@tonydurante.us", kind: "email" }
  const ME = ["luca@tonydurante.us", "Luca"]

  it("the person who made it, while it is still waiting", () => {
    expect(checkEditable(row, ME)).toEqual({ ok: true })
  })

  it("REFUSES a teammate's draft — conversations are shared", () => {
    // A channel, an email thread and a client screen are all shared. Without
    // this, a colleague could add a file to the draft you are about to send and
    // the card you read would not be the email that left.
    const r = checkEditable(row, ["antonio.durante@tonydurante.us", "Antonio"])
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.status).toBe(403)
  })

  it("REFUSES once it has been sent or cancelled", () => {
    for (const status of ["sent", "cancelled"]) {
      const r = checkEditable({ ...row, status }, ME)
      expect(r.ok).toBe(false)
      expect(r.ok === false && r.status).toBe(409)
    }
  })

  it("REFUSES a portal draft — only an email carries files", () => {
    expect(checkEditable({ ...row, kind: "portal" }, ME).ok).toBe(false)
  })

  it("REFUSES when the draft records no owner at all", () => {
    expect(checkEditable({ ...row, actor: null }, ME).ok).toBe(false)
  })
})

describe("adding a file", () => {
  it("appends it, marked as OURS so cleanup takes it if the draft dies", () => {
    // Unlike a panel upload — which is the staff member's own object, still on
    // screen — this one exists only for this draft.
    const r = addAttachment([], { path: path("a"), name: "a.pdf", size: 10 })
    expect(r.ok).toBe(true)
    expect(r.ok === true && r.attachments[0]).toMatchObject({ name: "a.pdf", copied: true })
    expect(r.ok === true && r.attachments[0].origin).toMatch(/you added this/)
  })

  it("REFUSES a path that is not a private-bucket upload", () => {
    const r = addAttachment([], { path: "signed-documents/secret.pdf", name: "x.pdf" })
    expect(r.ok).toBe(false)
  })

  it("is IDEMPOTENT — a double-click cannot attach the same file twice", () => {
    const same = path()
    const first = addAttachment([], { path: same, name: "a.pdf", size: 10 })
    const second = addAttachment(first.ok === true ? first.attachments : [], { path: same, name: "a.pdf", size: 10 })
    expect(second.ok === true && second.attachments).toHaveLength(1)
  })

  it("REFUSES an eleventh file, with a sentence that says what to do", () => {
    const ten = Array.from({ length: 10 }, (_, i) => file(`f${i}`))
    const r = addAttachment(ten, { path: path("z"), name: "z.pdf", size: 10 })
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.reason).toMatch(/10 is the most/)
  })

  it("REFUSES a file that would push the email past what Gmail accepts", () => {
    const big: FrozenAttachment = { path: path("big"), name: "big.pdf", size: 17 * 1024 * 1024 }
    const r = addAttachment([big], { path: path("more"), name: "more.pdf", size: 5 * 1024 * 1024 })
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.reason).toMatch(/more than Gmail accepts/)
    // ...and the size is readable, not "0.0 MB".
    expect(r.ok === false && r.reason).toMatch(/\d+(\.\d+)? MB/)
  })
})

describe("removing a file", () => {
  const two = [file("a"), file("b")]

  it("removes the one at that position and hands back the rest", () => {
    const r = removeAttachment(two, 0)
    expect(r.ok).toBe(true)
    expect(r.ok === true && r.attachments.map((a) => a.name)).toEqual(["b"])
  })

  it("reports WHICH file was removed, so its copy can be cleaned up", () => {
    const r = removeAttachment(two, 1)
    expect(r.ok === true && r.removed?.name).toBe("b")
  })

  it("REFUSES a position that is not on the draft", () => {
    for (const i of [-1, 2, 99, NaN]) {
      const r = removeAttachment(two, i as number)
      expect(r.ok).toBe(false)
      expect(r.ok === false && r.status).toBe(404)
    }
  })

  it("leaves the draft untouched when it refuses", () => {
    removeAttachment(two, 5)
    expect(two.map((a) => a.name)).toEqual(["a", "b"])
  })
})
