/**
 * Which buttons the open email / WhatsApp chat shows INSIDE THE TD SOCIAL PHONE APP (dev job 2072bc3e, Step 1b,
 * fix-list item 4: "about 15 small buttons on three lines above the email").
 *
 * Antonio approved the short toolbar: Reply, read/unread, archive, delete; Task / Service / Invoice (and the rest)
 * under "…". This module only DECIDES the list (pure, unit-tested); components/inbox/app-thread-actions.tsx draws it
 * and components/inbox/inbox-shell.tsx supplies what each button does — the same handlers the computer layout uses,
 * so nothing here can change what a button does, only where it sits.
 */

export type AppPrimaryAction = 'reply' | 'archive' | 'toggleRead' | 'delete' | 'restore'
export type AppMoreAction = 'task' | 'service' | 'invoice' | 'worker' | 'share' | 'forward' | 'star' | 'link' | 'print' | 'copyLink'

export interface AppThreadPlan {
  /** Always visible, in this order. */
  primary: AppPrimaryAction[]
  /** Under the "…" button, in this order (empty = no "…" button). */
  more: AppMoreAction[]
}

export function appThreadPlan(input: {
  channel: string
  /** the open email came from Trash: Restore replaces Delete (Delete on a trashed email does nothing) */
  isTrash: boolean
  /** a WhatsApp chat that has its conversation id (the Worker and the link need it) */
  hasWhatsAppGroup: boolean
}): AppThreadPlan {
  if (input.channel === 'whatsapp') {
    return { primary: ['reply'], more: input.hasWhatsAppGroup ? ['worker', 'copyLink'] : [] }
  }
  if (input.channel === 'gmail') {
    return {
      primary: ['reply', 'archive', 'toggleRead', input.isTrash ? 'restore' : 'delete'],
      more: ['task', 'service', 'invoice', 'worker', 'share', 'forward', 'star', 'link', 'print'],
    }
  }
  // any other channel keeps what the computer layout shows it: Reply, the quick-create actions and the Worker
  return { primary: ['reply'], more: ['task', 'service', 'invoice', 'worker'] }
}
