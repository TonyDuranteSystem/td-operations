/**
 * P3.5 — Exception Handling Center.
 *
 * One CRM page consolidating every "something is broken right now" signal:
 * partial activations, audit cron findings, failed jobs, failed emails,
 * webhook events awaiting review. Each row has a retry or dismiss action
 * where applicable.
 *
 * Plan reference: restructure-plan-final-v1 §4 line 640.
 */

import Link from "next/link"
import { AlertTriangle, ShieldAlert, Zap, Mail, Webhook, ExternalLink } from "lucide-react"
import { getExceptionsSnapshot } from "@/lib/exceptions/queries"
import {
  retryPartialActivation,
  dismissAuditFinding,
  retryFailedJob,
  retryFailedEmail,
  markWebhookReviewed,
} from "./actions"
import { RetryButton } from "./retry-button"

export const dynamic = "force-dynamic"
export const revalidate = 0

function Section({
  title,
  icon: Icon,
  count,
  tone,
  children,
}: {
  title: string
  icon: React.ElementType
  count: number
  tone: "red" | "amber" | "zinc"
  children: React.ReactNode
}) {
  const headerTone = {
    red: "bg-red-50 text-red-900 border-red-200",
    amber: "bg-amber-50 text-amber-900 border-amber-200",
    zinc: "bg-zinc-50 text-zinc-900 border-zinc-200",
  }[tone]
  const countTone = {
    red: "bg-red-600 text-white",
    amber: "bg-amber-500 text-white",
    zinc: "bg-zinc-300 text-zinc-700",
  }[tone]

  return (
    <section className="border border-zinc-200 rounded-lg overflow-hidden bg-white">
      <header className={`flex items-center justify-between px-4 py-3 border-b ${headerTone}`}>
        <div className="flex items-center gap-2">
          <Icon className="h-4 w-4" />
          <h2 className="text-sm font-semibold">{title}</h2>
        </div>
        <span className={`text-xs font-semibold rounded-full px-2 py-0.5 ${countTone}`}>
          {count}
        </span>
      </header>
      <div className="divide-y divide-zinc-100">{children}</div>
    </section>
  )
}

function EmptyRow({ message }: { message: string }) {
  return <div className="px-4 py-6 text-center text-sm text-zinc-500">{message}</div>
}

function formatAge(hours: number | null): string {
  if (hours === null) return "—"
  if (hours < 1) return "<1h"
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  return `${days}d`
}

