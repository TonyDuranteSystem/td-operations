/**
 * P2.8 — Unified /system-health dashboard.
 *
 * Seven widgets per plan §4 lines 578-586:
 *   1. Last run of each registered cron with green/yellow/red status.
 *   2. Latest audit-health-check findings (P0/P1/P2 with drill-down).
 *   3. Last 10 Sentry errors from dbWrite. (API not wired — placeholder.)
 *   4. Current stuck-client counts by service type.
 *   5. Active work locks.
 *   6. Last deploy + CI status.
 *   7. Recent deploy_smoke_results.
 *
 * Auth: the `(dashboard)` layout gates the route — unauthenticated users are
 * redirected. No extra auth gate needed here.
 */

import Link from "next/link"
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  HeartPulse,
  Lock,
  Rocket,
  ShieldAlert,
} from "lucide-react"
import {
  getActiveWorkLocks,
  getCronStatusList,
  getLatestAuditFindings,
  getSentryStatus,
  getSmokeResults,
  getStuckClientsByServiceType,
  formatRelative,
  type TrafficLight,
} from "@/lib/system-health/queries"
import { AuditFindingsDrilldown } from "@/components/system-health/audit-findings-drilldown"

export const dynamic = "force-dynamic"
export const revalidate = 0

const GH_ACTIONS_URL = "https://github.com/TonyDuranteSystem/td-operations/actions"

const LIGHT_STYLES: Record<TrafficLight, { dot: string; label: string; text: string }> = {
  green: { dot: "bg-emerald-500", label: "OK", text: "text-emerald-700" },
  yellow: { dot: "bg-amber-500", label: "Late", text: "text-amber-700" },
  red: { dot: "bg-red-500", label: "Stale/Error", text: "text-red-700" },
  unknown: { dot: "bg-zinc-300", label: "Unknown", text: "text-zinc-500" },
}

function Card({
  title,
  icon: Icon,
  right,
  children,
  testId,
}: {
  title: string
  icon: React.ElementType
  right?: React.ReactNode
  children: React.ReactNode
  testId: string
}) {
  return (
    <section
      data-testid={testId}
      className="rounded-lg border border-zinc-200 bg-white"
    >
      <header className="flex items-center gap-2 border-b border-zinc-100 px-4 py-3">
        <Icon className="h-4 w-4 text-zinc-500" />
        <h2 className="text-sm font-semibold text-zinc-900">{title}</h2>
        {right && <div className="ml-auto">{right}</div>}
      </header>
      <div className="p-4">{children}</div>
    </section>
  )
}

