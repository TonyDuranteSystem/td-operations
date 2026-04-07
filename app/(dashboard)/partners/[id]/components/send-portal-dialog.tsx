'use client'

import { useState } from 'react'
import { X, Loader2, Send, CheckCircle, Copy } from 'lucide-react'
import { toast } from 'sonner'
import { useRouter } from 'next/navigation'
import { callPartnerAction, type PartnerData } from './partner-actions'

interface Props {
  open: boolean
  onClose: () => void
  partner: PartnerData
}

export function SendPortalDialog({ open, onClose, partner }: Props) {
  const router = useRouter()
  const [sending, setSending] = useState(false)
  const [result, setResult] = useState<{ password?: string } | null>(null)

  if (!open) return null

  const email = partner.partner_email ?? partner.contact?.email
  if (!email) {
    return (
      <>
        <div className="fixed inset-0 z-50 bg-black/50" onClick={onClose} />
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-sm p-6" onClick={e => e.stopPropagation()}>
            <p className="text-sm text-red-600">No email address found for this partner. Add an email first.</p>
            <button onClick={onClose} className="mt-4 px-4 py-2 text-sm border rounded-md hover:bg-zinc-50">Close</button>
          </div>
        </div>
      </>
    )
  }

  const handleSend = async () => {
    setSending(true)
    const data = await callPartnerAction({ action: 'send_portal', partner_id: partner.id })
    setSending(false)
    if (data.success) {
      setResult({ password: data.password })
      toast.success('Portal access sent')
      router.refresh()
    } else {
      toast.error(data.detail ?? 'Failed to send portal access')
    }
  }

  const handleClose = () => { setResult(null); onClose() }

  const copyPassword = () => {
    if (result?.password) {
      navigator.clipboard.writeText(result.password)
      toast.success('Password copied')
    }
  }

  return (
    <>
      <div className="fixed inset-0 z-50 bg-black/50" onClick={handleClose} />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div className="bg-white rounded-lg shadow-xl w-full max-w-sm" onClick={e => e.stopPropagation()}>
          <div className="flex items-center justify-between px-6 py-4 border-b">
            <h2 className="text-lg font-semibold">Send Portal Access</h2>
            <button onClick={handleClose} className="p-1 rounded hover:bg-zinc-100"><X className="h-5 w-5" /></button>
          </div>

          <div className="px-6 py-4 space-y-4">
            {result ? (
              <div className="space-y-3">
                <div className="flex items-center gap-2 text-emerald-600">
                  <CheckCircle className="h-5 w-5" />
                  <span className="text-sm font-medium">Portal access sent!</span>
                </div>
                <div className="text-sm">
                  <span className="text-muted-foreground">Email:</span> {email}
                </div>
                {result.password && (
                  <div className="flex items-center gap-2">
                    <div className="text-sm">
                      <span className="text-muted-foreground">Temp password:</span>{' '}
                      <code className="bg-zinc-100 px-1.5 py-0.5 rounded text-xs">{result.password}</code>
                    </div>
                    <button onClick={copyPassword} className="text-zinc-400 hover:text-zinc-600">
                      <Copy className="h-3.5 w-3.5" />
                    </button>
                  </div>
                )}
                <button onClick={handleClose} className="w-full mt-2 px-4 py-2 text-sm border rounded-md hover:bg-zinc-50">Done</button>
              </div>
            ) : (
              <>
                <p className="text-sm">Send partner portal login credentials to:</p>
                <div className="bg-zinc-50 rounded-md p-3">
                  <div className="text-sm font-medium">{partner.partner_name}</div>
                  <div className="text-xs text-muted-foreground">{email}</div>
                </div>
                <p className="text-xs text-muted-foreground">
                  This will create a portal account (if needed) and send login credentials via email.
                </p>
                <div className="flex justify-end gap-2 pt-2">
                  <button onClick={handleClose} className="px-4 py-2 text-sm border rounded-md hover:bg-zinc-50">Cancel</button>
                  <button onClick={handleSend} disabled={sending}
                    className="px-4 py-2 text-sm bg-zinc-900 text-white rounded-md hover:bg-zinc-800 disabled:opacity-50 flex items-center gap-2">
                    {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                    Send
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </>
  )
}
