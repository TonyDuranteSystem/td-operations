/**
 * TD Social — the doorway the two existing alert senders call (dev job 2072bc3e, Step 2 pull request C2; Council-reviewed plan of 5 Nov 2026).
 *
 * `startPhoneLeg` is the FIRST line of the phone leg: if the Apple key is not set it returns at once and loads nothing, reads nothing, so until Antonio sets
 * the key production behaves exactly as before. Only then is the heavy sender loaded. It NEVER throws and never rejects: a failed phone alert must not fail the
 * message that caused it, and the web alert (computers, old home-screen apps) is sent regardless (the phone is "in addition to", never "instead of").
 */
import { apnsConfigured } from "@/lib/app/apns-key"

/** One alert, as the two senders describe it to the phone leg. Nothing here is trusted as an address or a header. */
export interface PhoneAlert {
  source: "staff" | "marketing"
  /** the Marketing team of the alert (required for source "marketing") */
  teamId?: string
  userIds: string[]
  /** the alert kind as the sender said it (validated by the wording rule) */
  kind: unknown
  title: string
  body: string
  url?: string
  tag?: string
  /** the one name a lock screen may show (cleaned by the wording rule) */
  name?: string | null
  /** true for a direct or group chat message */
  dm: boolean
}

export function startPhoneLeg(alert: PhoneAlert): Promise<void> {
  if (!apnsConfigured()) return Promise.resolve()
  return import("@/lib/app/send-to-phones")
    .then(m => m.sendToPhonesLive(alert))
    .then(
      () => undefined,
      (e: unknown) => { console.error("[social-app] phone leg failed:", e instanceof Error ? e.name : "unknown") },
    )
}
