'use client'

import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import {
  FileText, Send, Plus, CheckCircle2, Clock, AlertCircle,
  Loader2, ExternalLink, RefreshCw,
} from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'

interface DocStatus {
  id: string
  token: string
  status: string
  access_code?: string
  signed_at?: string | null
  created_at?: string | null
  suite_number?: string
  contract_year?: number
  term_start_date?: string | null
  term_end_date?: string | null
}

interface DocumentStatuses {
  oa: DocStatus | null
  lease: DocStatus | null
  ss4: DocStatus | null
  relay: DocStatus | null
  payset: DocStatus | null
}

interface DocumentsPanelProps {
  accountId: string
  isAdmin: boolean
  onGenerateOA: () => void
  onGenerateLease: () => void
  onGenerateSS4: () => void
  /** Provided only for multi-member accounts with a treasury company member. */
  onGenerateIntercompany?: () => void
  onRegenLease: (leaseId: string, data: { signedAt?: string | null; termStartDate?: string | null; termEndDate?: string | null }) => void
}

const STATUS_CONFIG: Record<string, { icon: typeof CheckCircle2; color: string; label: string }> = {
  signed: { icon: CheckCircle2, color: 'text-emerald-600', label: 'Signed' },
  active: { icon: CheckCircle2, color: 'text-emerald-600', label: 'Active' },
  completed: { icon: CheckCircle2, color: 'text-emerald-600', label: 'Completed' },
  sent: { icon: Clock, color: 'text-amber-600', label: 'Sent (waiting)' },
  viewed: { icon: Clock, color: 'text-amber-600', label: 'Viewed' },
  draft: { icon: FileText, color: 'text-blue-600', label: 'Draft' },
  submitted: { icon: CheckCircle2, color: 'text-emerald-600', label: 'Submitted' },
}

function formatDate(d: string | null | undefined): string {
  if (!d) return ''
  try {
    return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  } catch {
    return d
  }
}

