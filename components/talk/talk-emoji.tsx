'use client'

import { useEffect, useRef, useState } from 'react'
import dynamic from 'next/dynamic'
import { cn } from '@/lib/utils'
import { REACTION_EMOJIS } from '@/lib/talk/chat-model'
import { useTalkI18n } from '@/components/talk/talk-i18n'

// the same full emoji picker the portal chat uses (loaded only when somebody asks for more than the six quick ones)
const EmojiPicker = dynamic(() => import('emoji-picker-react'), { ssr: false })

/**
 * The emoji choice that opens from a message's hover toolbar on a computer (TD Marketing chats; dev job 9aec66fa, Antonio 28 Oct 2026): the six quick reactions of TD Talk's own menu,
 * and "+" for every emoji. It closes when you click anywhere else. Pure UI: the caller says what picking one does.
 */
export function TalkEmojiPopover({ mine, onPick, onClose, align }: { mine: readonly string[]; onPick: (emoji: string) => void; onClose: () => void; align: 'left' | 'right' }) {
  const { t } = useTalkI18n()
  const box = useRef<HTMLDivElement>(null)
  const [more, setMore] = useState(false)
  useEffect(() => {
    // a click on the toolbar's own emoji button is the button's job (it closes the popover itself); everything else outside closes it
    const away = (e: MouseEvent) => { if ((e.target as Element | null)?.closest?.('[data-testid="talk-tool-emoji"]')) return; if (box.current && !box.current.contains(e.target as Node)) onClose() }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('mousedown', away)
    document.addEventListener('keydown', esc)
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc) }
  }, [onClose])
  return (
    <div ref={box} className={cn('absolute top-full z-20 mt-1 rounded-xl border border-zinc-200 bg-white p-1.5 shadow-lg', align === 'right' ? 'right-0' : 'left-0')} data-testid="talk-emoji-popover">
      <div className="flex items-center gap-0.5">
        {REACTION_EMOJIS.map(e => (
          <button key={e} type="button" onClick={() => onPick(e)} aria-label={t('React {emoji}', { emoji: e })} data-testid={`talk-quick-${e}`}
            className={cn('flex h-8 w-8 items-center justify-center rounded-full text-lg hover:bg-zinc-100', mine.includes(e) && 'bg-zinc-200')}>{e}</button>
        ))}
        <button type="button" onClick={() => setMore(m => !m)} aria-label={t('More emoji')} data-testid="talk-emoji-more" className="flex h-8 w-8 items-center justify-center rounded-full text-lg text-zinc-500 hover:bg-zinc-100">{more ? '−' : '+'}</button>
      </div>
      {more && (
        <div className="mt-1" data-testid="talk-emoji-picker">
          <EmojiPicker width={300} height={320} lazyLoadEmojis previewConfig={{ showPreview: false }} onEmojiClick={d => onPick(d.emoji)} />
        </div>
      )}
    </div>
  )
}
