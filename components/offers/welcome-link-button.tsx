'use client'

import { forwardRef, useEffect, useImperativeHandle, useState } from 'react'
import { Check, Copy, Link as LinkIcon } from 'lucide-react'
import { toast } from 'sonner'

export interface WelcomeLinkButtonHandle {
  setWelcomeUrl: (url: string | null) => void
}

interface WelcomeLinkButtonProps {
  offerToken: string
  offerStatus: string
  size?: 'sm' | 'md'
}

export const WelcomeLinkButton = forwardRef<WelcomeLinkButtonHandle, WelcomeLinkButtonProps>(
  function WelcomeLinkButton({ offerToken, offerStatus, size = 'md' }, ref) {
    const [welcomeUrl, setWelcomeUrlState] = useState<string | null>(null)
    const [welcomeCopied, setWelcomeCopied] = useState(false)

    useImperativeHandle(ref, () => ({
      setWelcomeUrl: (url) => setWelcomeUrlState(url),
    }), [])

    useEffect(() => {
      if (!offerToken || offerStatus === 'draft') {
        setWelcomeUrlState(null)
        return
      }
      let cancelled = false
      fetch(`/api/crm/admin-actions/offer-welcome-link?token=${encodeURIComponent(offerToken)}`)
        .then(r => r.json())
        .then(data => {
          if (cancelled) return
          if (data?.welcome_url) setWelcomeUrlState(data.welcome_url)
        })
        .catch(() => {})
      return () => { cancelled = true }
    }, [offerToken, offerStatus])

    if (!welcomeUrl) return null

    const onClick = async () => {
      try {
        await navigator.clipboard.writeText(welcomeUrl)
        setWelcomeCopied(true)
        toast.success('Welcome link copied — paste into WhatsApp/Telegram')
        setTimeout(() => setWelcomeCopied(false), 2000)
      } catch {
        toast.error('Could not copy to clipboard')
      }
    }

    const sizeClass = size === 'sm' ? 'px-3 py-1.5 text-xs' : 'px-3 py-2 text-sm'
    const iconClass = size === 'sm' ? 'h-3.5 w-3.5' : 'h-4 w-4'
    const linkIconClass = size === 'sm' ? 'h-3 w-3' : 'h-3.5 w-3.5'

    return (
      <button
        onClick={onClick}
        className={`inline-flex items-center gap-1.5 ${sizeClass} font-medium rounded-md border border-emerald-300 text-emerald-700 hover:bg-emerald-50 transition-colors`}
        title="Share with the client via WhatsApp/Telegram. Link decrypts the temp password and expires in 7 days."
      >
        {welcomeCopied ? <Check className={iconClass} /> : <Copy className={iconClass} />}
        {welcomeCopied ? 'Copied' : 'Copy Welcome Link'}
        <LinkIcon className={`${linkIconClass} opacity-60`} />
      </button>
    )
  }
)
