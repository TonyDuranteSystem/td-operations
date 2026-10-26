'use client'

import { useRef, useState } from 'react'
import { useT } from '@/components/marketing/lang-provider'
import { RichEditor, type RichEditorHandle } from '@/components/inbox/rich-editor'
import { DEFAULT_RICH_STYLE, type RichStyle } from '@/lib/inbox/rich-text'

export interface ComposerSeed {
  mode: 'new' | 'reply' | 'replyAll' | 'forward'
  threadId?: string
  messageId?: string
  to: string[]
  cc: string[]
  subject: string
  /** the editor's starting html */
  html: string
  draftId?: string
}

interface Staged { path: string; name: string; mime_type: string; size: number }

const MAX_TOTAL = 18 * 1024 * 1024
const htmlEscape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
/** plain text typed or kept in a draft -> the editor's html */
export const textToEditorHtml = (text: string): string => text.split(/\n{2,}/).map(p => `<p>${htmlEscape(p).replace(/\n/g, '<br>')}</p>`).join('') || '<p></p>'

/**
 * TD Marketing — writing an email in the Inbox (dev job 9aec66fa): To / Cc / Bcc, Subject, the same formatting editor the CRM reply uses, attachments (uploaded straight to private storage, never through
 * our server), Save draft, Send. The server decides everything that matters (sender, quoted original, signature, who may be written to); this only collects what the person typed. Every server answer is shown as written (R099).
 */
