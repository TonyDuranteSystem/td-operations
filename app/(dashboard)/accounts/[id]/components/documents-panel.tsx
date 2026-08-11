'use client'

import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import {
  FileText, Send, Plus, CheckCircle2, Clock, AlertCircle,
  Loader2, ExternalLink, RefreshCw, Trash2,
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
  /** Client-facing base URL (app.tonydurante.us in prod, the sandbox URL in
   *  sandbox) — computed on the server and passed down, because this is a client
   *  component and the env override that distinguishes the two is server-only.
   *  Preview links MUST use it so a sandbox View opens the sandbox lease, not the
   *  production one (which carries a different access code → "Invalid access code"). */
  appBaseUrl: string
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

export function DocumentsPanel({ accountId, isAdmin, appBaseUrl, onGenerateOA, onGenerateLease, onGenerateSS4, onGenerateIntercompany, onRegenLease }: DocumentsPanelProps) {
  const router = useRouter()
  const [statuses, setStatuses] = useState<DocumentStatuses | null>(null)
  const [loading, setLoading] = useState(true)
  const [sendingDoc, setSendingDoc] = useState<string | null>(null)
  const [cancellingDoc, setCancellingDoc] = useState<string | null>(null)

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
        // Agreements reach clients through the PORTAL, not by email. Saying
        // "Sent to <client>" made staff believe the client had been contacted.
        toast.info(data.notice || "Ready — it now appears in the client's portal to sign.", { duration: 8000 })
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

  // Which host serves the client-facing lease/OA/ss4 pages for THIS environment.
  // There is no env var that's correct in both: the server app-URL override is
  // empty in sandbox (falls back to production), and the public app-URL points at
  // the internal CRM host in production. But on sandbox / preview / localhost the
  // CRM and the client pages are ONE deployment on ONE domain, so the current
  // address is the right base there; only in production is the client app on a
  // separate domain (app.tonydurante.us), where we use the server-provided value.
  // Staff-only preview, so using the current origin never exposes an internal
  // domain to a client (R005). Falls back to appBaseUrl during SSR.
  const previewBase = (() => {
    if (typeof window === 'undefined') return appBaseUrl
    const host = window.location.hostname
    if (host.includes('sandbox') || host === 'localhost' || host.startsWith('127.')) {
      return window.location.origin
    }
    return appBaseUrl
  })()

  // Open the OA as the client sees it. The client-facing host has no staff
  // session, and the bare ?preview=td flag no longer skips the email gate, so we
  // mint a short-lived staff-preview pass here (on the CRM host, where the staff
  // session exists) and carry it. The pass also suppresses view tracking, so a
  // staff preview never registers as "client viewed". Falls back to the plain
  // coded link if the mint fails — staff can then enter the client email.
  const handleOaPreview = async (token: string, accessCode: string | null | undefined) => {
    const base = accessCode
      ? `${previewBase}/operating-agreement/${token}/${accessCode}?preview=td`
      : `${previewBase}/operating-agreement/${token}?preview=td`
    try {
      const res = await fetch(`/api/crm/oa-preview-pass?token=${encodeURIComponent(token)}`)
      const data = await res.json().catch(() => ({}))
      const url = res.ok && data.pass ? `${base}&pass=${encodeURIComponent(data.pass)}` : base
      window.open(url, '_blank', 'noopener,noreferrer')
    } catch {
      window.open(base, '_blank', 'noopener,noreferrer')
    }
  }

  const handleCancelDraft = async (token: string) => {
    if (!window.confirm('Cancel this draft lease? It will be permanently deleted — this cannot be undone. (Only drafts can be cancelled; a sent or signed lease is never touched.)')) return
    setCancellingDoc('lease')
    try {
      const res = await fetch('/api/crm/admin-actions/generate-document', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'cancel_lease_draft', token }),
      })
      const data = await res.json()
      if (!res.ok) {
        toast.error(data.error || 'Could not cancel the draft')
        return
      }
      toast.success(data.message || 'Draft lease cancelled')
      fetchStatuses()
      router.refresh()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Error cancelling draft')
    } finally {
      setCancellingDoc(null)
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

                    {/* Cancel draft — lease drafts only. A draft was never sent
                        to the client, so deleting it is safe and frees the
                        "one lease per year" block. Never shown once sent/signed. */}
                    {doc.key === 'lease' && status === 'draft' && (
                      <button
                        onClick={() => handleCancelDraft(doc.data!.token)}
                        disabled={cancellingDoc === doc.key}
                        className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium rounded bg-red-50 text-red-700 hover:bg-red-100 transition-colors disabled:opacity-50"
                        title="Permanently delete this draft lease"
                      >
                        {cancellingDoc === doc.key ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
                        Cancel draft
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
                    {doc.data.token && doc.key === 'oa' && (
                      // OA preview goes through a minted staff-preview pass (see
                      // handleOaPreview): the client-facing host has no staff
                      // session and the bare ?preview=td flag no longer skips the
                      // email gate or tracking, so a plain link would ask staff
                      // for the client's email and register a false "client viewed".
                      <button
                        type="button"
                        onClick={() => handleOaPreview(doc.data.token as string, doc.data.access_code)}
                        className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium rounded text-muted-foreground hover:bg-zinc-100 transition-colors"
                        title="Open the document as the client sees it (no email is sent, nothing is marked as opened)"
                      >
                        <ExternalLink className="h-3.5 w-3.5" />
                        View
                      </button>
                    )}
                    {doc.data.token && doc.key !== 'oa' && (
                      <a
                        href={
                          // Lease preview MUST carry the access code. On the client-facing
                          // domain the staff session cookie is absent, so ?preview=td alone
                          // does not authenticate — the page falls back to requiring the code
                          // and, without it, errors with "Invalid access code". The coded URL
                          // satisfies that check. Fall back to codeless only for a legacy row
                          // that has no code, rather than interpolating "undefined".
                          doc.key === 'lease' ? (doc.data.access_code
                            ? `${previewBase}/lease/${doc.data.token}/${doc.data.access_code}?preview=td`
                            : `${previewBase}/lease/${doc.data.token}?preview=td`) :
                          doc.key === 'ss4' ? `${previewBase}/ss4/${doc.data.token}/${doc.data.access_code}?preview=td` :
                          '#'
                        }
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium rounded text-muted-foreground hover:bg-zinc-100 transition-colors"
                        title="Open the document as the client sees it (no email is sent, nothing is marked as opened)"
                      >
                        <ExternalLink className="h-3.5 w-3.5" />
                        View
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
