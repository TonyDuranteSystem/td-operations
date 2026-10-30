/**
 * TD Talk's wide-screen layout (Antonio, 30 Oct 2026: "open the chat next to the list when I click a name or a chat").
 * On a wide screen the list of people and groups stays in a column on the left and the open chat fills the rest; on a phone or a narrow window it is
 * one screen at a time, as it always was. Pure on purpose: the class names are written out in full (Tailwind only keeps classes it can read as whole words),
 * and the CRM tab switches to two columns later (`xl`) than the standalone app (`lg`) because the CRM's own left menu already takes some width.
 */
import { TD_TALK_TAB } from '@/lib/talk/paths'

export interface TalkSplit {
  /** The column that holds the list. */
  listPane: string
  /** The column that holds the open chat (or the "pick a chat" note when none is open). */
  chatPane: string
  /** Added to the back arrow: on a wide screen the list is always there, so there is nothing to go back to. */
  back: string
  /** Shown only in the empty right column of a wide screen. */
  emptyNote: string
}

/**
 * The red unread number on a list row. The chat that is open AND being looked at has nothing unread (opening it marks it read on the server, but the list
 * only learns that on its next refresh) — so its number is hidden instead of lingering for a few seconds beside the chat that is already on screen.
 */
export function showUnreadBadge(unread: number | null | undefined, isOpenChat: boolean, beingViewed: boolean): boolean {
  if (!unread || unread <= 0) return false
  return !(isOpenChat && beingViewed)
}

export function talkSplit(base: string, hasChat: boolean): TalkSplit {
  const crmTab = base === TD_TALK_TAB
  if (crmTab) {
    return {
      listPane: `h-full w-full xl:w-[340px] xl:shrink-0 xl:border-r xl:border-zinc-200 ${hasChat ? 'hidden xl:flex' : 'flex'}`,
      chatPane: `h-full min-w-0 flex-1 ${hasChat ? 'flex' : 'hidden xl:flex'}`,
      back: 'xl:hidden',
      emptyNote: 'hidden xl:flex',
    }
  }
  return {
    listPane: `h-full w-full lg:w-[340px] lg:shrink-0 lg:border-r lg:border-zinc-200 ${hasChat ? 'hidden lg:flex' : 'flex'}`,
    chatPane: `h-full min-w-0 flex-1 ${hasChat ? 'flex' : 'hidden lg:flex'}`,
    back: 'lg:hidden',
    emptyNote: 'hidden lg:flex',
  }
}
