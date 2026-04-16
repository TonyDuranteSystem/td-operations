/**
 * P2.6 — post-deploy smoke-alert email formatter.
 *
 * Covers the pure `buildAlertEmail` helper exported from the route. The
 * auth + gmailPost side of the route is covered implicitly by the GH
 * workflow hitting a real deployment.
 */

import { describe, it, expect } from "vitest"
import { buildAlertEmail } from "@/lib/post-deploy-smoke"

describe("buildAlertEmail", () => {
  const baseFailure = {
    check: "app_root_200",
    url: "https://app.tonydurante.us/",
    expected: "HTTP 200",
    actual: "HTTP 502",
  }

  it("subject includes failure count and short commit SHA", () => {
    const { subject } = buildAlertEmail({
      failures: [baseFailure, { ...baseFailure, check: "portal_login_200" }],
      commit_sha: "0975c004d047d3671db3dd353d539a06cb896160",
    })
    expect(subject).toContain("2 checks")
    expect(subject).toContain("0975c00")
    expect(subject).toMatch(/^🚨/)
  })

  it("subject uses 'unknown' when commit_sha is missing", () => {
    const { subject } = buildAlertEmail({ failures: [baseFailure] })
    expect(subject).toContain("unknown")
    expect(subject).toContain("1 check ")
  })

  it("body contains one row per failure", () => {
    const { html } = buildAlertEmail({
      failures: [
        baseFailure,
        { check: "audit_health_check_json", url: "/api/cron/audit-health-check", expected: "200+findings", actual: "401", error: "bearer rejected" },
      ],
    })
    expect(html).toContain("app_root_200")
    expect(html).toContain("audit_health_check_json")
    expect(html).toContain("bearer rejected")
    // Two <tr> rows inside <tbody>.
    const tbodyMatch = html.match(/<tbody>([\s\S]*?)<\/tbody>/)
    expect(tbodyMatch).toBeTruthy()
    const rowCount = (tbodyMatch![1].match(/<tr /g) ?? []).length
    expect(rowCount).toBe(2)
  })

  it("escapes HTML to prevent injection via URL / reason fields", () => {
    const { html } = buildAlertEmail({
      failures: [{
        check: "xss_check",
        url: "https://evil.com/<script>alert(1)</script>",
        expected: "HTTP 200",
        actual: `<img src=x onerror="alert(2)">`,
      }],
    })
    expect(html).not.toContain("<script>alert(1)</script>")
    expect(html).not.toContain(`onerror="alert(2)"`)
    expect(html).toContain("&lt;script&gt;")
    expect(html).toContain("&quot;")
  })

  it("renders workflow run link when provided", () => {
    const { html } = buildAlertEmail({
      failures: [baseFailure],
      workflow_run_url: "https://github.com/TonyDuranteSystem/td-operations/actions/runs/123",
    })
    expect(html).toContain("View GitHub Actions run")
    expect(html).toContain("https://github.com/TonyDuranteSystem/td-operations/actions/runs/123")
  })

  it("omits workflow run section when workflow_run_url is absent", () => {
    const { html } = buildAlertEmail({ failures: [baseFailure] })
    expect(html).not.toContain("View GitHub Actions run")
  })

  it("uses singular grammar for a single failure", () => {
    const { subject, html } = buildAlertEmail({ failures: [baseFailure] })
    expect(subject).toContain("1 check ")
    expect(subject).not.toContain("checks")
    expect(html).toContain("1</strong> check failed")
  })
})
