/**
 * Unit tests for the sandbox simulate-payment endpoint.
 *
 * Focuses on the `isProductionEnvironment()` guard — the critical safety
 * check that prevents this endpoint from running against the production
 * Supabase project.
 */

import { describe, it, expect, afterEach } from "vitest"

import { isProductionEnvironment } from "@/lib/sandbox/guard"

const PROD_REF = "ydzipybqeebtpcvsbtvs"
const SANDBOX_REF = "xjcxlmlpeywtwkhstjlw"

describe("isProductionEnvironment", () => {
  const saved = process.env.NEXT_PUBLIC_SUPABASE_URL

  afterEach(() => {
    if (saved !== undefined) {
      process.env.NEXT_PUBLIC_SUPABASE_URL = saved
    } else {
      delete process.env.NEXT_PUBLIC_SUPABASE_URL
    }
  })

  it("returns true for production Supabase URL (explicit arg)", () => {
    expect(isProductionEnvironment(`https://${PROD_REF}.supabase.co`)).toBe(true)
  })

  it("returns false for sandbox Supabase URL (explicit arg)", () => {
    expect(isProductionEnvironment(`https://${SANDBOX_REF}.supabase.co`)).toBe(false)
  })

  it("returns false for empty string", () => {
    expect(isProductionEnvironment("")).toBe(false)
  })

  it("falls back to NEXT_PUBLIC_SUPABASE_URL env var when no arg given", () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = `https://${PROD_REF}.supabase.co`
    expect(isProductionEnvironment()).toBe(true)
  })

  it("returns false when env var is the sandbox ref", () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = `https://${SANDBOX_REF}.supabase.co`
    expect(isProductionEnvironment()).toBe(false)
  })

  it("returns false when env var is unset", () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL
    expect(isProductionEnvironment()).toBe(false)
  })
})
