'use client'

/**
 * Issues tab in Portal Chats — shows THIS client's open problems in plain
 * English with the existing one-click fixes. Reuses the client-diagnostic API
 * (/api/crm/admin-actions/diagnose-account) — same engine as the account-page
 * diagnostic. After a fix (or on open) it refreshes the cached issue count so
 * the list ⚠️ stays in sync.
 */
import { useCallback, useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Loader2, AlertTriangle, AlertCircle, Wrench, CheckCircle2, RefreshCw } from 'lucide-react'
import { FastTooltip } from '@/components/ui/fast-tooltip'

interface DiagnosticFix {
  action: string
  label: string
  params: Record<string, unknown>
  description: string
  impact?: string[]
  risk?: 'safe' | 'moderate' | 'high'
}
interface DiagnosticCheck {
  id: string
  category: string
  label: string
  status: 'ok' | 'warning' | 'error' | 'info'
  detail: string
  fix?: DiagnosticFix
}

const RISK_LABEL: Record<string, string> = { safe: 'Safe', moderate: 'Changes data', high: 'Affects client' }

export function ThreadIssuesPanel({ accountId }: { accountId: string | null }) {
  const queryClient = useQueryClient()
  const [checks, setChecks] = useState<DiagnosticCheck[]>([])
  const [loading, setLoading] = useState(false)
  const [fixing, setFixing] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const syncCachedCount = useCallback(async () => {
    if (!accountId) return
    // Refresh the cached count for this client, then let the list re-read it.
    await fetch('/api/portal-chats/issue-counts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ account_id: accountId }),
    }).catch(() => {})
    queryClient.invalidateQueries({ queryKey: ['portal-chat-issue-counts'] })
  }, [accountId, queryClient])

  const load = useCallback(async () => {
    if (!accountId) return
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/crm/admin-actions/diagnose-account?account_id=${accountId}`)
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || 'Could not load issues — please try again.')
      }
      const data = await res.json()
      setChecks(Array.isArray(data.checks) ? data.checks : [])
      syncCachedCount()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load issues.')
    } finally {
      setLoading(false)
    }
  }, [accountId, syncCachedCount])

  useEffect(() => {
    load()
  }, [load])

  async function runFix(check: DiagnosticCheck) {
    if (!accountId || !check.fix) return
    const risk = check.fix.risk ? ` [${RISK_LABEL[check.fix.risk] || check.fix.risk}]` : ''
    if (!window.confirm(`${check.fix.description}${risk}\n\nApply this fix?`)) return
    setFixing(check.id)
    try {
      const res = await fetch('/api/crm/admin-actions/diagnose-account', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account_id: accountId, action: check.fix.action, params: check.fix.params }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || 'Fix failed — please try again.')
      }
      await load() // re-check; also re-syncs the cached count
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Fix failed.')
    } finally {
      setFixing(null)
    }
  }

  if (!accountId) {
    return <div className="p-4 text-sm text-zinc-400">Open a client to see its issues.</div>
  }

  const problems = checks.filter(c => c.status === 'error' || c.status === 'warning')

  return (
    <div className="p-3">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-zinc-800 flex items-center gap-1.5">
          <AlertTriangle className="h-4 w-4 text-amber-500" /> Issues
        </h3>
        <button onClick={load} disabled={loading} className="text-[11px] text-zinc-500 hover:text-zinc-800 flex items-center gap-1 disabled:opacity-50">
          <RefreshCw className={`h-3 w-3 ${loading ? 'animate-spin' : ''}`} /> Re-check
        </button>
      </div>

      {loading && checks.length === 0 ? (
        <div className="flex items-center justify-center py-10"><Loader2 className="h-5 w-5 animate-spin text-zinc-400" /></div>
      ) : error ? (
        <p className="text-sm text-red-600">{error}</p>
      ) : problems.length === 0 ? (
        <div className="text-center py-10">
          <CheckCircle2 className="h-8 w-8 text-emerald-500 mx-auto mb-2" />
          <p className="text-sm text-zinc-500">No issues for this client.</p>
        </div>
      ) : (
        <ul className="space-y-2">
          {problems.map(check => {
            const isError = check.status === 'error'
            return (
              <li key={check.id} className={`rounded-lg border p-3 ${isError ? 'border-red-200 bg-red-50/40' : 'border-amber-200 bg-amber-50/40'}`}>
                <div className="flex items-start gap-2">
                  {isError ? <AlertCircle className="h-4 w-4 text-red-500 mt-0.5 shrink-0" /> : <AlertTriangle className="h-4 w-4 text-amber-500 mt-0.5 shrink-0" />}
                  <div className="min-w-0 flex-1">
                    <div className="text-xs font-semibold text-zinc-800">{check.label}</div>
                    <div className="text-xs text-zinc-600 mt-0.5 whitespace-pre-wrap">{check.detail}</div>
                    {check.fix && (
                      <FastTooltip label={check.fix.description}>
                        <button
                          onClick={() => runFix(check)}
                          disabled={fixing === check.id}
                          className="mt-2 inline-flex items-center gap-1 text-[11px] font-medium px-2 py-1 rounded-md bg-zinc-900 text-white hover:bg-zinc-700 disabled:opacity-50"
                          aria-label={check.fix.description}
                        >
                          {fixing === check.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Wrench className="h-3 w-3" />}
                          {check.fix.label}
                        </button>
                      </FastTooltip>
                    )}
                  </div>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