export function Composer({ address, seed, onClose, onSent, onDraftChanged }: {
  address: string
  seed: ComposerSeed
  onClose: () => void
  onSent: (threadId?: string) => void
  onDraftChanged: () => void
}) {
  const t = useT()
  const editorRef = useRef<RichEditorHandle>(null)
  const [to, setTo] = useState(seed.to.join(', '))
  const [cc, setCc] = useState(seed.cc.join(', '))
  const [bcc, setBcc] = useState('')
  const [showCc, setShowCc] = useState(seed.cc.length > 0)
  const [subject, setSubject] = useState(seed.subject)
  const [style, setStyle] = useState<RichStyle>(DEFAULT_RICH_STYLE)
  const [files, setFiles] = useState<Staged[]>([])
  const [draftId, setDraftId] = useState<string | undefined>(seed.draftId)
  const [busy, setBusy] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const sendKey = useRef<string>(`${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`)

  const payload = () => ({
    address, mode: seed.mode, threadId: seed.threadId, messageId: seed.messageId, to, cc, bcc, subject,
    messageHtml: editorRef.current?.getHTML() ?? '', style, draftId,
    attachments: files.map(f => ({ path: f.path, name: f.name, mime_type: f.mime_type })),
  })

  async function post(url: string, body: Record<string, unknown>, fallback: string): Promise<Record<string, unknown> | null> {
    setBusy(true); setError(null); setNote(null)
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(typeof d.error === 'string' && d.error ? d.error : fallback)
      return d
    } catch (e) { setError(e instanceof Error && e.message ? e.message : fallback); return null } finally { setBusy(false) }
  }

  async function send() {
    const d = await post('/api/marketing/inbox/send', { ...payload(), sendKey: sendKey.current }, t('The email could not be sent. Nothing was sent; try again.'))
    if (d) onSent(typeof d.threadId === 'string' ? d.threadId : undefined)
  }
  async function saveDraft() {
    const d = await post('/api/marketing/inbox/drafts', payload(), t('The draft could not be saved. Please try again.'))
    if (d && typeof d.draftId === 'string') { setDraftId(d.draftId); setNote(t('Draft saved. Attachments are not kept in a draft.')); onDraftChanged() }
  }
  async function discard() {
    if (draftId) {
      await fetch(`/api/marketing/inbox/drafts?address=${encodeURIComponent(address)}&draftId=${encodeURIComponent(draftId)}`, { method: 'DELETE' }).catch(() => {})
      onDraftChanged()
    }
    onClose()
  }

  async function attach(list: File[]) {
    if (list.length === 0) return
    setError(null); setUploading(true)
    try {
      let total = files.reduce((n, f) => n + f.size, 0)
      const added: Staged[] = []
      for (const file of list) {
        total += file.size
        if (total > MAX_TOTAL) { setError(t('The attachments are too big. Keep them under 18 MB together.')); break }
        const u = await fetch('/api/marketing/inbox/attachments/upload-url', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ address, file_name: file.name }) })
        const ud = await u.json().catch(() => ({}))
        if (!u.ok || !ud.signedUrl || !ud.path) { setError(typeof ud.error === 'string' && ud.error ? ud.error : t('Could not start the upload. Please try again.')); break }
        const put = await fetch(ud.signedUrl, { method: 'PUT', headers: { 'Content-Type': file.type || 'application/octet-stream' }, body: file })
        if (!put.ok) { setError(t('Upload failed. Please check your connection and try again.')); break }
        added.push({ path: ud.path, name: file.name, mime_type: file.type || 'application/octet-stream', size: file.size })
      }
      if (added.length) setFiles(f => [...f, ...added])
    } finally { setUploading(false) }
  }

  const field = 'w-full rounded-lg border bg-white px-3 py-1.5 text-sm'
  const btn = 'rounded-lg border px-3 py-1.5 text-sm disabled:opacity-50'
  return (
    <div className="space-y-2 rounded-xl border bg-white p-3" data-testid="composer">
      <div className="flex items-center gap-2 text-sm"><span className="w-12 text-slate-500">{t('From')}</span><span className="text-slate-700" data-testid="composer-from">{address}</span></div>
      <div className="flex items-center gap-2 text-sm"><label className="w-12 text-slate-500" htmlFor="cmp-to">{t('To')}</label>
        <input id="cmp-to" className={field} value={to} onChange={e => setTo(e.target.value)} autoComplete="off" data-testid="composer-to" />
        {!showCc && <button type="button" className="shrink-0 text-xs text-slate-500 underline" onClick={() => setShowCc(true)} data-testid="composer-show-cc">{t('Cc / Bcc')}</button>}
      </div>
      {showCc && (
        <>
          <div className="flex items-center gap-2 text-sm"><label className="w-12 text-slate-500" htmlFor="cmp-cc">Cc</label><input id="cmp-cc" className={field} value={cc} onChange={e => setCc(e.target.value)} autoComplete="off" data-testid="composer-cc" /></div>
          <div className="flex items-center gap-2 text-sm"><label className="w-12 text-slate-500" htmlFor="cmp-bcc">Bcc</label><input id="cmp-bcc" className={field} value={bcc} onChange={e => setBcc(e.target.value)} autoComplete="off" data-testid="composer-bcc" /></div>
        </>
      )}
      <div className="flex items-center gap-2 text-sm"><label className="w-12 text-slate-500" htmlFor="cmp-subject">{t('Subject')}</label>
        <input id="cmp-subject" className={field} value={subject} onChange={e => setSubject(e.target.value)} autoComplete="off" data-testid="composer-subject" /></div>
      <RichEditor
        ref={editorRef} initialHtml={seed.html} style={style} onStyleChange={setStyle} toolbar="full" onChange={() => {}} onFocus={() => {}} onSend={() => { if (!busy && !uploading) void send() }}
        onPasteFiles={pasted => { void attach(pasted) }} placeholder={t('Write your message')}
        surfaceClassName="min-h-[180px] max-h-[360px] overflow-auto rounded-b-lg border bg-white px-3 py-2 text-sm" autoFocus
      />
      {files.length > 0 && (
        <ul className="flex flex-wrap gap-2" data-testid="composer-files">
          {files.map(f => (
            <li key={f.path} className="flex items-center gap-1 rounded-full border bg-slate-50 px-2 py-0.5 text-xs">&#128206; {f.name}
              <button type="button" aria-label={t('Remove')} className="text-slate-500" onClick={() => setFiles(l => l.filter(x => x.path !== f.path))}>&times;</button></li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={`${btn} bg-slate-900 text-white`} disabled={busy || uploading} onClick={send} data-testid="composer-send">{t('Send')}</button>
        <label className={`${btn} cursor-pointer`} data-testid="composer-attach-label">{uploading ? t('Uploading…') : t('Attach')}
          <input type="file" multiple className="sr-only" disabled={busy || uploading} onChange={e => { void attach(Array.from(e.target.files ?? [])); e.target.value = '' }} data-testid="composer-attach" /></label>
        <button type="button" className={btn} disabled={busy} onClick={saveDraft} data-testid="composer-save-draft">{t('Save draft')}</button>
        <button type="button" className={btn} disabled={busy} onClick={discard} data-testid="composer-discard">{draftId ? t('Discard draft') : t('Close')}</button>
        <span className="text-xs text-slate-400">{t('Cmd/Ctrl+Enter sends')}</span>
      </div>
      {note && <p role="status" className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800" data-testid="composer-note">{note}</p>}
      {error && <p role="alert" className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-800" data-testid="composer-error">{error}</p>}
    </div>
  )
}
