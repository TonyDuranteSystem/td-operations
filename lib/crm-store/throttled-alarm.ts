/**
 * CRM Store — one staff alarm per identical problem per hour (Stop Drive, dev job 264bb882, slice S1d).
 *
 * A retrying job, a sweep and a staff re-run can all hit the same problem; staff must hear about it ONCE, not on every attempt.
 * The same identity (kind + the details) is alarmed once per window — per server instance in memory, and across instances through
 * the store's own event history. The alarm is remembered only after it really went out (a failed raise is tried again).
 */

export const ALARM_WINDOW_MS = 60 * 60 * 1000

export interface ThrottledAlarmDeps {
  alreadyAlarmed: (kind: string, details: Record<string, unknown>, sinceIso: string) => Promise<boolean>
  raise: (kind: string, details: Record<string, unknown>) => Promise<void>
}

const recent = new Map<string, number>()
export function forgetThrottledAlarms(): void { recent.clear() }

async function defaultDeps(): Promise<ThrottledAlarmDeps> {
  return {
    alreadyAlarmed: async (kind, details, sinceIso) => {
      const { supabaseAdmin } = await import("@/lib/supabase-admin")
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- store_events is not in the generated types
      const { data } = await (supabaseAdmin as any).from("store_events").select("id").eq("event", "pilot_alarm").eq("reason", kind).gte("occurred_at", sinceIso).contains("details", details).limit(1)
      return Array.isArray(data) && data.length > 0
    },
    raise: async (kind, details) => {
      const { raisePilotAlarm } = await import("./formation-pilot")
      await raisePilotAlarm(kind as never, details)
    },
  }
}

/** Raise the alarm unless the very same one went out in the last hour. Never throws. Returns true when it was raised now. */
export async function raiseThrottledAlarm(kind: string, details: Record<string, unknown>, now: number = Date.now(), deps?: ThrottledAlarmDeps): Promise<boolean> {
  const key = `${kind}|${JSON.stringify(details, Object.keys(details).sort())}`
  const last = recent.get(key)
  if (last !== undefined && now - last < ALARM_WINDOW_MS) return false
  const d = deps ?? (await defaultDeps())
  try {
    if (await d.alreadyAlarmed(kind, details, new Date(now - ALARM_WINDOW_MS).toISOString())) { recent.set(key, now); return false }
  } catch { /* cannot tell: alarm anyway */ }
  try {
    await d.raise(kind, details)
    recent.set(key, now)
    return true
  } catch { return false }
}
