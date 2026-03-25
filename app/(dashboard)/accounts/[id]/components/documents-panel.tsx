'use client'

import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import {
  FileText, Send, Plus, CheckCircle2, Clock, AlertCircle,
  Loader2, ExternalLink, Package, RefreshCw,
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

export function DocumentsPanel({ accountId, isAdmin, onGenerateOA, onGenerateLease, onGenerateSS4 }: DocumentsPanelProps) {
  const router = useRouter()
  const [statuses, setStatuses] = useState<DocumentStatuses | null>(null)
  const [loading, setLoading] = useState(true)
  const [sendingDoc, setSendingDoc] = useState<string | null>(null)
  const [generatingWP, setGeneratingWP] = useState(false)
  const [wpSuiteNumber, setWpSuiteNumber] = useState('')
  const [showWpDialog, setShowWpDialog] = useState(false)

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
      } else {
        toast.success(`Sent to ${data.sent_to}`)
      }
      fetchStatuses()
      router.refresh()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Error sending document')
    } finally {
      setSendingDoc(null)
    }
  }

  const handleGenerateWelcomePackage = async () => {
    if (!wpSuiteNumber.trim()) {
      toast.error('Suite number is required for the lease')
      return
    }
    setGeneratingWP(true)
    setShowWpDialog(false)
    try {
      const res = await fetch('/api/crm/admin-actions/generate-document', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'generate_welcome_package',
          account_id: accountId,
          suite_number: wpSuiteNumber.trim(),
        }),
      })
      const data = await res.json()
      if (data.errors?.length) {
        toast.error(`Welcome package: ${data.errors.join(', ')}`)
      } else {
        toast.success('Welcome package generated')
      }
      fetchStatuses()
      router.refresh()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Error generating welcome package')
    } finally {
      setGeneratingWP(false)
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

                    {/* Preview link */}
                    {doc.data.token && (
                      <a
                        href={
                          doc.key === 'oa' ? `https://app.tonydurante.us/operating-agreement/${doc.data.token}?preview=td` :
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
                    <span className="text-xs text-muted-foreground">Not created</span>
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

      {/* Generate Welcome Package */}
      <div className="px-4 py-3 border-t bg-zinc-50/50">
        {showWpDialog ? (
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={wpSuiteNumber}
              onChange={e => setWpSuiteNumber(e.target.value)}
              placeholder="Suite # (e.g., 3D-107)"
              className="flex-1 text-sm px-2.5 py-1.5 rounded border focus:outline-none focus:ring-2 focus:ring-blue-500"
              autoFocus
              onKeyDown={e => e.key === 'Enter' && handleGenerateWelcomePackage()}
            />
            <button
              onClick={handleGenerateWelcomePackage}
              disabled={generatingWP || !wpSuiteNumber.trim()}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded bg-blue-600 text-white hover:bg-blue-700 transition-colors disabled:opacity-50"
            >
              {generatingWP ? <Loader2 className="h-3 w-3 animate-spin" /> : <Package className="h-3 w-3" />}
              Generate
            </button>
            <button
              onClick={() => setShowWpDialog(false)}
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            onClick={() => setShowWpDialog(true)}
            disabled={generatingWP}
            className="inline-flex items-center gap-1.5 text-sm font-medium text-blue-600 hover:text-blue-700"
          >
            {generatingWP ? <Loader2 className="h-4 w-4 animate-spin" /> : <Package className="h-4 w-4" />}
            Generate Welcome Package
            <span className="text-xs text-muted-foreground font-normal">(creates all missing documents)</span>
          </button>
        )}
      </div>
    </div>
  )
}
