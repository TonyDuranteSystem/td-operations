/**
 * Offer-builder rollout rules (lib/offers/rollout.ts): off / test / on per piece. No screen, no button — Claude sets the
 * stored value on Antonio's word. These are the pure rules both the server and the screens share.
 */
import { describe, expect, it } from "vitest"
import {
  NO_FEATURES,
  OFFER_BUILDER_FEATURE_KEYS,
  SEND_CHECK_BOX_KEY,
  featureVisible,
  parseFeaturesReply,
  parseRolloutValue,
} from "@/lib/offers/rollout"

describe("the keys", () => {
  it("the piece keeps the name it was stored under (so nothing already stored changes meaning)", () => {
    expect(SEND_CHECK_BOX_KEY).toBe("offer_send_check_box_enabled")
    expect(OFFER_BUILDER_FEATURE_KEYS).toEqual({ sendCheckBox: "offer_send_check_box_enabled" })
  })
})

describe("parseRolloutValue — a stored value becomes a mode, and only two exact values mean anything", () => {
  it("the boolean true is ON (what the old switch stored, so an old 'on' stays on)", () => {
    expect(parseRolloutValue(true)).toBe("on")
  })
  it("the exact text 'test' is TEST", () => {
    expect(parseRolloutValue("test")).toBe("test")
  })
  it.each([
    ["no row (null)", null],
    ["undefined", undefined],
    ["false", false],
    ["'false'", "false"],
    ["'true'", "true"],
    ["'on'", "on"],
    ["'TEST'", "TEST"],
    ["' test'", " test"],
    ["'off'", "off"],
    ["the number 1", 1],
    ["an object", { enabled: true }],
    ["an array", [true]],
    ["an empty string", ""],
  ])("%s is OFF — anything that merely looks like on/test never switches a piece on", (_label, value) => {
    expect(parseRolloutValue(value)).toBe("off")
  })
})

describe("featureVisible — can this piece be seen for this record?", () => {
  it("OFF is never visible, whatever the record is", () => {
    for (const subject of [true, false, null]) expect(featureVisible("off", subject)).toBe(false)
  })
  it("ON is visible for everything, even when the record is unknown", () => {
    for (const subject of [true, false, null]) expect(featureVisible("on", subject)).toBe(true)
  })
  it("TEST is visible only for a record known to be a test record", () => {
    expect(featureVisible("test", true)).toBe(true)
    expect(featureVisible("test", false)).toBe(false)
    expect(featureVisible("test", null)).toBe(false) // unknown never counts as test
  })
})

describe("parseFeaturesReply — what a screen does with the route's answer", () => {
  it("a clean answer shows the piece answered true", () => {
    expect(parseFeaturesReply(true, { sendCheckBox: true })).toEqual({ sendCheckBox: true })
    expect(parseFeaturesReply(true, { sendCheckBox: false })).toEqual({ sendCheckBox: false })
  })
  it("only the boolean true shows a piece — 'true', 1, objects and missing fields do not", () => {
    expect(parseFeaturesReply(true, { sendCheckBox: "true" })).toEqual(NO_FEATURES)
    expect(parseFeaturesReply(true, { sendCheckBox: 1 })).toEqual(NO_FEATURES)
    expect(parseFeaturesReply(true, { sendCheckBox: [true] })).toEqual(NO_FEATURES)
    expect(parseFeaturesReply(true, {})).toEqual(NO_FEATURES)
  })
  it("an answer about a piece that no longer exists (the retired 'add a new service') shows nothing", () => {
    expect(parseFeaturesReply(true, { addService: true })).toEqual(NO_FEATURES)
  })
  it("a failed reply hides everything, even when the body says true", () => {
    expect(parseFeaturesReply(false, { sendCheckBox: true })).toEqual(NO_FEATURES)
  })
  it("an unreadable body (expired login, error page, nothing) hides everything", () => {
    expect(parseFeaturesReply(true, null)).toEqual(NO_FEATURES)
    expect(parseFeaturesReply(true, undefined)).toEqual(NO_FEATURES)
    expect(parseFeaturesReply(true, "<html>Sign in</html>")).toEqual(NO_FEATURES)
    expect(parseFeaturesReply(true, 7)).toEqual(NO_FEATURES)
  })
  it("never hands out the shared NO_FEATURES object to be changed", () => {
    const a = parseFeaturesReply(false, null)
    a.sendCheckBox = true
    expect(NO_FEATURES.sendCheckBox).toBe(false)
    expect(parseFeaturesReply(false, null).sendCheckBox).toBe(false)
  })
})
