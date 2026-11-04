/**
 * Offer builder Part 1, the box "Before this offer can be sent": its switch, the words it shows, and that the screens keep their
 * promises (lib/offers/send-check-box-switch.ts, lib/offers/send-check-view.ts, components/offers/offer-send-check-box.tsx).
 */
import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { SEND_CHECK_BOX_KEY, parseFeaturesReply } from "@/lib/offers/rollout"
import { BLOCKED_HEADLINE, OK_HEADLINE, boxModel, parseSendCheckReply, type SendCheckReply } from "@/lib/offers/send-check-view"

const reply = (over: Partial<SendCheckReply> = {}): SendCheckReply => ({
  applicable: true,
  blockers: [],
  risks: [],
  notChecked: [],
  willSendTo: "jane@example.com",
  checkedAt: "2026-11-04T15:00:00.000Z",
  ...over,
})

describe("the box's own setting — rolled out per record (off / test accounts only / on), see offer-rollout*.test.ts", () => {
  it("keeps its own key", () => {
    expect(SEND_CHECK_BOX_KEY).toBe("offer_send_check_box_enabled")
  })
  it("is decided by the server answer: shown only for a clean `true`", () => {
    expect(parseFeaturesReply(true, { addService: false, sendCheckBox: true }).sendCheckBox).toBe(true)
    expect(parseFeaturesReply(true, { sendCheckBox: "true" }).sendCheckBox).toBe(false)
    expect(parseFeaturesReply(false, { sendCheckBox: true }).sendCheckBox).toBe(false)
    expect(parseFeaturesReply(true, null).sendCheckBox).toBe(false)
  })
})

describe("parseSendCheckReply — a reply that cannot be trusted is never shown as a result", () => {
  const good = { applicable: true, status: "draft", blockers: [], risks: [], notChecked: ["n"], willSendTo: "a@b.c", checkedAt: "2026-11-04T15:00:00.000Z" }

  it("accepts a well-formed answer", () => {
    expect(parseSendCheckReply(true, good)).toMatchObject({ applicable: true, blockers: [], notChecked: ["n"], willSendTo: "a@b.c" })
  })
  it("an offer that is not a draft is a valid 'nothing to check' answer", () => {
    expect(parseSendCheckReply(true, { applicable: false, status: "sent", checkedAt: "2026-11-04T15:00:00.000Z" })).toMatchObject({ applicable: false, status: "sent" })
  })
  it.each([
    ["a failed reply", false, good],
    ["no body", true, null],
    ["an HTML page", true, "<html></html>"],
    ["no 'applicable' field", true, { blockers: [], risks: [], notChecked: [] }],
    ["blockers not a list", true, { ...good, blockers: "x" }],
    ["risks not a list of text", true, { ...good, risks: [1] }],
    ["notChecked missing", true, { applicable: true, blockers: [], risks: [] }],
    ["a blocker with no message", true, { ...good, blockers: [{ step: "email" }] }],
    ["a blocker that is not an object", true, { ...good, blockers: ["x"] }],
  ])("%s → null (the box says it could not check; it never shows an empty list as 'no problems')", (_label, ok, body) => {
    expect(parseSendCheckReply(ok as boolean, body)).toBeNull()
  })
  it("keeps the engine's fix links and drops malformed ones", () => {
    const r = parseSendCheckReply(true, { ...good, blockers: [{ step: "services", message: "m", readiness: [{ message: "a", kind: "contract", href: "/x" }, { nope: 1 }, { message: "b" }] }] })
    expect(r?.blockers[0].readiness).toEqual([{ message: "a", kind: "contract", href: "/x" }, { message: "b", kind: undefined, href: undefined }])
  })
})

