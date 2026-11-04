/**
 * Offer-builder rollout rules (lib/offers/rollout.ts): off / test / on per piece. No screen, no button — Claude sets the
 * stored value on Antonio's word. These are the pure rules both the server and the screens share.
 */
import { describe, expect, it } from "vitest"
import {
  ADD_SERVICE_KEY,
  NO_FEATURES,
  OFFER_BUILDER_FEATURE_KEYS,
  SEND_CHECK_BOX_KEY,
  featureVisible,
  parseFeaturesReply,
  parseRolloutValue,
} from "@/lib/offers/rollout"

describe("the keys", () => {
  it("each piece keeps the name it was stored under before (so nothing already stored changes meaning)", () => {
    expect(ADD_SERVICE_KEY).toBe("offer_add_service_enabled")
    expect(SEND_CHECK_BOX_KEY).toBe("offer_send_check_box_enabled")
    expect(OFFER_BUILDER_FEATURE_KEYS).toEqual({ addService: "offer_add_service_enabled", sendCheckBox: "offer_send_check_box_enabled" })
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
  it("a clean answer shows exactly the pieces answered true", () => {
    expect(parseFeaturesReply(true, { addService: true, sendCheckBox: false })).toEqual({ addService: true, sendCheckBox: false })
    expect(parseFeaturesReply(true, { addService: false, sendCheckBox: true })).toEqual({ addService: false, sendCheckBox: true })
    expect(parseFeaturesReply(true, { addService: true, sendCheckBox: true })).toEqual({ addService: true, sendCheckBox: true })
  })
  it("only the boolean true shows a piece — 'true', 1, objects and missing fields do not", () => {
    expect(parseFeaturesReply(true, { addService: "true", sendCheckBox: 1 })).toEqual(NO_FEATURES)
    expect(parseFeaturesReply(true, { addService: {}, sendCheckBox: [true] })).toEqual(NO_FEATURES)
    expect(parseFeaturesReply(true, {})).toEqual(NO_FEATURES)
    expect(parseFeaturesReply(true, { addService: true })).toEqual({ addService: true, sendCheckBox: false })
  })
  it("a failed reply hides everything, even when the body says true", () => {
    expect(parseFeaturesReply(false, { addService: true, sendCheckBox: true })).toEqual(NO_FEATURES)
  })
  it("an unreadable body (expired login, error page, nothing) hides everything", () => {
    expect(parseFeaturesReply(true, null)).toEqual(NO_FEATURES)
    expect(parseFeaturesReply(true, undefined)).toEqual(NO_FEATURES)
    expect(parseFeaturesReply(true, "<html>Sign in</html>")).toEqual(NO_FEATURES)
    expect(parseFeaturesReply(true, 7)).toEqual(NO_FEATURES)
  })
  it("never hands out the shared NO_FEATURES object to be changed", () => {
    const a = parseFeaturesReply(false, null)
    a.addService = true
    expect(NO_FEATURES.addService).toBe(false)
    expect(parseFeaturesReply(false, null).addService).toBe(false)
  })
})
