/**
 * THE Drive write switch (Stop Drive S2, dev job 264bb882; master plan Part 41/42).
 *
 * Google Drive is now (a) the ONE-WAY BACKUP of the CRM storage and (b) a read-only archive. Nothing else may write to it —
 * not a staff click, not a client upload, not a background job, not an MCP tool, not an AI assistant, not a script.
 *
 * The rule lives at the lowest level of the Drive client (lib/google-drive.ts): every write verb (create folder, upload, update,
 * move, rename, trash, copy, permission) calls `assertDriveWriteScope` first, and the raw network call itself is wrapped by
 * `driveWriteFetch` as a second line — so a write added tomorrow without a guard is refused too. The ONLY way through is
 * `runAsStoreBackup`: an explicit, scoped context (AsyncLocalStorage — not a global flag, so one request being the backup can never
 * open the door for another request running at the same time).
 *
 * This module has NO dependencies (no database, no Drive) so it can be imported anywhere and unit-tested in isolation.
 */

import { AsyncLocalStorage } from "node:async_hooks"

const backupScope = new AsyncLocalStorage<boolean>()

/** The ONE exception: the one-way backup (storage → Drive) runs its Drive calls inside this scope. */
export function runAsStoreBackup<T>(fn: () => Promise<T>): Promise<T> {
  return backupScope.run(true, fn)
}

/** True only for code running inside `runAsStoreBackup`. */
export function inStoreBackupScope(): boolean {
  return backupScope.getStore() === true
}

/** The plain sentence a refused write carries (the answer of the action that asked — never a notice or label). */
export const DRIVE_WRITES_STOPPED_SENTENCE =
  "Google Drive is now a read-only archive and the automatic backup — nothing can be saved to it. Files are saved in the CRM storage."

export class DriveWritesStoppedError extends Error {
  readonly verb: string
  constructor(verb: string) {
    super(DRIVE_WRITES_STOPPED_SENTENCE)
    this.name = "DriveWritesStoppedError"
    this.verb = verb
  }
}

/** Optional reporter: told ONCE per cause (verb) per hour when a write is refused. Set by the app at first refusal; tests inject their own. */
type Reporter = (verb: string) => void
let reporter: Reporter | null = null
export function setDriveRefusalReporter(r: Reporter | null): void { reporter = r }

const REPORT_WINDOW_MS = 60 * 60 * 1000
const reported = new Map<string, number>()
export function forgetReportedRefusals(): void { reported.clear() }

async function defaultReport(verb: string): Promise<void> {
  const { raiseThrottledAlarm } = await import("./crm-store/throttled-alarm")
  await raiseThrottledAlarm("drive_write_refused", { flow: "drive-write-switch", verb })
}

function reportOnce(verb: string, now: number = Date.now()): void {
  const last = reported.get(verb)
  if (last !== undefined && now - last < REPORT_WINDOW_MS) return
  reported.set(verb, now)
  try {
    if (reporter) { reporter(verb); return }
    void defaultReport(verb).catch(() => undefined) // an alarm never breaks (or delays) the caller
  } catch { /* never throws */ }
}

/** Throws unless the current call runs inside the one-way backup. `verb` names the Drive operation (for the alarm and the error). */
export function assertDriveWriteScope(verb: string): void {
  if (inStoreBackupScope()) return
  reportOnce(verb)
  throw new DriveWritesStoppedError(verb)
}

/** True for HTTP methods that change something. */
export function isWriteMethod(method: string | undefined | null): boolean {
  const m = String(method ?? "GET").toUpperCase()
  return m !== "GET" && m !== "HEAD"
}

/**
 * The raw network door for Drive: a drop-in for `fetch` that refuses any non-read call outside the backup scope. `fetchImpl` is
 * injectable for tests. (Token exchanges use the plain `fetch` on purpose — they are not Drive operations.)
 */
export async function driveWriteFetch(
  url: string | URL,
  init: RequestInit | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  if (isWriteMethod(init?.method)) assertDriveWriteScope(`raw ${String(init?.method ?? "").toUpperCase()} call`)
  return fetchImpl(url as string, init)
}
