'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useLang, useT } from '@/components/marketing/lang-provider'
import { localeFor } from '@/lib/marketing/i18n'
import { EmailHtmlFrame } from '@/components/inbox/email-html-frame'
import { Composer, textToEditorHtml, type ComposerSeed } from '@/components/marketing/inbox/composer'
import type { Folder, MailAttachment, MailMessage, ThreadAction, ThreadRow } from '@/lib/marketing/inbox/mail-types'

interface Box { address: string; unread: number | null }
interface Suggest { reply: { to: string[]; cc: string[] }; replyAll: { to: string[]; cc: string[] }; subjectRe: string; subjectFwd: string }
type Msg = MailMessage & { suggest: Suggest }
interface Thread { id: string; subject: string; messages: Msg[]; starred: boolean; draftId?: string }

const FOLDER_LABEL: Record<Folder, string> = { inbox: 'Inbox', sent: 'Sent', drafts: 'Drafts', starred: 'Starred' }
const FOLDERS: Folder[] = ['inbox', 'sent', 'drafts', 'starred']

const sizeText = (n: number) => (n >= 1_048_576 ? `${(n / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`)

/**
 * TD Marketing — the Inbox (dev job 9aec66fa): the mailboxes this person may open as buttons, the folders (Inbox / Sent / Drafts / Starred), search, the list, reading an email (HTML in an isolated frame),
 * and the actions (Reply, Reply all, Forward, Archive, Delete, Mark unread, Star, Print, Copy link). It reads and writes only through /api/marketing/inbox/*, which only ever opens an address this person may open.
 * Every server answer is shown as written (R099).
 */
