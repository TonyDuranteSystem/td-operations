'use client'

import { useMemo } from 'react'
import {
  buildSignatureHtml,
  hasSignature,
  type SignatureVariant,
  type SignatureSender,
} from '@/lib/email/signature'

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

interface SignaturePreviewProps {
  sender: SignatureSender
  variant: SignatureVariant
  /**
   * True on paths where the sender types their own closing (compose, reply)
   * — the preview must show exactly what will be appended, and those paths
   * attach the block without "Best regards," (bug-hunter fix, 2026-08-05).
   */
  authorWritesClosing?: boolean
  className?: string
}

/**
 * Live preview of the signature that will be appended at send time.
 *
 * Exists because the composer is a plain textarea: the signature is attached
 * server-side, so without this the sender picks an option blind and only
 * sees the result in their Sent folder (Antonio's QA, 2026-08-05).
 *
 * The HTML comes from the same builder the send paths call — the preview
 * cannot drift from the real output. baseUrl is RELATIVE ("") on purpose:
 * the email itself carries absolute production URLs, but in-app the images
 * must load from whichever deployment is serving the CRM (the client bundle
 * cannot see the server's base-URL override, and production may not carry
 * the assets yet while this is sandbox-only).
 */
export function SignaturePreview({
  sender,
  variant,
  authorWritesClosing = true,
  className = '',
}: SignaturePreviewProps) {
  const html = useMemo(
    () =>
      hasSignature(variant)
        ? buildSignatureHtml({
            sender,
            variant,
            includeSignoff: !authorWritesClosing,
            baseUrl: '',
          })
        : '',
    [sender, variant, authorWritesClosing]
  )

  return (
    <div className={`rounded-lg border border-zinc-200 bg-zinc-50/60 px-3 py-2 ${className}`}>
      <p className="text-[10px] font-medium uppercase tracking-wide text-zinc-400 mb-1">
        Signature preview — added when you send
      </p>
      {html ? (
        // Our own generated markup, no user input — safe to inject.
        <div className="bg-white rounded-md p-3 overflow-x-auto" dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <p className="text-xs text-zinc-400 italic">No signature — the email ends with your text.</p>
      )}
    </div>
  )
}
