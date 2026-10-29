'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { windowSrc } from '@/lib/marketing/lead-windows'

/**
 * A message on Antonio's CRM Marketing page (TD Marketing, dev job 9aec66fa — Antonio, 29 Oct 2026: "I click a message and I am back in Rocco's board; to read the next one I go through CRM, Marketing, my dashboard again").
 * A click opens that lead's chat right here, in a window on top of this page (the same lead page the workspace shows in its own windows), and closing it reads the list again — the message he has read is gone.
 * English, like the rest of his CRM section. A lead id that is not a plain id has no window, so the link falls back to the workspace.
 */
export function CrmLeadChatLink({ leadId, name, className, testId, children }: { leadId: string; name: string; className?: string; testId?: string; children: React.ReactNode }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const src = windowSrc(leadId, 'chat')
  const close = () => { setOpen(false); router.refresh() }
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); router.refresh() } }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, router])
  if (!src) return <a href={`/marketing/board?chat=${encodeURIComponent(leadId)}`} className={className} data-testid={testId}>{children}</a>
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className={`${className ?? ''} w-full text-left`} data-testid={testId} data-lead={leadId}>{children}</button>
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4" role="dialog" aria-modal="true" aria-label={`Chat with ${name}`} data-testid="crm-chat-dialog" onClick={e => { if (e.target === e.currentTarget) close() }}>
          <div className="flex h-[min(46rem,92vh)] w-[min(40rem,96vw)] flex-col overflow-hidden rounded-xl border bg-white shadow-2xl">
            <div className="flex items-center justify-between gap-3 border-b px-4 py-2.5">
              <b className="min-w-0 truncate text-sm">{name}</b>
              <button type="button" onClick={close} className="rounded-lg border px-3 py-1 text-sm hover:bg-slate-50" data-testid="crm-chat-close">Close</button>
            </div>
            <iframe src={src} title={`Chat with ${name}`} className="min-h-0 w-full flex-1 border-0" data-testid="crm-chat-frame" />
          </div>
        </div>
      )}
    </>
  )
}
