/**
 * Client iPhone app — the doorway the two client alert senders call (dev job 056a70d0, Step 4).
 *
 * `startClientPhoneLeg` is the FIRST line of the client phone leg: if the Apple key is not set it returns at once and loads nothing, reads nothing, so until the
 * key is there (it is on the sandbox; production decides separately) and the client app is switched on, production behaves exactly as before. Only then is the
 * heavy sender loaded. It NEVER throws and never rejects: a failed phone alert must not fail the message that caused it, and the web alert is sent regardless
 * (the phone is "in addition to", never "instead of"). Same shape as TD Social's `startPhoneLeg` (lib/app/phone-leg.ts), which is not touched.
 */
import { apnsConfigured } from '@/lib/app/apns-key'

/** One client alert, as the web senders describe it to the phone leg. Nothing here is trusted as an address or a header. */
export interface ClientPhoneAlert {
  /** `contact`: this one person's phones. `account`: the phones of everyone who may see that company's alerts. */
  scope: 'contact' | 'account'
  id: string
  /** the notification type word the caller used (mapped to a closed list of kinds; anything else is generic) */
  kind: unknown
  /** a same-site relative path the app opens when the alert is tapped (checked again before it is sent) */
  url?: string
  tag?: string
}

export function startClientPhoneLeg(alert: ClientPhoneAlert): Promise<void> {
  if (!apnsConfigured()) return Promise.resolve()
  if (!alert.id) return Promise.resolve()
  return import('@/lib/portal-app/send-to-client-phones')
    .then(m => m.sendToClientPhonesLive(alert))
    .then(
      () => undefined,
      (e: unknown) => { console.error('[client-app] phone leg failed:', e instanceof Error ? e.name : 'unknown') },
    )
}