export default async function SystemHealthPage() {
  const now = Date.now()

  const [cronRows, audit, stuck, locks, smoke] = await Promise.all([
    getCronStatusList(now),
    getLatestAuditFindings(),
    getStuckClientsByServiceType(now),
    getActiveWorkLocks(now),
    getSmokeResults(10),
  ])
  const sentry = getSentryStatus()

  const redCount = cronRows.filter((r) => r.status === "red").length
  const yellowCount = cronRows.filter((r) => r.status === "yellow").length
  const greenCount = cronRows.filter((r) => r.status === "green").length

  const latestSmoke = smoke[0] ?? null

  return (
    <div className="p-6 lg:p-8" data-testid="system-health-page">
      <div className="mb-6">
        <div className="flex items-center gap-2">
          <HeartPulse className="h-6 w-6 text-zinc-700" />
          <h1 className="text-2xl font-semibold tracking-tight">System Health</h1>
        </div>
        <p className="mt-1 text-sm text-zinc-500">
          Live operations visibility — crons, audit findings, deploys, work locks.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 xl:grid-cols-3">
        {/* Widget 1: Cron status */}
        <div className="lg:col-span-2 xl:col-span-2">
          <Card
            title="Cron Status"
            icon={Activity}
            testId="widget-cron-status"
            right={
              <div className="flex items-center gap-3 text-xs font-medium">
                <span className="flex items-center gap-1 text-emerald-700">
                  <span className="inline-block h-2 w-2 rounded-full bg-emerald-500" />
                  {greenCount}
                </span>
                <span className="flex items-center gap-1 text-amber-700">
                  <span className="inline-block h-2 w-2 rounded-full bg-amber-500" />
                  {yellowCount}
                </span>
                <span className="flex items-center gap-1 text-red-700">
                  <span className="inline-block h-2 w-2 rounded-full bg-red-500" />
                  {redCount}
                </span>
              </div>
            }
          >
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-zinc-100 text-left text-[11px] uppercase tracking-wide text-zinc-500">
                    <th className="py-2 pr-2">Status</th>
                    <th className="py-2 pr-2">Endpoint</th>
                    <th className="py-2 pr-2">Schedule</th>
                    <th className="py-2 pr-2">Last Run</th>
                    <th className="py-2 pr-2">Duration</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-50">
                  {cronRows.map((r) => {
                    const style = LIGHT_STYLES[r.status]
                    return (
                      <tr key={r.endpoint} data-testid={`cron-row-${r.endpoint}`}>
                        <td className="py-2 pr-2">
                          <span className="flex items-center gap-1.5">
                            <span className={`inline-block h-2 w-2 rounded-full ${style.dot}`} />
                            <span className={`text-[11px] font-medium ${style.text}`}>
                              {style.label}
                            </span>
                          </span>
                        </td>
                        <td className="py-2 pr-2 font-mono text-[11px] text-zinc-800">
                          {r.endpoint}
                        </td>
                        <td className="py-2 pr-2 font-mono text-[11px] text-zinc-500">
                          {r.schedule}
                        </td>
                        <td className="py-2 pr-2 text-zinc-700" title={r.lastRunAt ?? "never"}>
                          {formatRelative(r.ageMs, now)}
                          {r.lastStatus === "error" && (
                            <span className="ml-1 text-[10px] font-semibold uppercase text-red-700">
                              err
                            </span>
                          )}
                        </td>
                        <td className="py-2 pr-2 font-mono text-[11px] tabular-nums text-zinc-500">
                          {r.lastDurationMs !== null ? `${r.lastDurationMs}ms` : "—"}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </Card>
        </div>

        {/* Widget 2: Audit findings */}
        <div className="lg:col-span-2 xl:col-span-1">
          <Card
            title="Audit Health Check"
            icon={ShieldAlert}
            testId="widget-audit-findings"
            right={
              audit.executedAt ? (
                <span className="text-[11px] text-zinc-500" title={audit.executedAt}>
                  {formatRelative(now - new Date(audit.executedAt).getTime(), now)}
                </span>
              ) : null
            }
          >
            <div className="mb-3 flex gap-2 text-xs">
              <span className="inline-flex items-center gap-1 rounded bg-red-100 px-2 py-1 font-semibold text-red-700 ring-1 ring-red-200">
                P0 <span className="tabular-nums">{audit.p0}</span>
              </span>
              <span className="inline-flex items-center gap-1 rounded bg-amber-100 px-2 py-1 font-semibold text-amber-700 ring-1 ring-amber-200">
                P1 <span className="tabular-nums">{audit.p1}</span>
              </span>
              <span className="inline-flex items-center gap-1 rounded bg-zinc-100 px-2 py-1 font-semibold text-zinc-700 ring-1 ring-zinc-200">
                P2 <span className="tabular-nums">{audit.p2}</span>
              </span>
              <span className="ml-auto inline-flex items-center text-[11px] text-zinc-500">
                {audit.totalAffected} rows affected
              </span>
            </div>
            <AuditFindingsDrilldown findings={audit.findings} />
          </Card>
        </div>

        {/* Widget 4: Stuck clients by service type */}
        <Card title="Stuck Clients" icon={AlertTriangle} testId="widget-stuck-clients">
          {stuck.nullStageByType.length === 0 && stuck.stuckActivations === 0 ? (
            <p className="text-sm text-emerald-700">
              <CheckCircle2 className="mr-1 inline h-4 w-4" />
              No stuck clients.
            </p>
          ) : (
            <>
              {stuck.nullStageByType.length > 0 && (
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-zinc-100 text-left text-[11px] uppercase tracking-wide text-zinc-500">
                      <th className="py-1.5 pr-2">Service Type</th>
                      <th className="py-1.5 pr-2 text-right">Active / Null Stage</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-50">
                    {stuck.nullStageByType.map((r) => (
                      <tr key={r.service_type}>
                        <td className="py-1.5 pr-2 text-zinc-800">{r.service_type}</td>
                        <td className="py-1.5 pr-2 text-right font-mono tabular-nums text-zinc-900">
                          {r.count}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <div className="mt-3 border-t border-zinc-100 pt-3 text-xs">
                <span className="font-medium text-zinc-700">
                  Pending activations stuck &gt; 7d:
                </span>{" "}
                <span
                  className={`font-mono tabular-nums ${
                    stuck.stuckActivations > 0 ? "font-semibold text-red-700" : "text-zinc-500"
                  }`}
                >
                  {stuck.stuckActivations}
                </span>
              </div>
            </>
          )}
        </Card>

        {/* Widget 5: Active work locks */}
        <Card title="Active Work Locks" icon={Lock} testId="widget-work-locks">
          {locks.length === 0 ? (
            <p className="text-sm text-zinc-500">No active locks.</p>
          ) : (
            <ul className="divide-y divide-zinc-100 text-xs">
              {locks.map((l) => (
                <li key={l.id} className="py-2">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[11px] text-zinc-900">{l.file_path}</span>
                    <span className="ml-auto text-[11px] text-zinc-500">
                      {formatRelative(l.ageMs, now)}
                    </span>
                  </div>
                  <div className="mt-0.5 flex items-center gap-2 text-[11px] text-zinc-500">
                    <span>by {l.locked_by}</span>
                    {l.reason && <span>· {l.reason}</span>}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>

        {/* Widget 6: Last deploy + CI status */}
        <Card title="Last Deploy + CI" icon={Rocket} testId="widget-last-deploy">
          {!latestSmoke ? (
            <p className="text-sm text-zinc-500">No deploy smoke results yet.</p>
          ) : (
            <div className="space-y-2 text-xs">
              <div className="flex items-center gap-2">
                <span
                  className={`inline-block h-2 w-2 rounded-full ${
                    latestSmoke.any_failed ? "bg-red-500" : "bg-emerald-500"
                  }`}
                />
                <span
                  className={`font-semibold ${
                    latestSmoke.any_failed ? "text-red-700" : "text-emerald-700"
                  }`}
                >
                  Smoke {latestSmoke.any_failed ? "failing" : "passing"}
                </span>
                <span className="ml-auto text-[11px] text-zinc-500">
                  {formatRelative(now - new Date(latestSmoke.checked_at).getTime(), now)}
                </span>
              </div>
              <div>
                <span className="text-zinc-500">Commit:</span>{" "}
                <a
                  href={`https://github.com/TonyDuranteSystem/td-operations/commit/${latestSmoke.commit_sha}`}
                  target="_blank"
                  rel="noreferrer"
                  className="font-mono text-[11px] text-zinc-900 underline decoration-dotted hover:text-blue-600"
                >
                  {latestSmoke.commit_sha.slice(0, 7)}
                </a>
              </div>
              <ul className="space-y-1 border-t border-zinc-100 pt-2">
                {latestSmoke.checks.map((c) => (
                  <li key={c.check} className="flex items-center gap-2">
                    <span
                      className={`inline-block h-1.5 w-1.5 rounded-full ${
                        c.result === "pass" ? "bg-emerald-500" : "bg-red-500"
                      }`}
                    />
                    <span className="font-mono text-[11px] text-zinc-700">{c.check}</span>
                    <span className="ml-auto font-mono text-[10px] tabular-nums text-zinc-500">
                      {c.status}
                    </span>
                  </li>
                ))}
              </ul>
              <div className="flex items-center gap-3 border-t border-zinc-100 pt-2 text-[11px]">
                {latestSmoke.workflow_run_url && (
                  <a
                    href={latestSmoke.workflow_run_url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-blue-600 hover:underline"
                  >
                    Smoke workflow <ExternalLink className="h-3 w-3" />
                  </a>
                )}
                <Link
                  href={GH_ACTIONS_URL}
                  target="_blank"
                  className="inline-flex items-center gap-1 text-blue-600 hover:underline"
                >
                  CI runs <ExternalLink className="h-3 w-3" />
                </Link>
              </div>
            </div>
          )}
        </Card>

        {/* Widget 3: Sentry (placeholder — API not wired) */}
        <Card title="Sentry — dbWrite errors" icon={AlertTriangle} testId="widget-sentry">
          <p className="text-xs text-zinc-600">{sentry.reason}</p>
          {sentry.dashboardUrl && (
            <a
              href={sentry.dashboardUrl}
              target="_blank"
              rel="noreferrer"
              className="mt-2 inline-flex items-center gap-1 text-xs text-blue-600 hover:underline"
            >
              Open Sentry <ExternalLink className="h-3 w-3" />
            </a>
          )}
        </Card>

        {/* Widget 7: Recent deploy_smoke_results */}
        <div className="lg:col-span-2 xl:col-span-3">
          <Card title="Recent Smoke Runs" icon={Rocket} testId="widget-smoke-history">
            {smoke.length === 0 ? (
              <p className="text-sm text-zinc-500">No smoke runs recorded yet.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-zinc-100 text-left text-[11px] uppercase tracking-wide text-zinc-500">
                      <th className="py-2 pr-2">When</th>
                      <th className="py-2 pr-2">Commit</th>
                      <th className="py-2 pr-2">Result</th>
                      <th className="py-2 pr-2">Failures</th>
                      <th className="py-2 pr-2">Checks</th>
                      <th className="py-2 pr-2">Workflow</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-50">
                    {smoke.map((r) => (
                      <tr key={r.id} data-testid={`smoke-row-${r.id}`}>
                        <td className="py-2 pr-2 text-zinc-700" title={r.checked_at}>
                          {formatRelative(now - new Date(r.checked_at).getTime(), now)}
                        </td>
                        <td className="py-2 pr-2 font-mono text-[11px]">
                          <a
                            href={`https://github.com/TonyDuranteSystem/td-operations/commit/${r.commit_sha}`}
                            target="_blank"
                            rel="noreferrer"
                            className="text-zinc-900 underline decoration-dotted hover:text-blue-600"
                          >
                            {r.commit_sha.slice(0, 7)}
                          </a>
                        </td>
                        <td className="py-2 pr-2">
                          <span
                            className={`inline-block h-2 w-2 rounded-full ${
                              r.any_failed ? "bg-red-500" : "bg-emerald-500"
                            }`}
                          />
                          <span
                            className={`ml-1.5 text-[11px] font-medium ${
                              r.any_failed ? "text-red-700" : "text-emerald-700"
                            }`}
                          >
                            {r.any_failed ? "fail" : "pass"}
                          </span>
                        </td>
                        <td className="py-2 pr-2 font-mono tabular-nums text-zinc-700">
                          {r.failure_count}
                        </td>
                        <td className="py-2 pr-2 text-[11px] text-zinc-500">
                          {r.checks.length} checks
                        </td>
                        <td className="py-2 pr-2 text-[11px]">
                          {r.workflow_run_url ? (
                            <a
                              href={r.workflow_run_url}
                              target="_blank"
                              rel="noreferrer"
                              className="inline-flex items-center gap-1 text-blue-600 hover:underline"
                            >
                              view <ExternalLink className="h-3 w-3" />
                            </a>
                          ) : (
                            <span className="text-zinc-400">—</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </div>
      </div>
    </div>
  )
}
