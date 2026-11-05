/**
 * TD Social — which server is this and which app belongs to it (dev job 2072bc3e, Step 2 pull request A).
 * A server only ever accepts its OWN app; anything it cannot recognise is "unknown" and accepts nothing.
 */
import { describe, it, expect } from "vitest"
import { appServerEnv, allowedBundleId, supabaseRefFromUrl, TD_SOCIAL_BUNDLE_IDS, SANDBOX_SUPABASE_REF } from "@/lib/app/environment"
import { PRODUCTION_SUPABASE_REF } from "@/lib/google-drive-guard"

describe("appServerEnv", () => {
  it("recognises production and sandbox by the project reference in the Supabase address", () => {
    expect(appServerEnv(`https://${PRODUCTION_SUPABASE_REF}.supabase.co`)).toBe("production")
    expect(appServerEnv(`https://${SANDBOX_SUPABASE_REF}.supabase.co`)).toBe("sandbox")
    expect(appServerEnv(`https://${SANDBOX_SUPABASE_REF}.supabase.co/`)).toBe("sandbox")
  })

  it("never mistakes a look-alike address, a local stack, a missing value or garbage for either", () => {
    for (const url of [
      undefined, null, "", "not a url",
      "http://127.0.0.1:54321", "http://localhost:54321",
      `http://${PRODUCTION_SUPABASE_REF}.supabase.co`,                 // not https
      `https://${PRODUCTION_SUPABASE_REF}.supabase.co.evil.example`,  // suffix trick
      `https://evil.example/${PRODUCTION_SUPABASE_REF}.supabase.co`,  // path trick
      `https://x${PRODUCTION_SUPABASE_REF}.supabase.co`,              // prefix trick
      "https://abcdefghijklmnopqrst.supabase.co",                      // some other project
    ]) {
      expect(appServerEnv(url as string | null | undefined)).toBe("unknown")
    }
  })

  it("reads the reference only from a real https supabase.co host", () => {
    expect(supabaseRefFromUrl(`https://${SANDBOX_SUPABASE_REF}.supabase.co`)).toBe(SANDBOX_SUPABASE_REF)
    expect(supabaseRefFromUrl("https://evil.example")).toBeNull()
  })
})

describe("allowedBundleId", () => {
  it("each server accepts only its own app", () => {
    expect(allowedBundleId("production")).toBe("com.tonydurante.tdsocial")
    expect(allowedBundleId("sandbox")).toBe("com.tonydurante.tdsocial.sandbox")
    expect(allowedBundleId("production")).not.toBe(allowedBundleId("sandbox"))
  })

  it("an unknown server accepts nothing", () => {
    expect(allowedBundleId("unknown")).toBeNull()
  })

  it("the production id is not a prefix trick for the sandbox one in a simple equality check", () => {
    expect(TD_SOCIAL_BUNDLE_IDS.production === TD_SOCIAL_BUNDLE_IDS.sandbox).toBe(false)
  })
})
