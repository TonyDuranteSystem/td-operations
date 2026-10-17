/**
 * How much one Mac — and one PERSON, all their Macs together — may download per hour (dev job 1992a087, P1): a Finder "copy this whole
 * folder" is ONE gesture, and a stolen token would otherwise empty the storage. The counting and the audit row happen in ONE database
 * function, under a lock (storage_app_reserve_read, migration 20261017-1500), so parallel requests cannot all pass before any is counted.
 * Default 500 MB per hour for each limit, `STORAGE_APP_READ_LIMIT_MB` to change. Over the limit = 429 and ONE audit row per 10 minutes.
 */
export const DEFAULT_READ_LIMIT_MB = 500

/** PURE */
export function readLimitBytes(envValue: string | undefined = process.env.STORAGE_APP_READ_LIMIT_MB): number {
  const n = Number(envValue)
  return (Number.isFinite(n) && n > 0 ? n : DEFAULT_READ_LIMIT_MB) * 1024 * 1024
}

/** PURE: mirrors the database function — a file with no recorded size counts as 1 MB, never zero. */
export const MIN_READ_COST_BYTES = 1024 * 1024
export const readCost = (size: number | null | undefined): number => Math.max(typeof size === "number" && size > 0 ? size : 0, MIN_READ_COST_BYTES)

/** PURE: may this download go ahead? (A file bigger than the whole limit can never fit.) */
export function withinReadLimit(usedBytes: number, nextBytes: number, limitBytes: number): boolean {
  return usedBytes + nextBytes <= limitBytes
}
