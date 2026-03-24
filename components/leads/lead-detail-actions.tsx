'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { CreditCard, Loader2, CheckCircle2, AlertCircle, X, Copy, Check } from 'lucide-react'
import { cn } from '@/lib/utils'
import { toast } from 'sonner'
import { registerPayment } from '@/app/(dashboard)/leads/[id]/actions'

interface LeadDetailActionsProps {
  leadId: string
  leadName: string
  hasActivation: boolean
  activationStatus: string | null
}

export function LeadDetailActions({ leadId, leadName, hasActivation, activationStatus }: LeadDetailActionsProps) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [showConfirm, setShowConfirm] = useState(false)
  const [credentials, setCredentials] = useState<{ email: string; tempPassword: string; loginUrl: string } | null>(null)
  const [copied, setCopied] = useState<string | null>(null)

  const alreadyActivated = activationStatus === 'activated'
  const disabled = !hasActivation || alreadyActivated || isPending

  function handleRegisterPayment() {
    setShowConfirm(false)
    startTransition(async () => {
      const result = await registerPayment(leadId)
      if (result.success) {
        toast.success(result.message)
        if (result.credentials) {
          setCredentials(result.credentials)
        }
        router.refresh()
      } else {
        toast.error(result.message)
      }
    })
  }

  async function copyToClipboard(text: string, field: string) {
    await navigator.clipboard.writeText(text)
    setCopied(field)
    setTimeout(() => setCopied(null), 2000)
  }

  return (
    <div className="relative">
      <button
        onClick={() => setShowConfirm(true)}
        disabled={disabled}
        className={cn(
          'inline-flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium transition-colors',
          disabled
            ? 'bg-zinc-100 text-zinc-400 cursor-not-allowed'
            : 'bg-emerald-600 text-white hover:bg-emerald-700 shadow-sm',
        )}
      >
        {isPending ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : alreadyActivated ? (
          <CheckCircle2 className="h-4 w-4" />
        ) : (
          <CreditCard className="h-4 w-4" />
        )}
        {isPending ? 'Activating...' : alreadyActivated ? 'Already Activated' : 'Register Payment'}
      </button>

      {!hasActivation && !alreadyActivated && (
        <p className="text-xs text-muted-foreground mt-1">
          No pending activation found. The offer must be signed first.
        </p>
      )}

      {/* Confirmation dialog */}
      {showConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-xl shadow-xl p-6 max-w-md w-full mx-4">
            <div className="flex items-start justify-between mb-4">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-full bg-emerald-100">
                  <CreditCard className="h-5 w-5 text-emerald-600" />
                </div>
                <h3 className="text-lg font-semibold">Register Payment</h3>
              </div>
              <button onClick={() => setShowConfirm(false)} className="p-1 hover:bg-zinc-100 rounded">
                <X className="h-4 w-4" />
              </button>
            </div>

            <p className="text-sm text-muted-foreground mb-1">
              This will activate services for:
            </p>
            <p className="text-sm font-medium mb-4">{leadName}</p>

            <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 mb-4">
              <div className="flex gap-2">
                <AlertCircle className="h-4 w-4 text-amber-600 mt-0.5 shrink-0" />
                <div className="text-xs text-amber-800">
                  <p className="font-medium">This action will:</p>
                  <ul className="mt-1 space-y-0.5 list-disc list-inside">
                    <li>Create a Contact from this Lead</li>
                    <li>Create Service Deliveries (pipelines)</li>
                    <li>Create a Portal login for the client</li>
                    <li>Prepare QB invoice & data collection form</li>
                    <li>Notify the team via email</li>
                  </ul>
                </div>
              </div>
            </div>

            <div className="flex gap-3 justify-end">
              <button
                onClick={() => setShowConfirm(false)}
                className="px-4 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-100 rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleRegisterPayment}
                disabled={isPending}
                className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-emerald-600 hover:bg-emerald-700 rounded-lg transition-colors disabled:opacity-50"
              >
                {isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                Confirm Activation
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Credentials dialog */}
      {credentials && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-xl shadow-xl p-6 max-w-md w-full mx-4">
            <div className="flex items-start justify-between mb-4">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-full bg-emerald-100">
                  <CheckCircle2 className="h-5 w-5 text-emerald-600" />
                </div>
                <h3 className="text-lg font-semibold">Portal Credentials</h3>
              </div>
              <button onClick={() => setCredentials(null)} className="p-1 hover:bg-zinc-100 rounded">
                <X className="h-4 w-4" />
              </button>
            </div>

            <p className="text-sm text-muted-foreground mb-4">
              Send these credentials to the client. They will be asked to change their password on first login.
            </p>

            <div className="space-y-3">
              <div className="bg-zinc-50 rounded-lg p-3">
                <p className="text-xs text-muted-foreground mb-1">Login URL</p>
                <div className="flex items-center gap-2">
                  <code className="text-sm font-mono flex-1 truncate">{credentials.loginUrl}</code>
                  <button
                    onClick={() => copyToClipboard(credentials.loginUrl, 'url')}
                    className="p-1.5 hover:bg-zinc-200 rounded transition-colors shrink-0"
                  >
                    {copied === 'url' ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <Copy className="h-3.5 w-3.5" />}
                  </button>
                </div>
              </div>

              <div className="bg-zinc-50 rounded-lg p-3">
                <p className="text-xs text-muted-foreground mb-1">Email</p>
                <div className="flex items-center gap-2">
                  <code className="text-sm font-mono flex-1">{credentials.email}</code>
                  <button
                    onClick={() => copyToClipboard(credentials.email, 'email')}
                    className="p-1.5 hover:bg-zinc-200 rounded transition-colors shrink-0"
                  >
                    {copied === 'email' ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <Copy className="h-3.5 w-3.5" />}
                  </button>
                </div>
              </div>

              <div className="bg-zinc-50 rounded-lg p-3">
                <p className="text-xs text-muted-foreground mb-1">Temporary Password</p>
                <div className="flex items-center gap-2">
                  <code className="text-sm font-mono flex-1">{credentials.tempPassword}</code>
                  <button
                    onClick={() => copyToClipboard(credentials.tempPassword, 'password')}
                    className="p-1.5 hover:bg-zinc-200 rounded transition-colors shrink-0"
                  >
                    {copied === 'password' ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <Copy className="h-3.5 w-3.5" />}
                  </button>
                </div>
              </div>
            </div>

            <button
              onClick={() => {
                const msg = `Login: ${credentials.loginUrl}\nEmail: ${credentials.email}\nPassword: ${credentials.tempPassword}`
                copyToClipboard(msg, 'all')
              }}
              className="mt-4 w-full px-4 py-2 text-sm font-medium text-zinc-700 bg-zinc-100 hover:bg-zinc-200 rounded-lg transition-colors inline-flex items-center justify-center gap-2"
            >
              {copied === 'all' ? <Check className="h-4 w-4 text-emerald-600" /> : <Copy className="h-4 w-4" />}
              {copied === 'all' ? 'Copied!' : 'Copy All'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
