'use client'

import type { SignatureVariant, SignatureSender } from '@/lib/email/signature'

interface SignatureControlsProps {
  /** Which mailbox the email will leave from. */
  sender: SignatureSender
  onSenderChange?: (sender: SignatureSender) => void
  variant: SignatureVariant
  onVariantChange: (variant: SignatureVariant) => void
  /**
   * Show the From picker at all. antonio@ is his PERSONAL mailbox and the
   * server gates it regardless (lib/inbox/mailbox-access.ts) — this only
   * decides whether a team user is offered a control that would 403.
   * Omit the handler entirely on surfaces where the mailbox is already
   * fixed by context, e.g. replying inside a thread.
   */
  canUsePersonalMailbox?: boolean
  disabled?: boolean
  className?: string
}

const SELECT_CLASS =
  'rounded-md border border-zinc-200 bg-white px-1.5 py-1 text-xs text-zinc-700 ' +
  'focus:outline-none focus:ring-1 focus:ring-blue-400 disabled:opacity-50'

/**
 * The per-email signature chooser, next to Send.
 *
 * Deliberately NOT a modal on send. A dialog costs a click every time,
 * including the many sends where the default was already right, and on the
 * phone PWA it takes over the whole screen. An always-visible control means
 * the sender can see what is attached without being asked, and only touches
 * it when they want something other than the default.
 *
 * Native <select> on purpose: it opens the OS picker on mobile, which is
 * what Antonio is usually on.
 */
export function SignatureControls({
  sender,
  onSenderChange,
  variant,
  onVariantChange,
  canUsePersonalMailbox = false,
  disabled = false,
  className = '',
}: SignatureControlsProps) {
  // Support never carries a portrait — a face on the shared mailbox would
  // misattribute the mail — so offering "hat vs award" there would be a
  // choice that changes nothing. Only the logo is in play.
  //
  // "Compact" = the identity block with a small TD mark and no banner. The
  // mark is on every signed email by Antonio's decision (2026-08-05); the
  // only way to send without it is "No signature".
  const photoOptions =
    sender === 'antonio'
      ? [
          { value: 'gala', label: 'Award photo' },
          { value: 'hat', label: 'Hat photo' },
          { value: 'text', label: 'Compact' },
          { value: 'none', label: 'No signature' },
        ]
      : [
          { value: 'gala', label: 'Full' },
          { value: 'text', label: 'Compact' },
          { value: 'none', label: 'No signature' },
        ]

  return (
    <div className={`flex items-center gap-2 ${className}`}>
      {canUsePersonalMailbox && onSenderChange && (
        <label className="flex items-center gap-1 text-xs text-zinc-500">
          <span className="hidden sm:inline">From</span>
          <select
            value={sender}
            disabled={disabled}
            onChange={(e) => onSenderChange(e.target.value as SignatureSender)}
            className={SELECT_CLASS}
            aria-label="Send from which mailbox"
          >
            <option value="support">Support</option>
            <option value="antonio">Antonio</option>
          </select>
        </label>
      )}

      <label className="flex items-center gap-1 text-xs text-zinc-500">
        <span className="hidden sm:inline">Signature</span>
        <select
          // A variant not on offer for THIS sender — "hat" carried over from
          // switching Antonio -> Support — would otherwise render a blank
          // select. Fall back to the first option so the control still reads
          // truthfully. The value itself stays safe: on support "hat" and
          // "gala" produce the same output, because neither carries a photo.
          value={photoOptions.some((o) => o.value === variant) ? variant : photoOptions[0].value}
          disabled={disabled}
          onChange={(e) => onVariantChange(e.target.value as SignatureVariant)}
          className={SELECT_CLASS}
          aria-label="Which signature to attach"
        >
          {photoOptions.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
    </div>
  )
}
