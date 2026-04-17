/**
 * Gate 2 #3 — "Post-deploy smoke catches a broken bundle"
 * (plan §9.5 line 952).
 *
 * Proves the three failure paths of the post-deploy smoke system work
 * without pushing broken code to main and without client-facing risk:
 *
 *   Path A — Detection.  Shell case pattern in
 *     .github/workflows/post-deploy-smoke.yml classifies 4xx/5xx as
 *     result=fail. Tested here as an equivalent JS case so the rule
 *     itself is asserted — the shell transcript is covered by
 *     scripts/verify-smoke-detection.sh.
 *
 *   Path B — Persistence.  POST to /api/webhooks/smoke-result with a
 *     failed-checks payload inserts a row with any_failed=true and
 *     failure_count>0. The row is consumed by /system-health (P2.8).
 *
 *   Path C — Alert.  buildAlertEmail composes a subject + HTML body
 *     that includes every failed check. Email-send side is mocked out
 *     (gmailPost is called but not actually dispatched).
 *
 * The shell + curl side of the workflow can only be exercised by a
 * real HTTP call to a broken target. scripts/verify-smoke-detection.sh
 * does that for a known 500 and prints the classification — the
 * produced row in deploy_smoke_results is the live proof.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { buildAlertEmail } from "@/lib/post-deploy-smoke"
import { NextRequest } from "next/server"

/** Replica of the shell case in .github/workflows/post-deploy-smoke.yml:
 *     case "$STATUS" in
 *       2*|3*) result=pass ;;
 *       *)     result=fail ;;
 *     esac
 *  Kept as a parallel implementation so a test asserts the rule even if
 *  the YAML is refactored.
 */
function classifyStatus(status: string): "pass" | "fail" {
  if (/^[23]/.test(status)) return "pass"
  return "fail"
}

describe("Gate 2 #3 — smoke catches broken bundle / Path A: detection", () => {
  it("classifies 2xx as pass", () => {
    for (const s of ["200", "201", "204", "299"]) {
      expect(classifyStatus(s)).toBe("pass")
    }
  })
  it("classifies 3xx as pass (auth-gated routes return 307)", () => {
    for (const s of ["301", "302", "307", "308"]) {
      expect(classifyStatus(s)).toBe("pass")
    }
  })
  it("classifies 4xx as fail — the core broken-bundle signature", () => {
    for (const s of ["400", "401", "403", "404"]) {
      expect(classifyStatus(s)).toBe("fail")
    }
  })
  it("classifies 5xx as fail — the other core broken-bundle signature", () => {
    for (const s of ["500", "502", "503", "504"]) {
      expect(classifyStatus(s)).toBe("fail")
    }
  })
  it("classifies curl-fail (000 / empty) as fail", () => {
    expect(classifyStatus("000")).toBe("fail")
    expect(classifyStatus("")).toBe("fail")
  })
})

// ─── Path B: persistence ────────────────────────────────────
// Mock supabaseAdmin BEFORE importing the route.

interface CapturedInsert {
  commit_sha: string
  any_failed: boolean
  failure_count: number
  workflow_run_url: string | null
  checks: unknown
}
let capturedInsert: CapturedInsert | null = null

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      if (table !== "deploy_smoke_results") {
        throw new Error(`unexpected table: ${table}`)
      }
      return {
        insert: (payload: CapturedInsert) => {
          capturedInsert = payload
          return {
            select: () => ({
              single: () =>
                Promise.resolve({
                  data: { id: "00000000-0000-0000-0000-000000000000" },
                  error: null,
                }),
            }),
          }
        },
      }
    },
  },
}))

// Import AFTER the mock is registered.
import { POST as smokeResultPOST } from "@/app/api/webhooks/smoke-result/route"

