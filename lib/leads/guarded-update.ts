/**
 * Guarded single-column lead edits (dev job f3f3e237 step 2 / d26b8a7e remainder).
 *
 * The lead edit routes used a plain `.update().eq("id")`: whoever saved last silently won.
 * Lead notes made it worst — the WHOLE text is overwritten, so two people editing the same
 * lead's notes lost one person's writing with no warning to either.
 *
 * WHY NOT THE ROW-LEVEL `updated_at` LOCK (updateWithLock): lead rows are touched by background
 * activity (offer views, status flows, webhooks). A row-level token would refuse real edits
 * because of an UNRELATED change. The question that matters is narrower: "has THE FIELD I am
 * editing changed since I opened it?" So the client sends the value it was editing FROM
 * (`expected`), and this module refuses only when that column's current value differs.
 *
 * Two layers:
 *  1. compare the column's current value with the caller's expected value (a real conflict);
 *  2. the write itself is conditional on the `updated_at` just read, so a change landing in the
 *     gap between the read and the write is also caught (a row-count check, never trusting
 *     "no error" to mean "written").
 * A caller that sends no expected value (older code) skips layer 1 but keeps layer 2.
 */

export const LEAD_CONFLICT_MESSAGE =
  "This lead changed since you opened it. Reload the page to see the latest, then try again."

/** null, undefined and "" all mean "empty" for the comparison. */
export function normalizeCell(v: unknown): string {
  return v === null || v === undefined ? "" : String(v)
}

export type GuardVerdict = "ok" | "conflict"

/**
 * Compare what the caller was editing FROM with what the column holds now.
 * `hasExpected` is false when the caller sent no expected value at all (older clients).
 */
export function guardVerdict(current: unknown, expected: unknown, hasExpected: boolean): GuardVerdict {
  if (!hasExpected) return "ok"
  return normalizeCell(current) === normalizeCell(expected) ? "ok" : "conflict"
}

/** True when the JSON body carries an expected value (even null / ""). */
export function hasExpectedValue(body: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(body, key)
}

export type GuardedResult =
  | { ok: true; previousValue: string }
  | { ok: false; reason: "not_found"; message: string }
  | { ok: false; reason: "conflict"; message: string; currentValue: string }
  | { ok: false; reason: "error"; message: string }

export type GuardedFailure = Exclude<GuardedResult, { ok: true; previousValue: string }>

/**
 * Explicit narrowing: this project's TypeScript settings are not strict, so `if (!result.ok)` does
 * NOT narrow the union (the compiler then rejects `result.reason`). A user-defined guard narrows
 * regardless of those settings.
 */
export function isGuardedFailure(r: GuardedResult): r is GuardedFailure {
  return r.ok === false
}

/** The slice of the database client this helper uses (the real admin client satisfies it). */
export interface LeadDb {
  from(table: "leads"): {
    select(columns: string): {
      eq(col: string, val: string): { maybeSingle(): PromiseLike<{ data: Record<string, unknown> | null; error: { message: string } | null }> }
    }
    update(values: Record<string, unknown>): {
      eq(col: string, val: string): {
        eq(col: string, val: string): {
          select(columns: string): PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>
        }
      }
    }
  }
}

export interface GuardedUpdateInput {
  leadId: string
  column: string
  newValue: unknown
  /** What the caller was editing FROM. Ignored when `hasExpected` is false. */
  expected?: unknown
  hasExpected: boolean
  /** Injectable clock for tests. */
  now?: () => string
}

export async function updateLeadColumnGuarded(db: LeadDb, input: GuardedUpdateInput): Promise<GuardedResult> {
  const { leadId, column, newValue, expected, hasExpected } = input
  const now = input.now ?? (() => new Date().toISOString())

  const read = await db.from("leads").select(`id, updated_at, ${column}`).eq("id", leadId).maybeSingle()
  if (read.error) return { ok: false, reason: "error", message: read.error.message }
  if (!read.data) return { ok: false, reason: "not_found", message: "Lead not found" }

  const current = read.data[column]
  if (guardVerdict(current, expected, hasExpected) === "conflict") {
    return { ok: false, reason: "conflict", message: LEAD_CONFLICT_MESSAGE, currentValue: normalizeCell(current) }
  }

  const written = await db
    .from("leads")
    .update({ [column]: newValue, updated_at: now() })
    .eq("id", leadId)
    .eq("updated_at", String(read.data.updated_at))
    .select("id")
  if (written.error) return { ok: false, reason: "error", message: written.error.message }
  if (!written.data || written.data.length === 0) {
    // Something wrote to this lead between our read and our write.
    return { ok: false, reason: "conflict", message: LEAD_CONFLICT_MESSAGE, currentValue: normalizeCell(current) }
  }
  return { ok: true, previousValue: normalizeCell(current) }
}
