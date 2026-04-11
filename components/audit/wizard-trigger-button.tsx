'use client'

import { useState } from 'react'
import { ClipboardCheck, Loader2, Bell, CheckCircle2 } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'

interface WizardEntry {
  status: string
  current_step: number
  wizard_type: string
  updated_at: string
}

interface WizardTriggerButtonProps {
  contactId: string
  contactName: string
  wizardEntries: WizardEntry[]
  /** Compact mode for inline use in tables */
  compact?: boolean
}

/**
 * State-aware wizard status indicator with action button.
 *
 * States:
 * - No wizard entries → "Not Started" + Send Reminder
 * - In progress       → "Step N of M" + Send Reminder
 * - Submitted         → "Completed" (informational, no action)
 *
 * Multiple wizard entries: uses the most recent one (first in array, sorted desc).
 */
export function WizardTriggerButton({
  contactId,
  contactName,
  wizardEntries,
  compact = false,
}: WizardTriggerButtonProps) {
  const [sending, setSending] = useState(false)

  const primary = wizardEntries[0] ?? null
  const isSubmitted = primary?.status === 'submitted'
  const isInProgress = primary?.status === 'in_progress'

  const STEP_COUNTS: Record<string, number> = {
    formation: 4,
    onboarding: 4,
    tax: 3,
  }
  const totalSteps = primary ? (STEP_COUNTS[primary.wizard_type] ?? 4) : 4

  const handleSendReminder = async () => {
    if (!confirm(`Send wizard reminder email to ${contactName}?`)) return
    setSending(true)
    try {
      const res = await fetch('/api/crm/admin-actions/contact-actions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contact_id: contactId,
          action: 'send_wizard_reminder',
        }),
      })
      const data = await res.json()
      if (data.success) {
        toast.success(data.detail || 'Wizard reminder sent')
      } else {
        toast.error(data.error || 'Failed to send reminder')
      }
    } catch {
      toast.error('Failed to send reminder')
    } finally {
      setSending(false)
    }
  }

  // ─── Submitted: informational badge only ──────────────
  if (isSubmitted) {
    return (
      <span className={cn(
        'inline-flex items-center gap-1 font-medium rounded',
        compact
          ? 'text-[10px] px-1.5 py-0.5 bg-emerald-100 text-emerald-700'
          : 'text-xs px-2 py-1 bg-emerald-50 text-emerald-700 border border-emerald-200'
      )}>
        <CheckCircle2 className={compact ? 'h-2.5 w-2.5' : 'h-3 w-3'} />
        Wizard Completed
      </span>
    )
  }

  // ─── In progress: step indicator + reminder ───────────
  if (isInProgress) {
    const label = `Step ${primary.current_step} of ${totalSteps}`
    return (
      <div className={cn('inline-flex items-center gap-1.5', compact && 'gap-1')}>
        <span className={cn(
          'inline-flex items-center gap-1 font-medium rounded',
          compact
            ? 'text-[10px] px-1.5 py-0.5 bg-blue-100 text-blue-700'
            : 'text-xs px-2 py-1 bg-blue-50 text-blue-700 border border-blue-200'
        )}>
          <ClipboardCheck className={compact ? 'h-2.5 w-2.5' : 'h-3 w-3'} />
          {label}
        </span>
        <button
          onClick={handleSendReminder}
          disabled={sending}
          className={cn(
            'inline-flex items-center gap-1 font-medium rounded transition-colors disabled:opacity-50',
            compact
              ? 'text-[10px] px-1.5 py-0.5 bg-zinc-100 text-zinc-600 hover:bg-zinc-200'
              : 'text-xs px-2 py-1 bg-zinc-100 text-zinc-600 hover:bg-zinc-200'
          )}
          title="Send wizard reminder email"
        >
          {sending ? <Loader2 className="h-2.5 w-2.5 animate-spin" /> : <Bell className="h-2.5 w-2.5" />}
          {!compact && 'Remind'}
        </button>
      </div>
    )
  }

  // ─── Not started: prompt + reminder ───────────────────
  return (
    <div className={cn('inline-flex items-center gap-1.5', compact && 'gap-1')}>
      <span className={cn(
        'inline-flex items-center gap-1 font-medium rounded',
        compact
          ? 'text-[10px] px-1.5 py-0.5 bg-amber-100 text-amber-700'
          : 'text-xs px-2 py-1 bg-amber-50 text-amber-700 border border-amber-200'
      )}>
        <ClipboardCheck className={compact ? 'h-2.5 w-2.5' : 'h-3 w-3'} />
        Not Started
      </span>
      <button
        onClick={handleSendReminder}
        disabled={sending}
        className={cn(
          'inline-flex items-center gap-1 font-medium rounded transition-colors disabled:opacity-50',
          compact
            ? 'text-[10px] px-1.5 py-0.5 bg-purple-100 text-purple-700 hover:bg-purple-200'
            : 'text-xs px-2 py-1 bg-purple-50 text-purple-700 border border-purple-200 hover:bg-purple-100'
        )}
        title="Send wizard reminder email"
      >
        {sending ? <Loader2 className="h-2.5 w-2.5 animate-spin" /> : <Bell className="h-2.5 w-2.5" />}
        {!compact && 'Send Reminder'}
      </button>
    </div>
  )
}
