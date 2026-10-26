import { describe, it, expect } from "vitest"
import { buildInviteEmail, buildInviteMime, firstNameFromEmail, langFromContact } from "@/lib/marketing/invite-email"

const base = { toName: "Rocco", senderName: "Antonio", teamName: "Rocco's sales team", link: "https://app.tonydurante.us/marketing/accept?token=abc_DEF-123", expiresAt: "2026-11-01T12:00:00.000Z" }

describe("firstNameFromEmail", () => {
  it("takes the first name before the @ and separators", () => {
    expect(firstNameFromEmail("rocco@tonydurante.us")).toBe("Rocco")
    expect(firstNameFromEmail("cristina.rossi@x.com")).toBe("Cristina")
    expect(firstNameFromEmail("ALE_marketing@x.com")).toBe("Ale")
    expect(firstNameFromEmail("antonio.durante@tonydurante.us")).toBe("Antonio")
  })
  it("gives null when it does not look like a name", () => {
    expect(firstNameFromEmail("a@x.com")).toBeNull()
    expect(firstNameFromEmail("123@x.com")).toBeNull()
    expect(firstNameFromEmail("")).toBeNull()
    expect(firstNameFromEmail(null)).toBeNull()
  })
})

describe("langFromContact", () => {
  it("English only when the record says English; everything else (including nothing) is Italian", () => {
    expect(langFromContact("English")).toBe("en")
    expect(langFromContact("en")).toBe("en")
    expect(langFromContact("Italian")).toBe("it")
    expect(langFromContact(null)).toBe("it")
    expect(langFromContact("")).toBe("it")
    expect(langFromContact("Klingon")).toBe("it")
  })
})

describe("buildInviteEmail", () => {
  it("English: subject, greeting, the link as a button, the real expiry date, who to ask", () => {
    const m = buildInviteEmail({ ...base, lang: "en" })
    expect(m.subject).toBe("Your access to TD Marketing")
    expect(m.text).toContain("Hi Rocco,")
    expect(m.text).toContain(base.link)
    expect(m.text).toContain("valid until 1 November 2026")
    expect(m.text).toContain("ask Antonio for a new one")
    expect(m.html).toContain(`href="${base.link}"`)
    expect(m.html).toContain("Open my workspace")
  })
  it("Italian: the same in Italian", () => {
    const m = buildInviteEmail({ ...base, lang: "it" })
    expect(m.subject).toBe("Il tuo accesso a TD Marketing")
    expect(m.text).toContain("Ciao Rocco,")
    expect(m.text).toContain("fino al 1 novembre 2026")
    expect(m.html).toContain("Apri il mio spazio di lavoro")
  })
  it("no name: a plain greeting", () => {
    expect(buildInviteEmail({ ...base, toName: null, lang: "en" }).text.startsWith("Hi,")).toBe(true)
    expect(buildInviteEmail({ ...base, toName: null, lang: "it" }).text.startsWith("Ciao,")).toBe(true)
  })
  it("a team or sender name with html in it is escaped in the HTML", () => {
    const m = buildInviteEmail({ ...base, lang: "en", teamName: "<img src=x onerror=alert(1)>", senderName: "<b>X</b>" })
    expect(m.html).not.toContain("<img src=x")
    expect(m.html).not.toContain("<b>X</b>")
    expect(m.html).toContain("&lt;img")
  })
})

describe("buildInviteMime", () => {
  it("encodes a non-ASCII subject as RFC 2047 base64 (R041), is multipart text + html, and addresses the invitee", () => {
    const mail = buildInviteEmail({ ...base, lang: "it" })
    const raw = buildInviteMime("rocco@tonydurante.us", { ...mail, subject: "Il tuo accesso — è pronto" }, "B1")
    expect(raw).toContain("To: rocco@tonydurante.us")
    expect(raw).toContain("From: Tony Durante LLC <support@tonydurante.us>")
    const subj = /Subject: =\?utf-8\?B\?([A-Za-z0-9+/=]+)\?=/.exec(raw)
    expect(Buffer.from(subj![1], "base64").toString("utf8")).toBe("Il tuo accesso — è pronto")
    expect(raw).not.toContain("Subject: Il tuo")
    expect(raw).toContain("multipart/alternative")
    expect(raw).toContain("text/plain")
    expect(raw).toContain("text/html")
    expect(raw.endsWith("--B1--")).toBe(true)
  })
  it("adds a Reply-To when given (answers reach whoever made the invitation) and none when not", () => {
    const mail = buildInviteEmail({ ...base, lang: "en" })
    const withReply = buildInviteMime("cristina@x.com", mail, "B2", "rocco@tonydurante.us")
    expect(withReply).toContain("Reply-To: rocco@tonydurante.us")
    expect(withReply).toContain("From: Tony Durante LLC <support@tonydurante.us>")
    expect(buildInviteMime("cristina@x.com", mail, "B2")).not.toContain("Reply-To")
    expect(buildInviteMime("cristina@x.com", mail, "B2", null)).not.toContain("Reply-To")
  })
  it("never lets a line break or a space into the Reply-To header", () => {
    const mail = buildInviteEmail({ ...base, lang: "en" })
    for (const bad of ["a@x.com\r\nBcc: evil@x.com", "a b@x.com", "<a@x.com>"]) expect(buildInviteMime("c@x.com", mail, "B3", bad)).not.toContain("Reply-To")
  })
})
