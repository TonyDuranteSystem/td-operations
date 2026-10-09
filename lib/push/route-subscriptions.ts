/**
 * Which of a person's staff push subscriptions receive a given notification (dev job c1e326dd, TD Talk).
 *
 * Pure and unit-tested. A subscription belongs to one installed app: `app` null = the CRM app, 'talk' = TD Talk.
 *
 *  - TD Talk only ever receives DIRECT MESSAGES. A channel post, a topic, a mention in a channel, a staff note or a
 *    system alert never reaches it — it is a chat between two people, not the workspace.
 *  - A person who HAS a TD Talk subscription gets their direct messages there INSTEAD of in the CRM app — otherwise
 *    both apps would buzz for the same message.
 *  - Everyone else (and every other kind of notification) behaves exactly as before: all of a person's CRM-app
 *    subscriptions.
 *
 * Known edge: if TD Talk is deleted from a phone without turning notifications off, its subscription stays until the
 * push service reports it gone (the delivery code deletes dead subscriptions on the first failure); a direct message
 * sent in that window is not shown in the CRM app either. The unread count in the CRM still shows it.
 */

export const TALK_APP = 'talk'

export interface RoutableSubscription {
  user_id: string
  app?: string | null
}

export function routeAdminSubscriptions<T extends RoutableSubscription>(subs: T[], isDirectMessage: boolean): T[] {
  const talkUsers = new Set(subs.filter(s => s.app === TALK_APP).map(s => s.user_id))
  return subs.filter(s => {
    if (s.app === TALK_APP) return isDirectMessage
    return !(isDirectMessage && talkUsers.has(s.user_id))
  })
}

/** The only app names the subscribe route stores; anything else means "the CRM app" (null). */
export function normalizeApp(raw: unknown): string | null {
  return raw === TALK_APP ? TALK_APP : null
}
