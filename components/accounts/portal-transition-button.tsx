'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Rocket, Loader2, CheckCircle2, AlertTriangle, X } from 'lucide-react'
import { toast } from 'sonner'

interface PortalTransitionButtonProps {
  accountId: string
  portalAccount: boolean
}

export function PortalTransitionButton({ accountId, portalAccount }: PortalTransitionButtonProps) {
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<{
    success: boolean
    report: string
    warnings: string[]
    accountsProcessed: number
    contactEmail: string
    emailSent?: boolean
    error?: string
  } | null>(null)
  const router = useRouter()

  if (portalAccount) return null // Already transitioned

  const handleRun = async () => {
    if (!confirm('Run portal transition for this client?\n\nThis will:\n- Scan & process Drive documents\n- Create OA, Lease, Renewal MSA if missing\n- Create service deliveries & deadlines\n- Create portal auth user\n- Set portal_account=true\n- Send welcome email with login credentials')) return

    setLoading(true)
    try {
      const res = await fetch('/api/portal/admin/transition', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account_id: accountId }),
      })
      const data = await res.json()

      if (!res.ok) {
        setResult({
          success: false,
          report: '',
          warnings: [],
          accountsProcessed: 0,
          contactEmail: '',
          error: data.error || 'Transition failed',
        })
        toast.error(data.error || 'Transition failed')
      } else {
        setResult({
          success: true,
          report: data.report,
          warnings: data.warnings || [],
          accountsProcessed: data.accounts_processed,
          contactEmail: data.contact_email,
          emailSent: data.email_sent,
        })
        toast.success(`Portal transition complete — ${data.accounts_processed} account(s) processed${data.email_sent ? ', welcome email sent' : ''}`)
        router.refresh()
      }
    } catch {
      toast.error('Request failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <>
      <button
        onClick={handleRun}
        disabled={loading}
        className="inline-flex items-center gap-1.5 px-3 py-1 text-xs font-medium rounded-lg bg-violet-100 text-violet-700 hover:bg-violet-200 disabled:opacity-50 transition-colors"
      >
        {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Rocket className="h-3.5 w-3.5" />}
        Portal Transition
      </button>

      {/* Result Dialog */}
      {result && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setResult(null)}>
          <div className="bg-white rounded-xl shadow-xl w-full max-w-xl mx-4 max-h-[80vh] flex flex-col" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-6 py-4 border-b">
              <div className="flex items-center gap-2">
                {result.success ? (
                  <CheckCircle2 className="h-5 w-5 text-emerald-600" />
                ) : (
                  <AlertTriangle className="h-5 w-5 text-red-600" />
                )}
                <h2 className="text-lg font-semibold">
                  {result.success ? 'Portal Transition Complete' : 'Transition Failed'}
                </h2>
              </div>
              <button onClick={() => setResult(null)} className="p-1 rounded hover:bg-zinc-100">
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="px-6 py-4 overflow-y-auto flex-1 space-y-4">
              {result.error && (
                <div className="rounded-lg bg-red-50 p-4 text-sm text-red-700">
                  {result.error}
                </div>
              )}

              {result.warnings.length > 0 && (
                <div className="rounded-lg bg-amber-50 p-4 space-y-1">
                  <p className="text-sm font-medium text-amber-800">Warnings</p>
                  {result.warnings.map((w, i) => (
                    <p key={i} className="text-xs text-amber-700">{w}</p>
                  ))}
                </div>
              )}

              {result.success && (
                <>
                  <div className="text-sm space-y-1">
                    <p><span className="font-medium">Accounts processed:</span> {result.accountsProcessed}</p>
                    <p><span className="font-medium">Contact:</span> {result.contactEmail}</p>
                  </div>
                  <div className="rounded-lg bg-zinc-50 p-4">
                    <pre className="text-xs text-zinc-700 whitespace-pre-wrap font-mono">{result.report}</pre>
                  </div>
                  <div className={`rounded-lg p-3 text-xs ${result.emailSent ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'}`}>
                    {result.emailSent
                      ? 'Welcome email with login credentials has been sent to the client.'
                      : 'Welcome email was NOT sent. Use the contact page "Resend Welcome" button or MCP gmail_send tool.'}
                  </div>
                </>
              )}
            </div>

            <div className="flex items-center justify-end px-6 py-4 border-t bg-zinc-50/50 rounded-b-xl">
              <button
                onClick={() => setResult(null)}
                className="px-4 py-2 text-sm font-medium rounded-lg bg-zinc-100 text-zinc-700 hover:bg-zinc-200"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
