/**
 * CRM Store — history rows that must not be lost silently (storage hunt, data-layer fixes).
 *
 * The Drive backup's "changed" detection and the "owner_late" alarm read store_events. An action that changed a file or
 * folder but lost its history row (a single failed insert that was only console.error'd) leaves the backup blind to it.
 * `logStoreEvent` retries the insert once; if it still fails it raises a pilot alarm (store history + system error log)
 * instead of only printing. `rollBackOrAlarm` is the same idea for compensating writes (supabase-js returns {error},
 * it does not throw): a failed put-back must be seen and reported, not swallowed.
 * Never throws.
 */

export interface StoreEventRow {
  event: string
  actor?: string | null
  owner_id?: string | null
  file_id?: string | null
  folder_id?: string | null
  name_snapshot?: string | null
  details?: Record<string, unknown>
  reason?: string | null
}

export type EventAlarmKind = "store_event_not_logged" | "store_putback_failed"

export interface EventLogDeps {
  insert: (row: StoreEventRow) => Promise<{ error: { message: string } | null }>
  alarm: (kind: EventAlarmKind, details: Record<string, unknown>) => Promise<void>
}

async function defaultDeps(): Promise<EventLogDeps> {
  const { supabaseAdmin } = await import("@/lib/supabase-admin")
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- store_events is not in the generated types
    insert: async (row) => (await (supabaseAdmin as any).from("store_events").insert(row)) as { error: { message: string } | null },
    alarm: async (kind, details) => {
      const { raisePilotAlarm } = await import("./formation-pilot")
      await raisePilotAlarm(kind, details)
    },
  }
}

/** Insert one history row; retry once; on final failure raise the alarm. Returns true when the row was written. */
export async function logStoreEvent(row: StoreEventRow, deps?: EventLogDeps): Promise<boolean> {
  const d = deps ?? (await defaultDeps())
  let last = ""
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { error } = await d.insert(row)
      if (!error) return true
      last = error.message
    } catch (e) { last = e instanceof Error ? e.message : String(e) }
  }
  console.error(`[crm-store] ${row.event} NOT logged (file ${row.file_id ?? "-"}, folder ${row.folder_id ?? "-"}): ${last}`)
  try {
    await d.alarm("store_event_not_logged", {
      ownerId: row.owner_id ?? null, event: row.event, fileId: row.file_id ?? null, folderId: row.folder_id ?? null, error: last,
    })
  } catch { /* an alarm never throws */ }
  return false
}

/**
 * Run a compensating step and CHECK it. supabase-js resolves with {error}; a thrown error is also caught.
 * Returns true when the put-back worked. Otherwise raises an alarm and returns false — the caller must then tell the
 * user plainly that the file may be in an unexpected place instead of saying "not moved".
 */
export async function rollBackOrAlarm(
  what: string,
  details: Record<string, unknown>,
  step: () => PromiseLike<{ error: { message: string } | null } | null | undefined>,
  deps?: Pick<EventLogDeps, "alarm">,
): Promise<boolean> {
  let msg = ""
  try {
    const r = await step()
    if (!r?.error) return true
    msg = r.error.message
  } catch (e) { msg = e instanceof Error ? e.message : String(e) }
  console.error(`[crm-store] put-back failed (${what}): ${msg}`)
  try {
    const alarm = deps?.alarm ?? (await defaultDeps()).alarm
    await alarm("store_putback_failed", { ...details, what, error: msg })
  } catch { /* never throw from an alarm */ }
  return false
}

/** The plain-English sentence shown when a put-back failed. */
export function unexpectedPlaceMessage(reason: string): string {
  return `${reason} The undo did not work either, so the file may now be in an unexpected place — staff have been alerted. Please check the file before trying again.`
}
