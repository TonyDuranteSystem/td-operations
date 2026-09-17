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
})