export default async function ExceptionsPage() {
  const snapshot = await getExceptionsSnapshot()

  return (
    <div className="p-6 lg:p-8 space-y-6 max-w-6xl">
      {/* ── Page header ── */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <AlertTriangle className="h-6 w-6 text-red-600" />
            Exception Handling Center
          </h1>
          <p className="mt-1 text-sm text-zinc-600">
            What is broken right now. {snapshot.totalCount === 0
              ? "System is clean."
              : `${snapshot.totalCount} item${snapshot.totalCount === 1 ? "" : "s"} need attention.`}
          </p>
        </div>
        <Link
          href="/system-health"
          className="text-sm text-blue-600 hover:text-blue-800 inline-flex items-center gap-1"
        >
          System Health
          <ExternalLink className="h-3.5 w-3.5" />
        </Link>
      </div>

      {/* ── Partial activations (stuck clients) ── */}
      <Section
        title="Partial Activations"
        icon={ShieldAlert}
        count={snapshot.partialActivations.length}
        tone="red"
      >
        {snapshot.partialActivations.length === 0 ? (
          <EmptyRow message="No stuck activations." />
        ) : (
          snapshot.partialActivations.map(row => (
            <div key={row.id} className="flex items-center justify-between gap-4 px-4 py-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-medium text-zinc-900">{row.client_name}</span>
                  <span className="text-xs text-zinc-500">{row.client_email}</span>
                  <span className={`text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded ${
                    row.status === "payment_confirmed"
                      ? "bg-red-100 text-red-700"
                      : "bg-amber-100 text-amber-700"
                  }`}>
                    {row.status.replace(/_/g, " ")}
                  </span>
                </div>
                <div className="mt-1 text-xs text-zinc-500 flex gap-3">
                  <span>Offer {row.offer_token}</span>
                  {row.amount && (
                    <span>
                      {row.currency === "EUR" ? "€" : "$"}
                      {Number(row.amount).toFixed(0)} via {row.payment_method ?? "—"}
                    </span>
                  )}
                  <span>Age {formatAge(row.age_hours)}</span>
                </div>
              </div>
              {row.status === "payment_confirmed" && (
                <RetryButton
                  label="Retry Activation"
                  successToast="Activation re-kicked"
                  variant="primary"
                  action={async () => {
                    "use server"
                    return retryPartialActivation(row.id)
                  }}
                />
              )}
            </div>
          ))
        )}
      </Section>

      {/* ── Audit findings ── */}
      <Section
        title="Audit Findings"
        icon={AlertTriangle}
        count={snapshot.auditFindings.length}
        tone="amber"
      >
        {snapshot.auditFindings.length === 0 ? (
          <EmptyRow message="No open audit findings." />
        ) : (
          snapshot.auditFindings.map(row => (
            <div key={row.id} className="flex items-center justify-between gap-4 px-4 py-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded bg-amber-100 text-amber-700">
                    {row.priority}
                  </span>
                  <span className="text-sm font-medium text-zinc-900">
                    {row.latest_action ?? row.title}
                  </span>
                </div>
                {row.latest_result && (
                  <div className="mt-1 text-xs text-zinc-500 truncate">{row.latest_result}</div>
                )}
                <div className="mt-1 text-xs text-zinc-400">Age {formatAge(row.age_hours)}</div>
              </div>
              <RetryButton
                label="Dismiss"
                successToast="Finding dismissed"
                variant="secondary"
                action={async () => {
                  "use server"
                  return dismissAuditFinding(row.id)
                }}
                confirm={{
                  title: "Dismiss Audit Finding",
                  description: `Dismiss "${row.latest_action ?? row.title}"?`,
                  severity: "amber",
                  confirmLabel: "Dismiss",
                  preview: {
                    affected: { audit_finding: 1 },
                    items: [
                      {
                        label: row.latest_action ?? row.title,
                        details: [row.priority ?? "normal", `Age ${formatAge(row.age_hours)}`],
                      },
                    ],
                    warnings: [
                      "The finding will be cancelled in dev_tasks. If it recurs, the next audit run will re-raise it.",
                    ],
                  },
                }}
              />
            </div>
          ))
        )}
      </Section>

      {/* ── Failed jobs ── */}
      <Section
        title="Failed Jobs"
        icon={Zap}
        count={snapshot.failedJobs.length}
        tone="red"
      >
        {snapshot.failedJobs.length === 0 ? (
          <EmptyRow message="No failed jobs." />
        ) : (
          snapshot.failedJobs.map(row => (
            <div key={row.id} className="flex items-center justify-between gap-4 px-4 py-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-zinc-900">{row.job_type}</span>
                  <span className="text-xs text-zinc-500">
                    {row.attempts}/{row.max_attempts} attempts
                  </span>
                </div>
                {row.error && (
                  <div className="mt-1 text-xs text-red-600 truncate">{row.error}</div>
                )}
                <div className="mt-1 text-xs text-zinc-400">Age {formatAge(row.age_hours)}</div>
              </div>
              <RetryButton
                label="Retry Job"
                successToast="Job requeued"
                variant="primary"
                action={async () => {
                  "use server"
                  return retryFailedJob(row.id)
                }}
              />
            </div>
          ))
        )}
      </Section>

      {/* ── Failed emails ── */}
      <Section
        title="Failed Emails"
        icon={Mail}
        count={snapshot.failedEmails.length}
        tone="amber"
      >
        {snapshot.failedEmails.length === 0 ? (
          <EmptyRow message="No failed emails." />
        ) : (
          snapshot.failedEmails.map(row => (
            <div key={row.id} className="flex items-center justify-between gap-4 px-4 py-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-medium text-zinc-900 truncate">{row.subject}</span>
                  <span className="text-xs text-zinc-500">→ {row.to_email}</span>
                </div>
                {row.error_message && (
                  <div className="mt-1 text-xs text-red-600 truncate">{row.error_message}</div>
                )}
                <div className="mt-1 text-xs text-zinc-400">
                  {row.retry_count} retries · Age {formatAge(row.age_hours)}
                </div>
              </div>
              <RetryButton
                label="Requeue"
                successToast="Email requeued"
                variant="primary"
                action={async () => {
                  "use server"
                  return retryFailedEmail(row.id)
                }}
              />
            </div>
          ))
        )}
      </Section>

      {/* ── Webhook reviews ── */}
      <Section
        title="Webhook Events Awaiting Review"
        icon={Webhook}
        count={snapshot.webhookReviews.length}
        tone="zinc"
      >
        {snapshot.webhookReviews.length === 0 ? (
          <EmptyRow message="No webhook events waiting." />
        ) : (
          snapshot.webhookReviews.map(row => (
            <div key={row.id} className="flex items-center justify-between gap-4 px-4 py-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-medium text-zinc-900">{row.source}</span>
                  <span className="text-xs text-zinc-500">{row.event_type}</span>
                  <span className="text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded bg-zinc-200 text-zinc-700">
                    {row.review_status}
                  </span>
                </div>
                {row.external_id && (
                  <div className="mt-1 text-xs text-zinc-500">ext: {row.external_id}</div>
                )}
                <div className="mt-1 text-xs text-zinc-400">Age {formatAge(row.age_hours)}</div>
              </div>
              <RetryButton
                label="Mark Reviewed"
                successToast="Marked reviewed"
                variant="secondary"
                action={async () => {
                  "use server"
                  return markWebhookReviewed(row.id)
                }}
              />
            </div>
          ))
        )}
      </Section>
    </div>
  )
}
