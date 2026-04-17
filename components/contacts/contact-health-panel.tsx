'use client'

/**
 * P3.4 #3 — Client health diagnostic panel (contact-side).
 *
 * Single read-only surface that runs both per-contact audits
 * (diagnose-contact + audit-chain) in parallel and renders their checks
 * grouped and color-coded in one place. Fix actions remain in the
 * existing dialogs (ContactDiagnosticDialog + ChainAuditDialog) — this
 * panel includes launchers for each.
 *
 * Per plan L631 ("Client health diagnostic panel — one screen showing
 * every audit check for a single account/contact").
 */

import { useState, useEffect, useCallback } from 'react'
import {
  Loader2, CheckCircle2, AlertCircle, XCircle, Info,
  RefreshCw, Stethoscope, Link2,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { ContactDiagnosticDialog } from './contact-diagnostic-dialog'
import { ChainAuditDialog } from './chain-audit-dialog'
import { combineSummaries, rollupStatus, type HealthCheck as Check, type HealthSummary } from '@/lib/contact-health-helpers'

interface DiagnoseResult {
  checks: Check[]
  summary: HealthSummary
}

interface AccountAudit {
  account_id: string
  company_name: string
  checks: Check[]
}

interface ChainResult {
  global_checks: Check[]
  account_audits: AccountAudit[]
  summary: HealthSummary
}

interface Props {
  contactId: string
  contactName: string
}

const STATUS_ICON = { ok: CheckCircle2, warning: AlertCircle, error: XCircle, info: Info }
const STATUS_COLOR = {
  ok: 'text-green-600',
  warning: 'text-amber-500',
  error: 'text-red-600',
  info: 'text-blue-500',
}
const STATUS_BG = {
  ok: 'bg-green-50',
  warning: 'bg-amber-50',
  error: 'bg-red-50',
  info: 'bg-blue-50',
}

export function ContactHealthPanel({ contactId, contactName }: Props) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [diagnose, setDiagnose] = useState<DiagnoseResult | null>(null)
  const [chain, setChain] = useState<ChainResult | null>(null)
  const [showDiagnose, setShowDiagnose] = useState(false)
  const [showChain, setShowChain] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [dRes, cRes] = await Promise.all([
        fetch(`/api/crm/admin-actions/diagnose-contact?contact_id=${contactId}`),
        fetch(`/api/crm/admin-actions/audit-chain?contact_id=${contactId}`),
      ])
      if (!dRes.ok) throw new Error(`Diagnose contact: HTTP ${dRes.status}`)
      if (!cRes.ok) throw new Error(`Chain audit: HTTP ${cRes.status}`)
      const [dJson, cJson] = await Promise.all([dRes.json(), cRes.json()])
      setDiagnose(dJson)
      setChain(cJson)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [contactId])

  useEffect(() => { load() }, [load])

  const combined = combineSummaries(diagnose?.summary, chain?.summary)

  if (loading && !diagnose && !chain) {
    return (
      <div className="flex items-center justify-center py-16 text-zinc-500">
        <Loader2 className="h-5 w-5 animate-spin mr-2" />
        Running health checks…
      </div>
    )
  }

  if (error) {
    return (
      <div className="max-w-2xl space-y-4">
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          Failed to load health checks: {error}
        </div>
        <button
          onClick={load}
          className="px-4 py-2 rounded-lg border text-sm font-medium hover:bg-zinc-50"
        >
          Retry
        </button>
      </div>
    )
  }

  return (
    <div className="max-w-3xl space-y-5">
      {/* Summary bar + actions */}
      <div className="rounded-lg border p-4 bg-white space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="font-semibold text-sm text-muted-foreground uppercase tracking-wider">
            Health Summary
          </h3>
          <button
            onClick={load}
            disabled={loading}
            className="text-xs text-zinc-500 hover:text-zinc-800 flex items-center gap-1 disabled:opacity-50"
          >
            {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
            Refresh
          </button>
        </div>

        <div className="grid grid-cols-4 gap-3">
          <SummaryPill label="Pass" count={combined.ok} color="ok" />
          <SummaryPill label="Warn" count={combined.warning} color="warning" />
          <SummaryPill label="Fail" count={combined.error} color="error" />
          <SummaryPill label="Info" count={combined.info} color="info" />
        </div>

        <div className="flex flex-wrap gap-2 pt-2 border-t">
          <button
            onClick={() => setShowDiagnose(true)}
            className="flex items-center gap-2 px-3 py-1.5 rounded-lg border text-xs font-medium hover:bg-zinc-50"
            title="Open the full diagnostic dialog with fix actions"
          >
            <Stethoscope className="h-3.5 w-3.5" />
            Run Fix Actions — Diagnostic
          </button>
          <button
            onClick={() => setShowChain(true)}
            className="flex items-center gap-2 px-3 py-1.5 rounded-lg border text-xs font-medium hover:bg-zinc-50"
            title="Open the full chain audit dialog with fix actions"
          >
            <Link2 className="h-3.5 w-3.5" />
            Run Fix Actions — Chain Audit
          </button>
        </div>
      </div>

      {/* Contact diagnostic checks */}
      <CheckSection
        title="Contact Diagnostic"
        subtitle="Lead → contact → offer → payment → wizard → portal integrity"
        checks={diagnose?.checks ?? []}
      />

      {/* Chain audit — global checks */}
      <CheckSection
        title="Chain Audit — Contact-wide"
        subtitle="Data flow and linkage consistency"
        checks={chain?.global_checks ?? []}
      />

      {/* Chain audit — per-account */}
      {(chain?.account_audits ?? []).map(acct => (
        <CheckSection
          key={acct.account_id}
          title={`Account: ${acct.company_name}`}
          subtitle="Formation pipeline, services, portal, agreements"
          checks={acct.checks}
        />
      ))}

      {/* Mount dialogs for fix actions */}
      <ContactDiagnosticDialog
        open={showDiagnose}
        onClose={() => { setShowDiagnose(false); load() }}
        contactId={contactId}
        contactName={contactName}
      />
      <ChainAuditDialog
        open={showChain}
        onClose={() => { setShowChain(false); load() }}
        contactId={contactId}
        contactName={contactName}
      />
    </div>
  )
}