export function DocumentsPanel({ accountId, isAdmin, onGenerateOA, onGenerateLease, onGenerateSS4, onGenerateIntercompany, onRegenLease }: DocumentsPanelProps) {
  const router = useRouter()
  const [statuses, setStatuses] = useState<DocumentStatuses | null>(null)
  const [loading, setLoading] = useState(true)
  const [sendingDoc, setSendingDoc] = useState<string | null>(null)

  const fetchStatuses = useCallback(async () => {
    try {
      const res = await fetch('/api/crm/admin-actions/generate-document', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'fetch_statuses', account_id: accountId }),
      })
      const data = await res.json()
      if (res.ok) setStatuses(data)
    } catch {
      // Silent fail - panel just shows loading
    } finally {
      setLoading(false)
    }
  }, [accountId])

  useEffect(() => {
    fetchStatuses()
  }, [fetchStatuses])

  const handleSendDocument = async (docType: 'oa' | 'lease', token: string) => {
    setSendingDoc(docType)
    try {
      const res = await fetch('/api/crm/admin-actions/generate-document', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: docType === 'oa' ? 'send_oa' : 'send_lease',
          token,
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        toast.error(data.error || 'Failed to send')
        return
      }
      if (data.message) {
        toast.info(data.message)
      } else if (data.emailed === false) {
        // The OA button marks the agreement ready but does NOT email — saying
        // "Sent" here made staff believe a client had been contacted when
        // nothing had gone out.
        toast.warning(data.notice || 'Marked ready — no email was sent.', { duration: 8000 })
      } else {
        toast.success(`Sent to ${data.sent_to ?? data.recipient ?? 'client'}`)
      }
      fetchStatuses()
      router.refresh()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Error sending document')
    } finally {
      setSendingDoc(null)
    }
  }

  if (!isAdmin) return null

  if (loading) {
    return (
      <div className="rounded-lg border bg-white p-4">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading documents...
        </div>
      </div>
    )
  }

  const docs = [
    {
      key: 'oa',
      label: 'Operating Agreement',
      data: statuses?.oa,
      canGenerate: true,
      canSend: true,
      onGenerate: onGenerateOA,
    },
    {
      key: 'lease',
      label: 'Lease Agreement',
      data: statuses?.lease,
      canGenerate: true,
      canSend: true,
      onGenerate: onGenerateLease,
    },
    {
      key: 'ss4',
      label: 'SS-4 (EIN Application)',
      data: statuses?.ss4,
      canGenerate: true,
      canSend: false,
      onGenerate: onGenerateSS4,
    },
    // Intercompany Agreement is generate-on-demand (each run files a new PDF
    // from current CRM data) — only offered for multi-member accounts.
    ...(onGenerateIntercompany ? [{
      key: 'intercompany',
      label: 'Intercompany Agreement',
      data: null,
      canGenerate: true,
      canSend: false,
      onGenerate: onGenerateIntercompany,
    }] : []),
    {
      key: 'relay',
      label: 'Banking (Relay USD)',
      data: statuses?.relay,
      canGenerate: false,
      canSend: false,
    },
    {
      key: 'payset',
      label: 'Banking (Payset EUR)',
      data: statuses?.payset,
      canGenerate: false,
      canSend: false,
    },
  ]

  return (
    <div className="rounded-lg border bg-white">
      <div className="flex items-center justify-between px-4 py-3 border-b">
        <h3 className="text-sm font-semibold flex items-center gap-2">
          <FileText className="h-4 w-4" />
          Documents to Sign
        </h3>
        <button
          onClick={fetchStatuses}
          className="p-1 rounded hover:bg-zinc-100 text-muted-foreground"
          title="Refresh"
        >
          <RefreshCw className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="divide-y">
        {docs.map(doc => {
          const status = doc.data?.status || null
          const config = status ? STATUS_CONFIG[status] || { icon: AlertCircle, color: 'text-zinc-400', label: status } : null
          const StatusIcon = config?.icon || AlertCircle

          return (
            <div key={doc.key} className="flex items-center justify-between px-4 py-2.5 text-sm">
              <div className="flex items-center gap-2 min-w-0">
                {doc.data ? (
                  <StatusIcon className={cn('h-4 w-4 shrink-0', config?.color)} />
                ) : (
                  <div className="h-4 w-4 rounded-full border-2 border-zinc-200 shrink-0" />
                )}
                <span className={cn('truncate', !doc.data && 'text-muted-foreground')}>
                  {doc.label}
                </span>
              </div>

              <div className="flex items-center gap-2 shrink-0 ml-2">
                {doc.data ? (
                  <>
                    <span className={cn('text-xs', config?.color)}>
                      {config?.label}
                      {doc.data.signed_at && ` (${formatDate(doc.data.signed_at)})`}
                    </span>

                    {/* Send button for draft docs */}
                    {doc.canSend && status === 'draft' && (
                      <button
                        onClick={() => handleSendDocument(doc.key as 'oa' | 'lease', doc.data!.token)}
                        disabled={sendingDoc === doc.key}
                        className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium rounded bg-blue-50 text-blue-700 hover:bg-blue-100 transition-colors disabled:opacity-50"
                      >
                        {sendingDoc === doc.key ? <Loader2 className="h-3 w-3 animate-spin" /> : <Send className="h-3 w-3" />}
                        Send
                      </button>
                    )}

                    {/* Resend for sent docs */}
                    {doc.canSend && status === 'sent' && (
                      <button
                        onClick={() => handleSendDocument(doc.key as 'oa' | 'lease', doc.data!.token)}
                        disabled={sendingDoc === doc.key}
                        className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium rounded bg-zinc-50 text-zinc-600 hover:bg-zinc-100 transition-colors disabled:opacity-50"
                      >
                        {sendingDoc === doc.key ? <Loader2 className="h-3 w-3 animate-spin" /> : <Send className="h-3 w-3" />}
                        Resend
                      </button>
                    )}

                    {/* Recreate button for OA */}
                    {doc.key === 'oa' && doc.onGenerate && (
                      <button
                        onClick={doc.onGenerate}
                        className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium rounded bg-zinc-50 text-zinc-600 hover:bg-zinc-100 transition-colors"
                        title="Recreate OA"
                      >
                        <RefreshCw className="h-3 w-3" />
                        Recreate
                      </button>
                    )}

                    {/* Regenerate button for UNSIGNED SS-4 — opens the dialog,
                        which offers the in-place refresh (same token/link).
                        Signed/submitted SS-4s get no button: locked. */}
                    {doc.key === 'ss4' && doc.onGenerate && (status === 'draft' || status === 'awaiting_signature') && (
                      <button
                        onClick={doc.onGenerate}
                        className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium rounded bg-zinc-50 text-zinc-600 hover:bg-zinc-100 transition-colors"
                        title="Regenerate the unsigned SS-4 from the account's current data (entity type, members) — the client's link stays the same"
                      >
                        <RefreshCw className="h-3 w-3" />
                        Regenerate
                      </button>
                    )}

                    {/* Regen PDF button for signed lease */}
                    {doc.key === 'lease' && status === 'signed' && doc.data && (
                      <button
                        onClick={() => onRegenLease(doc.data!.id, {
                          signedAt: doc.data!.signed_at,
                          termStartDate: doc.data!.term_start_date,
                          termEndDate: doc.data!.term_end_date,
                        })}
                        className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium rounded bg-zinc-50 text-zinc-600 hover:bg-zinc-100 transition-colors"
                        title="Regenerate PDF with new dates"
                      >
                        <RefreshCw className="h-3 w-3" />
                        Regen PDF
                      </button>
                    )}

                    {/* Preview link */}
                    {doc.data.token && (
                      <a
                        href={
                          // The access code is REQUIRED. The OA page verifies it
                          // server-side now, and ?preview=td no longer skips that
                          // check — the staff session cookie is scoped to the CRM
                          // host and is absent on the client-facing domain, so
                          // preview always falls back to the code. The sibling
                          // ss4 link below already carried it; this one did not.
                          // The access code is REQUIRED: the OA page verifies it
                          // server-side now, and ?preview=td no longer skips that
                          // check (the staff session cookie is scoped to the CRM
                          // host and is absent on the client-facing domain).
                          // Fall back to the codeless URL for any legacy row that
                          // has no code, rather than interpolating "undefined".
                          doc.key === 'oa' ? (doc.data.access_code
                            ? `https://app.tonydurante.us/operating-agreement/${doc.data.token}/${doc.data.access_code}?preview=td`
                            : `https://app.tonydurante.us/operating-agreement/${doc.data.token}?preview=td`) :
                          doc.key === 'lease' ? `https://app.tonydurante.us/lease/${doc.data.token}?preview=td` :
                          doc.key === 'ss4' ? `https://app.tonydurante.us/ss4/${doc.data.token}/${doc.data.access_code}?preview=td` :
                          '#'
                        }
                        target="_blank"
                        rel="noopener noreferrer"
                        className="p-1 rounded hover:bg-zinc-100 text-muted-foreground"
                        title="Preview"
                      >
                        <ExternalLink className="h-3.5 w-3.5" />
                      </a>
                    )}
                  </>
                ) : (
                  <>
                    <span className="text-xs text-muted-foreground">
                      {doc.key === 'intercompany' ? 'Generated from CRM data' : 'Not created'}
                    </span>
                    {doc.canGenerate && doc.onGenerate && (
                      <button
                        onClick={doc.onGenerate}
                        className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium rounded bg-zinc-50 text-zinc-700 hover:bg-zinc-100 transition-colors"
                      >
                        <Plus className="h-3 w-3" />
                        Create
                      </button>
                    )}
                  </>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
