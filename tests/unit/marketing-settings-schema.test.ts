import { describe, it, expect } from "vitest"
import {
  MARKETING_SETTING_KEYS, defaultForSetting, failClosedValue, isMarketingSettingKey, parseSettingValue, resolveSetting,
} from "@/lib/marketing/settings-schema"

describe("marketing settings schema", () => {
  it("every key has a default that passes its own rules", () => {
    for (const k of MARKETING_SETTING_KEYS) {
      expect(parseSettingValue(k, defaultForSetting(k)).ok, k).toBe(true)
    }
  })
  it("starts with Antonio's rulings: owner has offers and export ON, member approvals off, no confirm limit", () => {
    expect(defaultForSetting("owner_may_create_offers")).toBe(true)
    expect(defaultForSetting("owner_may_export_leads")).toBe(true)
    expect(defaultForSetting("member_invites_need_approval")).toBe(false)
    expect(defaultForSetting("confirm_above_amount")).toBeNull()
  })
  it("the first stage is where a new lead lands", () => {
    expect(defaultForSetting("pipeline_stages")[0].key).toBe("new")
  })
  it("a default is a copy: changing it never changes the next caller's", () => {
    const a = defaultForSetting("pipeline_stages")
    a.push({ key: "x", label: "X" })
    expect(defaultForSetting("pipeline_stages").length).toBe(8)
  })
  it("rejects unknown keys and bad shapes with a plain message", () => {
    expect(parseSettingValue("nope", 1)).toEqual({ ok: false, error: 'Unknown setting "nope".' })
    const bad = parseSettingValue("owner_may_create_offers", "yes")
    expect(bad.ok).toBe(false)
  })
  it("rejects duplicate stage keys, empty lists and bad key characters", () => {
    expect(parseSettingValue("pipeline_stages", [{ key: "a", label: "A" }, { key: "a", label: "B" }]).ok).toBe(false)
    expect(parseSettingValue("pipeline_stages", []).ok).toBe(false)
    expect(parseSettingValue("pipeline_stages", [{ key: "Bad Key", label: "A" }]).ok).toBe(false)
  })
  it("currencies must be three capital letters", () => {
    expect(parseSettingValue("allowed_currencies", ["USD", "EUR", "GBP"]).ok).toBe(true)
    expect(parseSettingValue("allowed_currencies", ["usd"]).ok).toBe(false)
    expect(parseSettingValue("allowed_currencies", []).ok).toBe(false)
  })
  it("confirm_above_amount takes a positive number or null, never 0 or negative", () => {
    expect(parseSettingValue("confirm_above_amount", 5000).ok).toBe(true)
    expect(parseSettingValue("confirm_above_amount", null).ok).toBe(true)
    expect(parseSettingValue("confirm_above_amount", 0).ok).toBe(false)
    expect(parseSettingValue("confirm_above_amount", -1).ok).toBe(false)
  })
  it("resolveSetting: stored value wins; missing or stale value falls back", () => {
    expect(resolveSetting("owner_may_create_offers", false)).toEqual({ value: false, usedFallback: false })
    expect(resolveSetting("owner_may_create_offers", undefined)).toEqual({ value: true, usedFallback: true })
    expect(resolveSetting("owner_may_create_offers", "garbage")).toEqual({ value: true, usedFallback: true })
  })
  it("isMarketingSettingKey does not accept inherited object keys", () => {
    expect(isMarketingSettingKey("pipeline_stages")).toBe(true)
    expect(isMarketingSettingKey("toString")).toBe(false)
    expect(isMarketingSettingKey("__proto__")).toBe(false)
  })
})

describe("a broken permission setting closes the door", () => {
  it("a stored permission_bundles value that no longer fits the rules gives NO bundles (not the wider default)", () => {
    const r = resolveSetting("permission_bundles", { setter: "not a list" })
    expect(r.usedFallback).toBe(true)
    expect(r.value).toEqual({})
    expect(r.value).not.toEqual(defaultForSetting("permission_bundles"))
  })
  it("a permission_bundles value that was never stored still starts from the built-in default (the intended first state)", () => {
    expect(resolveSetting("permission_bundles", undefined).value).toEqual(defaultForSetting("permission_bundles"))
  })
  it("a valid stored value is used as it is", () => {
    const ok = { setter: ["leads.read"] }
    expect(resolveSetting("permission_bundles", ok)).toEqual({ value: ok, usedFallback: false })
  })
  it("other settings still fall back to their defaults when broken (only access-granting ones fail closed)", () => {
    expect(resolveSetting("owner_may_create_offers", "nonsense").value).toBe(defaultForSetting("owner_may_create_offers"))
    expect(failClosedValue("owner_may_create_offers")).toBeUndefined()
    expect(failClosedValue("permission_bundles")).toEqual({})
  })
})

describe("seller_payout_currency", () => {
  it("defaults to empty (the sale's own currency) and accepts a three-letter code or empty only", () => {
    expect(defaultForSetting("seller_payout_currency")).toBe("")
    expect(parseSettingValue("seller_payout_currency", "USD")).toEqual({ ok: true, value: "USD" })
    expect(parseSettingValue("seller_payout_currency", "")).toEqual({ ok: true, value: "" })
    for (const bad of ["usd", "US", "DOLLARS", 5, null]) expect(parseSettingValue("seller_payout_currency", bad).ok).toBe(false)
  })
})