// ─── Subcomponents ────────────────────────────────────

function SummaryPill({
  label,
  count,
  color,
}: {
  label: string
  count: number
  color: 'ok' | 'warning' | 'error' | 'info'
}) {
  return (
    <div className={cn('rounded-lg p-3 text-center', STATUS_BG[color])}>
      <div className={cn('text-2xl font-semibold', STATUS_COLOR[color])}>{count}</div>
      <div className="text-xs text-muted-foreground mt-0.5">{label}</div>
    </div>
  )
}

function CheckSection({
  title,
  subtitle,
  checks,
}: {
  title: string
  subtitle: string
  checks: Check[]
}) {
  if (checks.length === 0) return null

  // Group by category preserving first-seen order
  const categories: string[] = []
  const byCategory = new Map<string, Check[]>()
  for (const c of checks) {
    if (!byCategory.has(c.category)) {
      categories.push(c.category)
      byCategory.set(c.category, [])
    }
    byCategory.get(c.category)!.push(c)
  }

  const rollup = rollupStatus(checks)

  return (
    <div className="rounded-lg border bg-white">
      <div className="p-4 border-b flex items-start justify-between gap-4">
        <div>
          <h3 className="font-semibold text-sm">{title}</h3>
          <p className="text-xs text-muted-foreground mt-0.5">{subtitle}</p>
        </div>
        {rollup !== 'empty' && (
          <div
            className={cn(
              'text-[11px] font-medium px-2 py-0.5 rounded self-center uppercase tracking-wider',
              STATUS_BG[rollup],
              STATUS_COLOR[rollup],
            )}
          >
            {rollup}
          </div>
        )}
      </div>
      <div className="divide-y">
        {categories.map(cat => (
          <div key={cat} className="p-3 space-y-1">
            <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider px-1 pb-1">
              {cat}
            </div>
            {byCategory.get(cat)!.map(check => {
              const Icon = STATUS_ICON[check.status]
              return (
                <div
                  key={check.id}
                  className={cn('flex items-start gap-3 px-2 py-2 rounded', STATUS_BG[check.status])}
                >
                  <Icon className={cn('h-4 w-4 mt-0.5 flex-shrink-0', STATUS_COLOR[check.status])} />
                  <div className="flex-1 min-w-0 text-sm">
                    <div className="font-medium">{check.label}</div>
                    <div className="text-xs text-muted-foreground mt-0.5 whitespace-pre-wrap">
                      {check.detail}
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        ))}
      </div>
    </div>
  )
}
