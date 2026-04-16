/**
 * P2.6 — post-deploy smoke alert helpers.
 *
 * Extracted from app/api/internal/smoke-alert/route.ts because Next.js 14
 * strict route-type checking rejects non-route exports from route files
 * (only GET/POST/… are allowed as exports). Keeping the pure formatter in
 * lib/ lets the route file stay route-only and the formatter stay testable.
 */

export interface SmokeFailure {
  check: string
  url: string
  expected: string
  actual: string
  error?: string
}

export interface SmokeAlertBody {
  failures: SmokeFailure[]
  commit_sha?: string
  workflow_run_url?: string
  checked_at?: string
}

/**
 * Build the alert email subject + HTML body. Pure function — no I/O, no env
 * access. Safe to call from tests.
 */
export function buildAlertEmail(body: SmokeAlertBody): { subject: string; html: string } {
  const count = body.failures.length
  const sha = (body.commit_sha || "").slice(0, 7) || "unknown"
  const subject = `🚨 Post-deploy smoke FAILED — ${count} check${count === 1 ? "" : "s"} (commit ${sha})`

  const rows = body.failures
    .map(f => `
      <tr style="border-bottom:1px solid #e4e4e7;">
        <td style="padding:8px;font-size:12px;color:#dc2626;font-weight:600;">${escapeHtml(f.check)}</td>
        <td style="padding:8px;font-size:12px;font-family:ui-monospace,monospace;">${escapeHtml(f.url)}</td>
        <td style="padding:8px;font-size:12px;color:#52525b;">expected: ${escapeHtml(f.expected)}</td>
        <td style="padding:8px;font-size:12px;color:#dc2626;">actual: ${escapeHtml(f.actual)}${f.error ? `<br/><span style="color:#71717a;font-size:11px;">${escapeHtml(f.error)}</span>` : ""}</td>
      </tr>`)
    .join("")

  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:900px;margin:0 auto;padding:20px;">
      <h2 style="font-size:18px;color:#dc2626;margin:0 0 8px 0;">🚨 Post-deploy smoke check FAILED</h2>
      <p style="color:#52525b;font-size:13px;margin:0 0 16px 0;">
        <strong>${count}</strong> check${count === 1 ? "" : "s"} failed after the latest deploy.
        ${body.commit_sha ? `Commit: <code>${escapeHtml(body.commit_sha.slice(0, 12))}</code> · ` : ""}
        ${body.checked_at ? `At: ${escapeHtml(body.checked_at)}` : ""}
      </p>
      <table style="width:100%;border-collapse:collapse;margin-top:8px;">
        <thead>
          <tr style="background:#f4f4f5;">
            <th style="padding:8px;text-align:left;font-size:11px;color:#71717a;">Check</th>
            <th style="padding:8px;text-align:left;font-size:11px;color:#71717a;">URL</th>
            <th style="padding:8px;text-align:left;font-size:11px;color:#71717a;">Expected</th>
            <th style="padding:8px;text-align:left;font-size:11px;color:#71717a;">Actual</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
      ${body.workflow_run_url ? `<p style="margin-top:16px;font-size:12px;"><a href="${escapeHtml(body.workflow_run_url)}" style="color:#2563eb;">View GitHub Actions run →</a></p>` : ""}
      <p style="color:#a1a1aa;font-size:11px;margin-top:24px;">
        Source: /api/internal/smoke-alert · P2.6 post-deploy smoke
      </p>
    </div>
  `
  return { subject, html }
}

function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}
