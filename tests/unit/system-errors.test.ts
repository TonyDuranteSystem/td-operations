/**
 * Error auto-audit system — pure-helper tests (lib/system-errors.ts).
 *
 * Covers: message normalization, fingerprint stability across volatile
 * values (UUIDs, numbers, emails), input clamping, and diagnosis-reply
 * parsing. DB wrappers are thin and exercised in sandbox QA.
 */

import { describe, it, expect } from "vitest"
import {
  normalizeErrorMessage,
  computeErrorFingerprint,
  clampErrorInput,
  parseDiagnosisReply,
  buildDiagnosisPrompt,
  type SystemErrorRow,
} from "@/lib/system-errors"

describe("normalizeErrorMessage", () => {
  it("replaces UUIDs, long numbers, and emails with placeholders", () => {
    const msg = "Offer 3f8a1b2c-4d5e-6f70-8192-a3b4c5d6e7f8 for mark@example.com failed after 90000ms"
    const norm = normalizeErrorMessage(msg)
    expect(norm).not.toContain("3f8a1b2c")
    expect(norm).toContain("<uuid>")
    expect(norm).toContain("<email>")
    expect(norm).toContain("<n>")
  })

  it("collapses whitespace and lowercases", () => {
    expect(normalizeErrorMessage("  Foo   BAR\n baz ")).toBe("foo bar baz")
  })

  it("caps length at 300 chars", () => {
    expect(normalizeErrorMessage("x".repeat(1000)).length).toBeLessThanOrEqual(300)
  })
})

describe("computeErrorFingerprint", () => {
  const base = { source: "client" as const, route: "/api/crm/admin-actions/create-offer", http_status: 500 }

  it("is stable when only volatile values differ", () => {
    const a = computeErrorFingerprint({ ...base, message: "Insert failed for id 111111 (user a@b.com)" })
    const b = computeErrorFingerprint({ ...base, message: "Insert failed for id 999999 (user c@d.it)" })
    expect(a).toBe(b)
  })

  it("differs across routes, statuses, and distinct messages", () => {
    const a = computeErrorFingerprint({ ...base, message: "boom" })
    expect(computeErrorFingerprint({ ...base, route: "/api/other", message: "boom" })).not.toBe(a)
    expect(computeErrorFingerprint({ ...base, http_status: 401, message: "boom" })).not.toBe(a)
    expect(computeErrorFingerprint({ ...base, message: "different failure" })).not.toBe(a)
  })

  it("treats null status as its own bucket", () => {
    const withStatus = computeErrorFingerprint({ ...base, message: "boom" })
    const noStatus = computeErrorFingerprint({ ...base, http_status: null, message: "boom" })
    expect(withStatus).not.toBe(noStatus)
  })
})

describe("clampErrorInput", () => {
  it("caps oversized free-text fields", () => {
    const clamped = clampErrorInput({
      source: "client",
      route: "r".repeat(1000),
      message: "m".repeat(5000),
      body_snippet: "b".repeat(10000),
      method: "POSTPOSTPOST",
    })
    expect(clamped.route.length).toBe(300)
    expect(clamped.message.length).toBe(1000)
    expect(clamped.body_snippet?.length).toBe(2000)
    expect(clamped.method?.length).toBeLessThanOrEqual(10)
  })

  it("replaces an oversized context with a truncation marker", () => {
    const clamped = clampErrorInput({
      source: "server",
      route: "/api/x",
      message: "m",
      context: { big: "z".repeat(5000) },
    })
    expect(clamped.context).toEqual({ truncated: true })
  })

  it("passes through small context and null optionals", () => {
    const clamped = clampErrorInput({ source: "server", route: "/api/x", message: "m", context: { a: 1 } })
    expect(clamped.context).toEqual({ a: 1 })
    expect(clamped.body_snippet).toBeNull()
    expect(clamped.page_path).toBeNull()
  })
})

describe("parseDiagnosisReply", () => {
  it("parses plain JSON", () => {
    const out = parseDiagnosisReply('{"diagnosis": "Session died.", "suggested_fix": "Log in again."}')
    expect(out).toEqual({ diagnosis: "Session died.", suggested_fix: "Log in again." })
  })

  it("strips markdown fences", () => {
    const out = parseDiagnosisReply('```json\n{"diagnosis": "d", "suggested_fix": "f"}\n```')
    expect(out).toEqual({ diagnosis: "d", suggested_fix: "f" })
  })

  it("returns null on wrong shape or invalid JSON", () => {
    expect(parseDiagnosisReply('{"diagnosis": "only one field"}')).toBeNull()
    expect(parseDiagnosisReply("not json at all")).toBeNull()
  })
})

describe("buildDiagnosisPrompt", () => {
  it("includes the capture facts and demands strict JSON", () => {
    const row: SystemErrorRow = {
      id: "x",
      fingerprint: "f",
      source: "client",
      route: "/api/crm/admin-actions/generate-offer-narrative",
      method: "POST",
      http_status: 405,
      page_path: "/contacts/abc",
      user_email: "antonio@tonydurante.us",
      message: "Non-JSON error response (HTTP 405)",
      body_snippet: "Method Not Allowed",
      context: null,
      occurrence_count: 3,
      first_seen: "2026-07-07T09:00:00Z",
      last_seen: "2026-07-07T09:25:00Z",
      status: "open",
      diagnosis: null,
      suggested_fix: null,
      diagnosed_at: null,
    }
    const { systemPrompt, userPrompt } = buildDiagnosisPrompt(row)
    expect(systemPrompt).toContain("STRICT JSON")
    expect(userPrompt).toContain("generate-offer-narrative")
    expect(userPrompt).toContain("405")
    expect(userPrompt).toContain("Method Not Allowed")
    expect(userPrompt).toContain("occurrences: 3")
  })
})
