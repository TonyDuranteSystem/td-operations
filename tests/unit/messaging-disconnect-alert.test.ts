import { describe, it, expect } from "vitest"
import { buildDisconnectAlertEmail } from "@/lib/messaging/disconnect-alert"

describe("buildDisconnectAlertEmail", () => {
  it("defaults to the support mailbox and RFC-2047-encodes the subject", () => {
    const { to, raw } = buildDisconnectAlertEmail({ channelName: "+17274521093", reason: "LOGOUT" })
    expect(to).toBe("support@tonydurante.us")
    const decoded = Buffer.from(raw, "base64url").toString("utf-8")
    expect(decoded).toContain("Subject: =?utf-8?B?")
    expect(decoded).not.toMatch(/^Subject: \[WhatsApp\]/m)
  })

  it("includes the channel name and reason in the body", () => {
    const { raw } = buildDisconnectAlertEmail({ channelName: "+17274521093", reason: "LOGOUT" })
    const decoded = Buffer.from(raw, "base64url").toString("utf-8")
    const htmlBase64 = decoded.split("\r\n\r\n")[1]
    const html = Buffer.from(htmlBase64, "base64").toString("utf-8")
    expect(html).toContain("+17274521093")
    expect(html).toContain("LOGOUT")
  })

  it("honors an explicit notifyEmail override", () => {
    const { to } = buildDisconnectAlertEmail({
      channelName: "+17274521093",
      reason: "LOGOUT",
      notifyEmail: "luca@tonydurante.us",
    })
    expect(to).toBe("luca@tonydurante.us")
  })

  it("escapes HTML in the channel name, reason and hint (the reason now comes from a remote bridge)", () => {
    const { raw } = buildDisconnectAlertEmail({ channelName: "<b>x</b>", reason: "<script>alert(1)</script>", hint: "<img src=x onerror=1>" })
    const decoded = Buffer.from(raw, "base64url").toString("utf-8")
    const html = Buffer.from(decoded.split("\r\n\r\n")[1], "base64").toString("utf-8")
    expect(html).not.toContain("<script>")
    expect(html).not.toContain("<img")
    expect(html).toContain("&lt;script&gt;")
  })

  it("keeps the 2Chat wording by default and uses a custom hint and source when given", () => {
    const dec = (p: Parameters<typeof buildDisconnectAlertEmail>[0]) => {
      const d = Buffer.from(buildDisconnectAlertEmail(p).raw, "base64url").toString("utf-8")
      return Buffer.from(d.split("\r\n\r\n")[1], "base64").toString("utf-8")
    }
    expect(dec({ channelName: "n", reason: "r" })).toContain("re-scan the QR code")
    const custom = dec({ channelName: "n", reason: "r", hint: "Check the Mac Mini.", source: "the bridge watchdog" })
    expect(custom).toContain("Check the Mac Mini.")
    expect(custom).toContain("the bridge watchdog")
    expect(custom).not.toContain("2Chat")
  })
})