export function InboxApp({ initialBoxes, startAddress, startThread }: { initialBoxes: string[]; startAddress?: string; startThread?: string }) {
  const t = useT()
  const lang = useLang()
  const [boxes, setBoxes] = useState<Box[]>(initialBoxes.map(address => ({ address, unread: null })))
  const [address, setAddress] = useState(startAddress && initialBoxes.includes(startAddress) ? startAddress : initialBoxes[0])
  const [folder, setFolder] = useState<Folder>('inbox')
  const [qInput, setQInput] = useState('')
  const [q, setQ] = useState('')
  const [tokens, setTokens] = useState<string[]>([])
  const [next, setNext] = useState<string | null>(null)
  const [rows, setRows] = useState<ThreadRow[]>([])
  const [loading, setLoading] = useState(true)
  const [listError, setListError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(startThread ?? null)
  const [thread, setThread] = useState<Thread | null>(null)
  const [threadError, setThreadError] = useState<string | null>(null)
  const [composer, setComposer] = useState<ComposerSeed | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  const loadSeq = useRef(0)
  const threadSeq = useRef(0)

  const flash = (m: string) => { setToast(m); setTimeout(() => setToast(null), 3500) }
  const pageToken = tokens.length ? tokens[tokens.length - 1] : null

  // the list
  useEffect(() => {
    const seq = ++loadSeq.current
    setLoading(true); setListError(null)
    const p = new URLSearchParams({ address, folder, q })
    if (pageToken) p.set('pageToken', pageToken)
    fetch(`/api/marketing/inbox/threads?${p}`)
      .then(async r => { const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(typeof d.error === 'string' && d.error ? d.error : t('Could not reach the mailbox. Please try again.')); return d })
      .then(d => { if (seq !== loadSeq.current) return; setRows(d.rows ?? []); setNext(d.nextPageToken ?? null) })
      .catch(e => { if (seq === loadSeq.current) { setRows([]); setNext(null); setListError(e instanceof Error ? e.message : t('Could not reach the mailbox. Please try again.')) } })
      .finally(() => { if (seq === loadSeq.current) setLoading(false) })
  }, [address, folder, q, pageToken, tick, t])

  // the unread numbers on the address buttons, refreshed every minute
  useEffect(() => {
    const load = () => fetch('/api/marketing/inbox/mailboxes').then(r => (r.ok ? r.json() : null)).then(d => {
      if (d?.mailboxes) setBoxes((d.mailboxes as Array<{ address: string; unread: number | null }>).map(b => ({ address: b.address, unread: b.unread })))
    }).catch(() => {})
    load()
    const id = setInterval(load, 60_000)
    return () => clearInterval(id)
  }, [tick])

  // one thread
  useEffect(() => {
    if (!selected) { setThread(null); setThreadError(null); return }
    const seq = ++threadSeq.current
    setThread(null); setThreadError(null)
    fetch(`/api/marketing/inbox/threads/${encodeURIComponent(selected)}?address=${encodeURIComponent(address)}`)
      .then(async r => { const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(typeof d.error === 'string' && d.error ? d.error : t('Could not open this email. Please try again.')); return d as Thread })
      .then(d => {
        if (seq !== threadSeq.current) return
        setThread(d)
        // opening it reads it (as the CRM Inbox does)
        if (d.messages.some(m => m.unread)) {
          fetch(`/api/marketing/inbox/threads/${encodeURIComponent(selected)}/action`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ address, action: 'read' }) }).then(() => {
            setRows(rs => rs.map(r => (r.id === selected ? { ...r, unread: false } : r)))
            setBoxes(bs => bs.map(b => (b.address === address && b.unread ? { ...b, unread: Math.max(0, b.unread - 1) } : b)))
          }).catch(() => {})
        }
      })
      .catch(e => { if (seq === threadSeq.current) setThreadError(e instanceof Error ? e.message : t('Could not open this email. Please try again.')) })
  }, [selected, address, t])

  const act = useCallback(async (action: ThreadAction) => {
    if (!selected) return
    try {
      const res = await fetch(`/api/marketing/inbox/threads/${encodeURIComponent(selected)}/action`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ address, action }) })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(typeof d.error === 'string' && d.error ? d.error : t('That did not work. Please try again.'))
      if (action === 'archive' || action === 'trash') { setRows(rs => rs.filter(r => r.id !== selected)); setSelected(null); setComposer(null); flash(action === 'trash' ? t('Moved to the bin.') : t('Archived.')) }
      else if (action === 'unread') { setRows(rs => rs.map(r => (r.id === selected ? { ...r, unread: true } : r))); flash(t('Marked unread.')) }
      else if (action === 'read') setRows(rs => rs.map(r => (r.id === selected ? { ...r, unread: false } : r)))
      else setThread(th => (th ? { ...th, starred: action === 'star' } : th))
    } catch (e) { flash(e instanceof Error && e.message ? e.message : t('That did not work. Please try again.')) }
  }, [selected, address, t])

  const lastReal = thread ? thread.messages[thread.messages.length - 1] : null
  const openReply = (mode: 'reply' | 'replyAll' | 'forward') => {
    if (!thread || !lastReal) return
    const s = lastReal.suggest
    setComposer({
      mode, threadId: thread.id, messageId: lastReal.id,
      to: mode === 'forward' ? [] : (mode === 'reply' ? s.reply.to : s.replyAll.to), cc: mode === 'replyAll' ? s.replyAll.cc : [],
      subject: mode === 'forward' ? s.subjectFwd : s.subjectRe, html: '<p></p>',
    })
  }
  const editDraft = () => {
    if (!thread || !lastReal) return
    setComposer({
      mode: 'new', to: (lastReal.to || '').split(',').map(x => x.trim()).filter(Boolean), cc: [], subject: lastReal.subject || thread.subject, html: textToEditorHtml(lastReal.text), draftId: thread.draftId,
    })
  }
  const copyLink = () => {
    if (!thread) return
    const url = `${window.location.origin}/marketing/inbox?address=${encodeURIComponent(address)}&thread=${encodeURIComponent(thread.id)}`
    navigator.clipboard?.writeText(url).then(() => flash(t('Link copied.'))).catch(() => flash(t('Could not copy. Select the address bar and copy it.')))
  }
  const printThread = () => {
    if (!thread) return
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    const w = window.open('', '_blank', 'width=800,height=900')
    if (!w) { flash(t('The print window was blocked. Allow pop-ups for this page.')); return }
    // plain text only: nothing from an email is ever written into a window that shares our address
    w.document.write(`<title>${esc(thread.subject)}</title><body style="font:14px Arial">${thread.messages.map(m => `<h3>${esc(m.subject || thread.subject)}</h3><p>${esc(m.from)} &lt;${esc(m.fromEmail)}&gt;<br>${esc(new Date(m.date).toLocaleString(localeFor(lang)))}</p><pre style="white-space:pre-wrap;font:inherit">${esc(m.text)}</pre><hr>`).join('')}</body>`)
    w.document.close(); w.focus(); w.print()
  }
  const switchBox = (a: string) => { setAddress(a); setFolder('inbox'); setTokens([]); setQ(''); setQInput(''); setSelected(null); setComposer(null) }
  const switchFolder = (f: Folder) => { setFolder(f); setTokens([]); setSelected(null); setComposer(null) }
  const dateText = (iso: string) => new Date(iso).toLocaleString(localeFor(lang), { dateStyle: 'medium', timeStyle: 'short' })
  const dlHref = (a: MailAttachment) => `/api/marketing/inbox/attachment?address=${encodeURIComponent(address)}&messageId=${encodeURIComponent(a.messageId)}&attachmentId=${encodeURIComponent(a.attachmentId)}&filename=${encodeURIComponent(a.filename)}`

  const btn = 'rounded-lg border px-3 py-1.5 text-sm'
  return (
    <div className="space-y-3 p-6" data-testid="inbox">
      <h1 className="text-2xl font-semibold">{t('Inbox')}</h1>
      <div className="flex flex-wrap items-center gap-2" data-testid="inbox-addresses">
        {boxes.map(b => (
          <button key={b.address} type="button" onClick={() => switchBox(b.address)} data-testid={`inbox-box-${b.address}`} aria-pressed={b.address === address}
            className={`rounded-full border px-3 py-1 text-sm ${b.address === address ? 'border-slate-900 bg-slate-900 text-white' : 'bg-white'}`}>
            {b.address}{b.unread ? <b className="ml-1.5">{b.unread}</b> : null}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2 rounded-xl border bg-white p-2">
        <form className="flex min-w-0 flex-1 items-center gap-2" onSubmit={e => { e.preventDefault(); setTokens([]); setQ(qInput.trim()); setSelected(null) }}>
          <input value={qInput} onChange={e => setQInput(e.target.value)} placeholder={t('Search this mailbox')} aria-label={t('Search this mailbox')} className="min-w-0 flex-1 rounded-lg border px-3 py-1.5 text-sm" data-testid="inbox-search" />
          <button className={btn} type="submit" data-testid="inbox-search-go">{t('Search')}</button>
          {q && <button className={btn} type="button" onClick={() => { setQInput(''); setQ(''); setTokens([]) }} data-testid="inbox-search-clear">{t('Clear')}</button>}
        </form>
        {FOLDERS.map(f => (
          <button key={f} type="button" onClick={() => switchFolder(f)} aria-pressed={f === folder} data-testid={`inbox-folder-${f}`}
            className={`${btn} ${f === folder ? 'border-slate-900 bg-slate-900 text-white' : ''}`}>{t(FOLDER_LABEL[f])}</button>
        ))}
        <button type="button" className={`${btn} bg-slate-900 text-white`} data-testid="inbox-new" onClick={() => { setSelected(null); setComposer({ mode: 'new', to: [], cc: [], subject: '', html: '<p></p>' }) }}>+ {t('New email')}</button>
      </div>

      {toast && <p role="status" className="rounded-lg bg-slate-900 px-3 py-2 text-sm text-white" data-testid="inbox-toast">{toast}</p>}

      <div className="grid min-h-[480px] grid-cols-[320px_minmax(0,1fr)] overflow-hidden rounded-xl border bg-white">
        <div className="flex flex-col border-r" data-testid="inbox-list">
          <div className="min-h-0 flex-1 overflow-auto">
            {loading && <p className="p-4 text-sm text-slate-500" data-testid="inbox-loading">{t('Loading…')}</p>}
            {!loading && listError && <p role="alert" className="m-3 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-800" data-testid="inbox-list-error">{listError}</p>}
            {!loading && !listError && rows.length === 0 && <p className="p-4 text-sm text-slate-500" data-testid="inbox-empty">{q ? t('Nothing found.') : t('Nothing here.')}</p>}
            {!loading && rows.map(r => (
              <button key={r.id} type="button" onClick={() => { setSelected(r.id); setComposer(null) }} data-testid="inbox-row" data-unread={r.unread ? '1' : '0'}
                className={`block w-full border-b px-3 py-2 text-left ${r.id === selected ? 'bg-slate-100' : 'hover:bg-slate-50'}`}>
                <span className={`flex items-baseline justify-between gap-2 ${r.unread ? 'font-semibold' : ''}`}>
                  <span className="truncate">{r.unread ? '● ' : ''}{r.who || t('(no sender)')}</span>
                  <span className="shrink-0 text-xs font-normal text-slate-500">{new Date(r.date).toLocaleDateString(localeFor(lang), { day: 'numeric', month: 'short' })}</span>
                </span>
                <span className={`block truncate text-sm ${r.unread ? 'font-medium' : ''}`}>{r.subject}</span>
                <span className="block truncate text-xs text-slate-500">{r.snippet}</span>
              </button>
            ))}
          </div>
          <div className="flex items-center justify-between border-t p-2 text-sm">
            <button type="button" className="rounded border px-2 py-1 disabled:opacity-40" disabled={tokens.length === 0 || loading} onClick={() => setTokens(tk => tk.slice(0, -1))} data-testid="inbox-newer">{t('Newer')}</button>
            <button type="button" className="rounded border px-2 py-1 disabled:opacity-40" disabled={!next || loading} onClick={() => next && setTokens(tk => [...tk, next])} data-testid="inbox-older">{t('Older')}</button>
          </div>
        </div>

        <div className="min-w-0 p-4" data-testid="inbox-reader">
          {composer && (
            <Composer key={`${composer.mode}-${composer.threadId ?? 'new'}-${composer.draftId ?? ''}-${composer.messageId ?? ''}`} address={address} seed={composer}
              onClose={() => setComposer(null)} onDraftChanged={() => setTick(x => x + 1)}
              onSent={threadId => { setComposer(null); flash(t('Sent from {address}.', { address })); setTick(x => x + 1); if (threadId && composer.mode !== 'new') setSelected(threadId) }} />
          )}
          {!composer && !selected && <p className="text-sm text-slate-500" data-testid="inbox-pick">{t('Choose an email on the left, or write a new one.')}</p>}
          {!composer && selected && threadError && <p role="alert" className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-800" data-testid="inbox-thread-error">{threadError}</p>}
          {!composer && selected && !threadError && !thread && <p className="text-sm text-slate-500">{t('Loading…')}</p>}
          {!composer && thread && (
            <div className="space-y-3" data-testid="inbox-thread">
              <div>
                <h2 className="text-lg font-semibold" data-testid="inbox-subject">{thread.subject}</h2>
              </div>
              <div className="flex flex-wrap gap-2" data-testid="inbox-actions">
                {folder === 'drafts' && thread.draftId
                  ? <button type="button" className={`${btn} bg-slate-900 text-white`} onClick={editDraft} data-testid="inbox-edit-draft">{t('Edit draft')}</button>
                  : <>
                      <button type="button" className={btn} onClick={() => openReply('reply')} data-testid="inbox-reply">{t('Reply')}</button>
                      <button type="button" className={btn} onClick={() => openReply('replyAll')} data-testid="inbox-reply-all">{t('Reply all')}</button>
                      <button type="button" className={btn} onClick={() => openReply('forward')} data-testid="inbox-forward">{t('Forward')}</button>
                    </>}
                <button type="button" className={btn} onClick={() => act('archive')} data-testid="inbox-archive">{t('Archive')}</button>
                <button type="button" className={btn} onClick={() => act('trash')} data-testid="inbox-delete">{t('Delete')}</button>
                <button type="button" className={btn} onClick={() => act('unread')} data-testid="inbox-unread">{t('Mark unread')}</button>
                <button type="button" className={btn} onClick={() => act(thread.starred ? 'unstar' : 'star')} data-testid="inbox-star" aria-pressed={thread.starred}>{thread.starred ? t('Unstar') : t('Star')}</button>
                <button type="button" className={btn} onClick={printThread} data-testid="inbox-print">{t('Print')}</button>
                <button type="button" className={btn} onClick={copyLink} data-testid="inbox-copy-link">{t('Copy link')}</button>
              </div>
              {thread.messages.map(m => (
                <div key={m.id} className="rounded-xl border bg-slate-50 p-3" data-testid="inbox-message">
                  <div className="mb-2 text-sm"><b>{m.from}</b> <span className="text-slate-500">&lt;{m.fromEmail}&gt;</span>
                    <div className="text-xs text-slate-500">{t('To')}: {m.to}{m.cc ? ` · Cc: ${m.cc}` : ''} · {dateText(m.date)}</div></div>
                  {m.html !== null ? <EmailHtmlFrame html={m.html} /> : <pre className="whitespace-pre-wrap font-sans text-sm" data-testid="inbox-text">{m.text}</pre>}
                  {m.attachments.length > 0 && (
                    <ul className="mt-2 flex flex-wrap gap-2">
                      {m.attachments.map(a => (
                        <li key={a.attachmentId}><a href={dlHref(a)} className="rounded-full border bg-white px-2 py-0.5 text-xs" data-testid="inbox-attachment" download>&#128206; {a.filename} ({sizeText(a.size)})</a></li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
