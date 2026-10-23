'use client'

/**
 * The staff "eye" pop-up as a hook, so every eye (storage browser, contact page, account file manager) behaves the same:
 *   const { decide, dialog } = useShareMessagePrompt()   →  render {dialog} once; call decide(files) BEFORE showing.
 *
 * decide() fetches who the message can go to for ALL the files; ONE pop-up is shown only when they all share the same
 * audience (otherwise nothing can be offered — 'show_only', the client still gets the portal notification). It throws
 * when the audience cannot be read, so the caller fails closed (nothing is shown) instead of silently skipping the choice.
 * sendChat() sends the chosen message through the normal staff route and offers "Retry message" on failure.
 */
import { useCallback, useRef, useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import { ShareMessageDialog, type ShareDialogResult } from './share-message-dialog'
import { fetchShareContext, sendShareMessage, type ShareSource } from '@/lib/crm-store/document-share-client'
import { sameShareAudience, type ShareContext } from '@/lib/portal/document-share-text'
import type { Locale } from '@/lib/locale'

export type ShareSend = Extract<ShareDialogResult, { action: 'send' }>
export type ShareDecision =
  | { kind: 'cancel' }
  | { kind: 'just_show' }
  | { kind: 'send'; pick: ShareSend; locale: Locale }
  | { kind: 'show_only'; reason: 'personal' | 'mixed' | 'no_recipient' | 'not_listed' }

type Askable = Extract<ShareContext, { askable: true }>
export interface ShareFile { id: string; name: string; /** default 'store' */ source?: ShareSource }
const errMsg = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback)

/** Fetch the audience of each file, a few at a time. */
async function contextsOf(files: ShareFile[]): Promise<ShareContext[]> {
  const out: ShareContext[] = []
  for (let i = 0; i < files.length; i += 5) out.push(...(await Promise.all(files.slice(i, i + 5).map((f) => fetchShareContext(f.id, f.source)))))
  return out
}

export function useShareMessagePrompt(): {
  decide: (files: ShareFile[], note?: string) => Promise<ShareDecision>
  sendChat: (msg: ShareSend, shownNames: string[]) => Promise<boolean>
  dialog: ReactNode
} {
  const deciding = useRef(false) // a second eye clicked while one is still asking must not replace the first pop-up
  const [ask, setAsk] = useState<{ fileNames: string[]; ctx: Askable; note?: string; resolve: (r: ShareDialogResult) => void } | null>(null)

  const decide = useCallback(async (files: ShareFile[], note?: string): Promise<ShareDecision> => {
    if (files.length === 0) return { kind: 'show_only', reason: 'not_listed' }
    if (deciding.current) return { kind: 'cancel' }
    deciding.current = true
    try {
      const ctxs = await contextsOf(files)
      const first = ctxs[0]
      if (first.askable === false) return { kind: 'show_only', reason: first.reason }
      if (!first.askable) return { kind: 'show_only', reason: 'not_listed' }
      if (!ctxs.every((c) => sameShareAudience(first, c))) return { kind: 'show_only', reason: 'mixed' }
      const fileNames = files.map((f) => f.name)
      const pick = await new Promise<ShareDialogResult>((resolve) => setAsk({ fileNames, ctx: first, note, resolve }))
      setAsk(null)
      if (pick.action === 'cancel') return { kind: 'cancel' }
      if (pick.action === 'just_show') return { kind: 'just_show' }
      return { kind: 'send', pick, locale: first.locale }
    } finally { deciding.current = false }
  }, [])

  const sendChat = useCallback(async (msg: ShareSend, shownNames: string[]): Promise<boolean> => {
    const label = shownNames.length === 1 ? `"${shownNames[0]}"` : `${shownNames.length} files`
    const trySend = async (): Promise<boolean> => {
      try {
        await sendShareMessage(msg)
        toast.success(`Message sent to ${msg.target.label}`)
        return true
      } catch (e) {
        // the files are already visible — never undone; offer a retry of the message only
        toast.error(`${label} ${shownNames.length === 1 ? 'is' : 'are'} visible, but the message was not sent: ${errMsg(e, 'please try again.')}`, { duration: 15000, action: { label: 'Retry message', onClick: () => { void trySend() } } })
        return false
      }
    }
    return trySend()
  }, [])

  const dialog = ask ? <ShareMessageDialog fileNames={ask.fileNames} ctx={ask.ctx} note={ask.note} onResult={ask.resolve} /> : null
  return { decide, sendChat, dialog }
}

/** The pop-up answered (show with no automatic chat line) — otherwise the automatic line stays as it was. */
export const suppressesAutoChat = (d: ShareDecision | null): boolean => d?.kind === 'just_show' || d?.kind === 'send'