describe("boxModel — the words", () => {
  it("no problems: 'No problems found in what was checked' — and it never says 'ready'", () => {
    const m = boxModel(reply({ notChecked: ["The client's portal login is created at the moment you send, so it cannot be checked in advance."] }))
    expect(m.tone).toBe("ok")
    expect(m.headline).toBe(OK_HEADLINE)
    expect(OK_HEADLINE).toBe("No problems found in what was checked")
    expect(JSON.stringify(m).toLowerCase()).not.toContain("ready")
    expect(m.notChecked).toHaveLength(1)
    expect(m.askLine).toBe("")
  })

  it("problems from the service engine become one row each, with a link that says where to fix it", () => {
    const m = boxModel(reply({
      blockers: [{
        step: "services",
        message: "joined",
        readiness: [
          { message: '"Apostille" has no contract yet', kind: "contract", href: "/service-catalog/apostille/edit#contract" },
          { message: '"Apostille" has no steps yet', kind: "steps", href: "/service-catalog/apostille/edit#contract" },
          { message: "delete this draft and create it again", kind: "offer_type" },
        ],
      }],
    }))
    expect(m.tone).toBe("blocked")
    expect(m.headline).toBe(BLOCKED_HEADLINE)
    expect(m.problems).toEqual([
      { text: '"Apostille" has no contract yet', href: "/service-catalog/apostille/edit#contract", linkLabel: "Open contract" },
      { text: '"Apostille" has no steps yet', href: "/service-catalog/apostille/edit#contract", linkLabel: "Open service" },
      { text: "Delete this draft and create it again" },
    ])
    expect(m.askLine).toBe("If you cannot fix one of these yourself, ask Antonio.")
  })

  it("other problems keep their words, starting with a capital", () => {
    const m = boxModel(reply({ blockers: [{ step: "email", message: "client_email is not set on this offer. Update it first." }, { step: "yearly_fee", message: "could not check whether this offer needs a yearly fee (db down) — try again.", couldNotCheck: true }] }))
    expect(m.problems.map((p) => p.text)).toEqual(["Client_email is not set on this offer. Update it first.", "Could not check whether this offer needs a yearly fee (db down) — try again."])
  })

  it("risks are listed as warnings and never turn a clean list into a refusal", () => {
    const m = boxModel(reply({ risks: ['"Consulting Call" is on this offer, but …'] }))
    expect(m.tone).toBe("ok")
    expect(m.risks).toEqual(['"Consulting Call" is on this offer, but …'])
  })

  it("says who it goes to", () => {
    expect(boxModel(reply()).willSendTo).toBe("jane@example.com")
    expect(boxModel(reply({ willSendTo: null })).willSendTo).toBeNull()
  })
})

describe("the screens keep their promises (source checks)", () => {
  const root = process.cwd()
  const read = (p: string) => readFileSync(join(root, p), "utf8")
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1")
  const box = strip(read("components/offers/offer-send-check-box.tsx"))

  it("the box is off until the server says yes for its offer, and then draws nothing and asks nothing", () => {
    expect(box).toContain("const { sendCheckBox: on } = useOfferBuilderFeatures({ token })")
    expect(box).toContain("if (!on) return null")
    expect(box).toMatch(/if \(on\) void run\(\)/)
  })

  it("it asks the read-only route and never the real send", () => {
    expect(box).toContain("/api/crm/admin-actions/offer-send-check?token=")
    expect(box).not.toContain("send-offer")
    expect(box).not.toContain("activate-lead")
    expect(box).not.toMatch(/method:\s*['"]POST/)
  })

  it("an older answer never overwrites a newer one, and a bad reply is shown as 'could not check'", () => {
    // the guard must come BEFORE the answer is used, in the success path and in the failure path
    const guard = box.indexOf("if (mine !== seq.current) return")
    expect(guard).toBeGreaterThan(-1)
    expect(guard).toBeLessThan(box.indexOf("setReply(parsed)"))
    const catchAt = box.indexOf("} catch {")
    expect(box.indexOf("if (mine !== seq.current) return", catchAt)).toBeGreaterThan(catchAt)
    expect(box.indexOf("if (mine !== seq.current) return", catchAt)).toBeLessThan(box.indexOf("setCouldNot(true)", catchAt))
    expect(box).toContain("parseSendCheckReply(")
    expect(box).toContain("Could not check this offer right now")
  })

  it("an offer that is no longer a draft shows nothing", () => {
    expect(box).toContain("if (reply && !reply.applicable) return null")
  })

  it("it never locks the real Send, and never says 'ready'", () => {
    expect(box).not.toMatch(/disabled=\{[^}]*(blocked|problems|model)/)
    expect(box.toLowerCase()).not.toContain("ready")
  })

  it("it is mounted on all three places, only for a draft", () => {
    const lead = strip(read("app/(dashboard)/leads/[id]/components/lead-actions.tsx"))
    const panel = strip(read("components/offers/account-offer-panel.tsx"))
    const dialog = strip(read("components/offers/create-offer-dialog.tsx"))
    expect(lead).toMatch(/isOfferDraft && offer\?\.token && \(\s*<div className="mb-4">\s*<OfferSendCheckBox token=\{offer\.token\}/)
    expect(panel).toContain("{isOfferDraft && <OfferSendCheckBox token={offer.token} />}")
    expect(dialog).toMatch(/createdToken && \(\s*<div className="px-5 pb-4">\s*<OfferSendCheckBox token=\{createdToken\}/)
  })

  it("the setting is a known app setting, and there is NO toggle for it anywhere on screen (Claude sets it)", () => {
    expect(read("lib/settings.ts")).toContain('"offer_send_check_box_enabled"')
    expect(read("components/dashboard/maintenance-panel.tsx")).not.toContain("offer_send_check_box_enabled")
  })
})
