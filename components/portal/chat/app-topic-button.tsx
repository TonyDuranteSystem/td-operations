'use client'

// The Topic button of the portal chat inside the CLIENT iPhone app (dev job 056a70d0, Step 3b; docs/systems/client-app.md).
// It replaces the website's row of topic pills: ONE button shows the open topic, with a red number for the unread answers in the OTHER topics,
// and opens a list that slides up (unread topics first, as on the website) with "Create a new topic" at the end. Rendered only when the chat
// is in app mode. The topic list, its order and the unread counts come from the chat itself; this only draws them.
import { useState } from 'react'
import { Check, ChevronDown, Plus } from 'lucide-react'
import { BottomSheet } from '@/components/app-mode/bottom-sheet'
import { useLocale } from '@/lib/portal/use-locale'
import { unreadInOtherTopics } from '@/lib/portal-app/chat-topic'

export function AppTopicButton({ activeTopic, topicOrder, unreadByTopic, onChoose }: {
  activeTopic: string | null
  /** Topic keys in display order; '' is General. */
  topicOrder: readonly string[]
  unreadByTopic: Readonly<Record<string, number>>
  /** null = General. */
  onChoose: (topic: string | null) => void
}) {
  const { t } = useLocale()
  const [open, setOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const general = t('portalChat.general')
  const current = activeTopic || general
  const others = unreadInOtherTopics(unreadByTopic, activeTopic)
  const label = others > 0
    ? t('app.topicLabelUnread').replace('{name}', () => current).replace('{n}', String(others))
    : t('app.topicLabel').replace('{name}', () => current)

  const close = () => { setOpen(false); setCreating(false); setName('') }
  const choose = (key: string) => { onChoose(key === '' ? null : key); close() }
  const create = () => {
    const v = name.trim()
    if (!v) return
    onChoose(v)
    close()
  }

  return (
    <>
      <button
        type="button"
        aria-label={label}
        data-testid="app-topic-button"
        onClick={() => setOpen(true)}
        className="relative flex h-10 shrink-0 items-center gap-1.5 rounded-full border border-zinc-300 bg-white pl-4 pr-3 text-[15px] font-semibold text-zinc-900"
      >
        <span className="max-w-[150px] truncate">{current}</span>
        <ChevronDown className="h-4 w-4" aria-hidden="true" />
        {others > 0 && (
          <span className="absolute -right-1.5 -top-1.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-[#EF4444] px-[5px] text-[11.5px] font-bold text-white">
            {others > 99 ? '99+' : others}
          </span>
        )}
      </button>
      <BottomSheet open={open} onClose={close} title={t('app.topics')} closeLabel={t('app.close')}>
        <div className="flex items-center justify-between px-5 pb-2 pt-3">
          <p className="text-lg font-bold text-zinc-900">{t('app.topics')}</p>
          <button type="button" onClick={close} className="h-11 px-2 text-base font-semibold text-blue-600">{t('app.close')}</button>
        </div>
        <div data-testid="app-topic-list">
          {topicOrder.map(key => {
            const active = (activeTopic ?? '') === key
            const unread = unreadByTopic[key] ?? 0
            return (
              <button
                key={key || '__general__'}
                type="button"
                onClick={() => choose(key)}
                aria-current={active ? 'true' : undefined}
                className="flex min-h-[52px] w-full items-center justify-between gap-3 border-t border-zinc-100 px-5 text-left text-[17px] text-zinc-900 active:bg-zinc-50"
              >
                <span className="min-w-0 flex-1 truncate font-medium">{key || general}</span>
                {unread > 0 && !active && (
                  <span className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-[#EF4444] px-[5px] text-[11.5px] font-bold text-white">{unread > 99 ? '99+' : unread}</span>
                )}
                {active && <Check className="h-5 w-5 shrink-0 text-blue-600" aria-hidden="true" />}
              </button>
            )
          })}
          {creating ? (
            <div className="flex items-center gap-2 border-t border-zinc-100 px-5 py-2">
              <input
                autoFocus
                type="text"
                value={name}
                onChange={e => setName(e.target.value.slice(0, 100))}
                onKeyDown={e => { if (e.key === 'Enter') create() }}
                placeholder={t('portalChat.topicNamePlaceholder')}
                className="h-11 min-w-0 flex-1 rounded-lg border border-zinc-300 px-3 text-base outline-none focus:border-blue-500"
              />
              <button type="button" onClick={create} disabled={!name.trim()} className="h-11 shrink-0 rounded-lg bg-zinc-900 px-4 text-base font-semibold text-white disabled:opacity-40">{t('app.create')}</button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setCreating(true)}
              className="flex min-h-[52px] w-full items-center gap-2 border-t border-zinc-100 px-5 text-left text-[17px] font-medium text-blue-600 active:bg-zinc-50"
            >
              {/* the app's shared button size rule centres a button's content, so the row fills itself with this inner box */}
              <span className="flex w-full items-center gap-2">
                <Plus className="h-5 w-5" aria-hidden="true" />
                {t('portalChat.createNewTopic')}
              </span>
            </button>
          )}
        </div>
      </BottomSheet>
    </>
  )
}
