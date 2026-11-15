'use client'

/**
 * The Contact page's "Message" button (Antonio 2026-11-15: "write the message in portal chats directly from the contact — a card
 * pop-up to write the message, choose the topic etc."). It opens the same choices as the Portal Chats "Before you send" pop-up
 * — personal or one of the person's companies, who it is addressed to, the topic — in the small shared pop-up the document "eye" uses
 * (ShareMessageDialog, mode "message"), and sends through the normal staff chat route (POST /api/portal/chat), so every rule of a
 * normal staff send applies: the scope check, the portal notification, the email throttle.
 *
 * Nothing is pre-selected when there is more than one choice (a message to the wrong chat can reach every member of a company).
 * A typed message is never lost: if the send fails the pop-up stays open and shows why.
 *
 * Two looks, one behaviour: the labelled button in the Contact page header, and (variant "icon", Antonio 2026-11-15: "directly from the
 * list") a small chat icon beside a person's name in the Contacts list. The "no portal login" line is worked out by the server when the
 * pop-up opens, so a list of 50 rows costs nothing extra. In a list row the pop-up lives inside a clickable row, so the wrapper stops
 * clicks (and is marked data-no-nav) — otherwise a click inside the pop-up would open the person's page behind it.
 */
import { useState } from 'react'
import { MessageSquare, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { FastTooltip } from '@/components/ui/fast-tooltip'
import { ShareMessageDialog, type ShareSendResult } from '@/components/storage/share-message-dialog'
import { sendShareMessage } from '@/lib/crm-store/document-share-client'
import type { ShareContext } from '@/lib/portal/document-share-text'

type Askable = Extract<ShareContext, { askable: true }>

/** Fired on window after a message is sent from the Contact page, so an open Chat tab can reload its timeline. */
export const CONTACT_CHAT_SENT_EVENT = 'td:contact-chat-sent'

async function fetchMessageContext(contactId: string): Promise<Askable> {
  const res = await fetch(`/api/contacts/${encodeURIComponent(contactId)}/message-context`, { cache: 'no-store' })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error((data as { error?: string }).error || 'Could not work out who the message can go to — please try again.')
  const ctx = data as ShareContext
  if (!ctx.askable) throw new Error('This contact has nobody a message can go to.')
  return ctx
}

export function MessageContactButton({ contactId, contactName, variant = 'button' }: { contactId: string; contactName: string; variant?: 'button' | 'icon' }) {
  const [loading, setLoading] = useState(false)
  const [ctx, setCtx] = useState<Askable | null>(null)

  const open = async () => {
    if (loading) return
    setLoading(true)
    try {
      const c = await fetchMessageContext(contactId)
      setCtx({ ...c, recipientName: c.recipientName || contactName || undefined })
    } catch (e) {
      toast.error(e instanceof Error && e.message ? e.message : 'Could not open the message window — please try again.')
    } finally {
      setLoading(false)
    }
  }

  const send = async (r: ShareSendResult) => {
    await sendShareMessage(r) // throws with the server's reason; the pop-up shows it and stays open
    toast.success(`Message sent to ${r.target.label}`)
    setCtx(null)
    window.dispatchEvent(new CustomEvent(CONTACT_CHAT_SENT_EVENT, { detail: { contactId } }))
  }

  const label = 'Write a portal chat message to this person or to one of their companies.'
  return (
    <span data-no-nav className="inline-flex" onClick={(e) => e.stopPropagation()}>
      <FastTooltip label={variant === 'icon' ? `Message ${contactName || 'this person'}` : label}>
        {variant === 'icon' ? (
          <button
            type="button"
            onClick={open}
            disabled={loading}
            aria-label={label}
            className="inline-flex h-5 w-5 items-center justify-center rounded text-muted-foreground/60 transition-colors hover:bg-blue-50 hover:text-blue-700 focus-visible:text-blue-700 disabled:opacity-60"
          >
            {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <MessageSquare className="h-3.5 w-3.5" />}
          </button>
        ) : (
          <button
            type="button"
            onClick={open}
            disabled={loading}
            aria-label={label}
            className="inline-flex items-center gap-1.5 rounded-lg border border-blue-300 px-3 py-1 text-xs font-medium text-blue-700 transition-colors hover:bg-blue-50 disabled:opacity-60"
          >
            {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <MessageSquare className="h-3.5 w-3.5" />}
            Message
          </button>
        )}
      </FastTooltip>
      {ctx && <ShareMessageDialog mode="message" ctx={ctx} onResult={() => setCtx(null)} onSend={send} />}
    </span>
  )
}
