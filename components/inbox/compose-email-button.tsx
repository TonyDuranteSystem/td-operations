'use client'

import { useState } from 'react'
import { Mail } from 'lucide-react'
import { ComposeDialog } from './compose-dialog'

interface ComposeEmailButtonProps {
  to?: string
  accountId?: string
  contactId?: string
  leadId?: string
  linkLabel?: string
  tag?: string
  /**
   * Variant: 'primary' (blue filled), 'outline' (bordered), 'subtle' (text only).
   * Defaults to 'outline' for use in detail-page action rows.
   */
  variant?: 'primary' | 'outline' | 'subtle'
  label?: string
  className?: string
}

export function ComposeEmailButton({
  to,
  accountId,
  contactId,
  leadId,
  linkLabel,
  tag,
  variant = 'outline',
  label = 'Email',
  className = '',
}: ComposeEmailButtonProps) {
  const [open, setOpen] = useState(false)

  const variantClass =
    variant === 'primary'
      ? 'bg-blue-500 text-white hover:bg-blue-600'
      : variant === 'outline'
      ? 'border border-zinc-200 text-zinc-700 hover:bg-zinc-50'
      : 'text-zinc-600 hover:text-zinc-900'

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${variantClass} ${className}`}
      >
        <Mail className="h-3.5 w-3.5" />
        {label}
      </button>
      <ComposeDialog
        open={open}
        onClose={() => setOpen(false)}
        prefillTo={to}
        prefillAccountId={accountId}
        prefillContactId={contactId}
        prefillLeadId={leadId}
        prefillLinkLabel={linkLabel}
        prefillTag={tag}
      />
    </>
  )
}
