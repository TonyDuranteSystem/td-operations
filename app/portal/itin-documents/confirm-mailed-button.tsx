'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Check, Loader2 } from 'lucide-react'
import { confirmItinMailed } from './actions'

interface ConfirmMailedButtonProps {
  language: 'en' | 'it'
}

export function ConfirmMailedButton({ language }: ConfirmMailedButtonProps) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [confirmed, setConfirmed] = useState(false)

  const labels = language === 'it'
    ? {
        idle: 'Ho spedito i documenti',
        pending: 'Conferma in corso…',
        success: 'Grazie! Aggiornamento in corso.',
        confirm: 'Confermi di aver firmato e spedito i moduli W-7 e 1040-NR (doppia copia) insieme alle copie del passaporto?',
        errorFallback: 'Errore. Riprova o contatta lo staff.',
      }
    : {
        idle: 'I have mailed the documents',
        pending: 'Confirming…',
        success: 'Thank you! Updating…',
        confirm: 'Confirm you have signed and mailed the W-7 and 1040-NR (double copy) along with copies of your passport pages?',
        errorFallback: 'Something went wrong. Please try again or contact support.',
      }

  const handleClick = () => {
    if (confirmed || isPending) return
    if (!window.confirm(labels.confirm)) return

    startTransition(async () => {
      const result = await confirmItinMailed()
      if (result.success) {
        setConfirmed(true)
        toast.success(labels.success)
        router.refresh()
      } else {
        toast.error(result.error || labels.errorFallback)
      }
    })
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={isPending || confirmed}
      className="inline-flex items-center gap-2 px-5 py-3 rounded-lg bg-blue-600 hover:bg-blue-700 disabled:bg-blue-300 text-white font-medium text-sm transition-colors"
    >
      {isPending ? (
        <>
          <Loader2 className="h-4 w-4 animate-spin" />
          {labels.pending}
        </>
      ) : confirmed ? (
        <>
          <Check className="h-4 w-4" />
          {labels.success}
        </>
      ) : (
        <>
          <Check className="h-4 w-4" />
          {labels.idle}
        </>
      )}
    </button>
  )
}