describe("Gate 2 #3 / Path B: /api/webhooks/smoke-result persists the broken-bundle signal", () => {
  beforeEach(() => {
    capturedInsert = null
    process.env.CRON_SECRET = "gate2-3-test-secret"
  })

  it("writes any_failed=true + failure_count>0 when any check has result=fail", async () => {
    const syntheticFailurePayload = {
      commit_sha: "gate2-3-synthetic-broken-bundle",
      workflow_run_url: "https://github.com/TonyDuranteSystem/td-operations/actions/runs/9999",
      checked_at: "2026-04-17T00:59:00Z",
      checks: [
        { check: "app_root", url: "https://app.tonydurante.us/", status: "500", result: "fail", expected: "HTTP 2xx/3xx" },
        { check: "api_health", url: "https://td-operations.vercel.app/api/health", status: "500", result: "fail", expected: "HTTP 200 + .ok=true", reason: "http_500" },
        { check: "portal_login", url: "https://portal.tonydurante.us/portal/login", status: "307", result: "pass", expected: "HTTP 2xx/3xx" },
        { check: "crm_root", url: "https://td-operations.vercel.app/", status: "307", result: "pass", expected: "HTTP 2xx/3xx" },
        { check: "audit_health_check_json", url: "https://td-operations.vercel.app/api/cron/audit-health-check", status: "500", result: "fail", expected: "HTTP 200 + JSON.findings array", reason: "http_500" },
      ],
    }

    const req = new NextRequest("http://localhost/api/webhooks/smoke-result", {
      method: "POST",
      headers: {
        authorization: "Bearer gate2-3-test-secret",
        "content-type": "application/json",
      },
      body: JSON.stringify(syntheticFailurePayload),
    })

    const res = await smokeResultPOST(req)
    const body = (await res.json()) as { ok: boolean; any_failed: boolean; failure_count: number }

    expect(res.status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.any_failed).toBe(true)
    expect(body.failure_count).toBe(3)

    expect(capturedInsert).not.toBeNull()
    expect(capturedInsert!.any_failed).toBe(true)
    expect(capturedInsert!.failure_count).toBe(3)
    expect(capturedInsert!.commit_sha).toBe("gate2-3-synthetic-broken-bundle")
  })

  it("writes any_failed=false when all checks pass (baseline sanity)", async () => {
    const passPayload = {
      commit_sha: "gate2-3-synthetic-all-pass",
      checks: [
        { check: "app_root", url: "https://app.tonydurante.us/", status: "307", result: "pass", expected: "HTTP 2xx/3xx" },
        { check: "api_health", url: "https://td-operations.vercel.app/api/health", status: "200", result: "pass", expected: "HTTP 200 + .ok=true" },
      ],
    }
    const req = new NextRequest("http://localhost/api/webhooks/smoke-result", {
      method: "POST",
      headers: {
        authorization: "Bearer gate2-3-test-secret",
        "content-type": "application/json",
      },
      body: JSON.stringify(passPayload),
    })
    const res = await smokeResultPOST(req)
    const body = (await res.json()) as { ok: boolean; any_failed: boolean; failure_count: number }
    expect(body.any_failed).toBe(false)
    expect(body.failure_count).toBe(0)
    expect(capturedInsert!.any_failed).toBe(false)
  })

  it("rejects unauthenticated callers with 401", async () => {
    const req = new NextRequest("http://localhost/api/webhooks/smoke-result", {
      method: "POST",
      headers: { authorization: "Bearer wrong" },
      body: JSON.stringify({ commit_sha: "x", checks: [] }),
    })
    const res = await smokeResultPOST(req)
    expect(res.status).toBe(401)
  })

  it("rejects invalid payloads with 400", async () => {
    const req = new NextRequest("http://localhost/api/webhooks/smoke-result", {
      method: "POST",
      headers: {
        authorization: "Bearer gate2-3-test-secret",
        "content-type": "application/json",
      },
      body: JSON.stringify({ commit_sha: "" }),
    })
    const res = await smokeResultPOST(req)
    expect(res.status).toBe(400)
  })
})

// ─── Path C: alert ────────────────────────────────────────────
describe("Gate 2 #3 / Path C: alert email composed from broken-bundle failures", () => {
  it("subject names the failure count and short commit SHA", () => {
    const { subject } = buildAlertEmail({
      commit_sha: "b711dea57a22c82f81f0bc2dea28bf58ba1c1b1c",
      failures: [
        { check: "app_root", url: "https://app.tonydurante.us/", expected: "HTTP 2xx/3xx", actual: "HTTP 500" },
        { check: "api_health", url: "https://td-operations.vercel.app/api/health", expected: "HTTP 200 + .ok=true", actual: "HTTP 500 (http_500)" },
      ],
    })
    expect(subject).toContain("FAILED")
    expect(subject).toContain("2 checks")
    expect(subject).toContain("b711dea")
  })

  it("body includes one row per failed check with expected vs actual", () => {
    const { html } = buildAlertEmail({
      failures: [
        { check: "app_root", url: "https://app.tonydurante.us/", expected: "HTTP 2xx/3xx", actual: "HTTP 500" },
        { check: "audit_health_check_json", url: "/api/cron/audit-health-check", expected: "HTTP 200 + JSON.findings array", actual: "HTTP 502", error: "bad gateway" },
      ],
    })
    expect(html).toContain("app_root")
    expect(html).toContain("audit_health_check_json")
    expect(html).toContain("HTTP 500")
    expect(html).toContain("HTTP 502")
    expect(html).toContain("bad gateway")
  })
})
