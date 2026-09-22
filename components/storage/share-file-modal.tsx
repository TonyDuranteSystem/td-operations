'use client'

/**
 * The "Share" action for a CRM Storage file — Antonio's request (2026-09-14):
 * "download, share by email, portal chats, team chat, send a fax... e-sign
 * is a separate follow-up (no existing tool lets an existing file be
 * dropped straight into a signature envelope — see the plan discussion)."
 *
 * A simple type-chooser, then the matching destination picker. Each
 * destination has its own real size ceiling (CRM Storage itself has none —
 * see lib/crm-storage/share-limits.ts for why) — checked here, before
 * fetching anything, so an oversized pick fails with one clear message
 * instead of a slow, doomed upload.
 */
import { useState } from 'react'
import { ArrowLeft, CheckCircle2, Mail, MessageSquare, Printer, Send, X } from 'lucide-react'
import { ComposeDialog } from '@/components/inbox/compose-dialog'
import { ShareTeamChatPicker } from './share-team-chat-picker'
import { SharePortalChatPicker } from './share-portal-chat-picker'
import { ShareFaxDialog } from './share-fax-dialog'
import { fetchStorageFileBytes } from '@/lib/crm-storage/fetch-file'
import { CHAT_SHARE_MAX_BYTES, CHAT_SHARE_MAX_MB, EMAIL_SHARE_MAX_BYTES, EMAIL_SHARE_MAX_MB, FAX_SHARE_MAX_BYTES, FAX_SHARE_MAX_MB, formatMb } from '@/lib/crm-storage/share-limits'

export interface ShareableFile {
  id: string
  file_name: string
  mime_type: string | null
  file_size: number | null
}

type Mode = 'choose' | 'email' | 'team_chat' | 'portal_chat' | 'fax' | 'done'

export function ShareFileModal({ file, onClose }: { file: ShareableFile; onClose: () => void }) {
  const [mode, setMode] = useState<Mode>('choose')
  const [error, setError] = useState<string | null>(null)
  const [doneMessage, setDoneMessage] = useState('')
  const [emailFile, setEmailFile] = useState<File | null>(null)
  const [preparingEmail, setPreparingEmail] = useState(false)

  const size = file.file_size ?? 0

  const pick = async (next: Exclude<Mode, 'choose' | 'done'>) => {
    setError(null)
    if (next === 'email' && size > EMAIL_SHARE_MAX_BYTES) {
      setError(`That file is ${formatMb(size)} MB — too large to email. Maximum: ${EMAIL_SHARE_MAX_MB} MB.`)
      return
    }
    if ((next === 'team_chat' || next === 'portal_chat') && size > CHAT_SHARE_MAX_BYTES) {
      setError(`That file is ${formatMb(size)} MB — too large for chat. Maximum: ${CHAT_SHARE_MAX_MB} MB.`)
      return
    }
    if (next === 'fax' && size > FAX_SHARE_MAX_BYTES) {
      setError(`That file is ${formatMb(size)} MB — too large to fax. Maximum: ${FAX_SHARE_MAX_MB} MB.`)
      return
    }

    if (next === 'email') {
      setPreparingEmail(true)
      try {
        const f = await fetchStorageFileBytes(file.id, file.file_name, file.mime_type)
        setEmailFile(f)
        setMode('email')
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not read the file. Please try again.')
      } finally {
        setPreparingEmail(false)
      }
      return
    }
    setMode(next)
  }

  if (mode === 'email') {
    // ComposeDialog handles its own close; once it opens, this wrapper's
    // job is done — the compose window stays open independently.
    return (
      <ComposeDialog
        open={emailFile !== null}
        onClose={onClose}
        prefillSubject={file.file_name}
        prefillFiles={emailFile ? [emailFile] : undefined}
        zIndexClassName="z-[70]"
      />
    )
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div className="w-full max-w-sm rounded-lg bg-white p-4 shadow-xl" onClick={e => e.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between">
          <div className="flex items-center gap-2 min-w-0">
            {mode !== 'choose' && mode !== 'done' && (
              <button onClick={() => { setMode('choose'); setError(null) }} className="rounded-full p-1 hover:bg-zinc-100" aria-label="Back">
                <ArrowLeft className="h-4 w-4" />
              </button>
            )}
            <span className="truncate text-sm font-medium text-zinc-900">{file.file_name}</span>
          </div>
          <button onClick={onClose} className="rounded-full p-1 hover:bg-zinc-100" aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>

        {error && <div className="mb-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{error}</div>}

        {mode === 'done' ? (
          <div className="flex flex-col items-center gap-2 py-6 text-center">
            <CheckCircle2 className="h-8 w-8 text-emerald-500" />
            <p className="text-sm text-zinc-700">{doneMessage || 'Sent.'}</p>
            <button onClick={onClose} className="mt-2 rounded-md border border-zinc-200 px-4 py-1.5 text-sm hover:bg-zinc-50">Close</button>
          </div>
        ) : mode === 'choose' ? (
          <div className="flex flex-col gap-1">
            <button
              onClick={() => void pick('email')}
              disabled={preparingEmail}
              className="flex items-center gap-3 rounded-md px-3 py-2.5 text-left text-sm hover:bg-zinc-50 disabled:opacity-40"
            >
              <Mail className="h-4 w-4 text-zinc-500" />
              {preparingEmail ? 'Preparing...' : 'Email it'}
            </button>
            <button onClick={() => void pick('portal_chat')} className="flex items-center gap-3 rounded-md px-3 py-2.5 text-left text-sm hover:bg-zinc-50">
              <Send className="h-4 w-4 text-zinc-500" />
              Send to a client&apos;s portal chat
            </button>
            <button onClick={() => void pick('team_chat')} className="flex items-center gap-3 rounded-md px-3 py-2.5 text-left text-sm hover:bg-zinc-50">
              <MessageSquare className="h-4 w-4 text-zinc-500" />
              Send to team chat
            </button>
            <button onClick={() => void pick('fax')} className="flex items-center gap-3 rounded-md px-3 py-2.5 text-left text-sm hover:bg-zinc-50">
              <Printer className="h-4 w-4 text-zinc-500" />
              Send a fax
            </button>
          </div>
        ) : mode === 'team_chat' ? (
          <ShareTeamChatPicker fileId={file.id} onSent={() => { setDoneMessage('Sent to team chat.'); setMode('done') }} onError={setError} />
        ) : mode === 'portal_chat' ? (
          <SharePortalChatPicker fileId={file.id} fileName={file.file_name} onSent={msg => { setDoneMessage(msg); setMode('done') }} onError={setError} />
        ) : mode === 'fax' ? (
          <ShareFaxDialog fileId={file.id} fileName={file.file_name} mimeType={file.mime_type} onSent={() => { setDoneMessage('Fax sent.'); setMode('done') }} onError={setError} />
        ) : null}
      </div>
    </div>
  )
}
