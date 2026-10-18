/**
 * Shared test doubles for the "Stop Drive" route tests (dev job 264bb882, slice S1c).
 * A tiny Supabase chain double + a Google Drive SPY: every Drive function fails the test when called.
 */
import { vi } from "vitest"

export interface Recorded { table: string; op: "insert" | "update" | "upsert" | "delete"; payload: unknown }

export function makeSupabase(rows: Record<string, unknown>, recorded: Recorded[], storage?: { downloads?: Record<string, Uint8Array>; removed?: string[] }) {
  const from = (table: string) => {
    let op: Recorded["op"] | null = null
    let payload: unknown = null
    const result = () => {
      const v = rows[table]
      return v === undefined ? null : v
    }
    const chain: Record<string, unknown> = {}
    const ret = () => chain
    for (const m of ["select", "eq", "neq", "in", "is", "not", "or", "order", "limit", "gt", "gte", "lt", "lte", "ilike", "like", "range", "match", "filter", "contains"]) chain[m] = ret
    for (const m of ["insert", "update", "upsert", "delete"] as const) chain[m] = (p?: unknown) => { op = m; payload = p; recorded.push({ table, op: m, payload: p }); return chain }
    const one = () => Promise.resolve({ data: Array.isArray(result()) ? (result() as unknown[])[0] ?? null : result(), error: null })
    chain.single = one
    chain.maybeSingle = one
    chain.then = (resolve: (v: unknown) => unknown) => {
      void op; void payload
      const r = result()
      return Promise.resolve({ data: r === null ? [] : Array.isArray(r) ? r : [r], error: null }).then(resolve)
    }
    return chain
  }
  const bucket = (name?: string) => ({
    download: vi.fn(async (path: string) => {
      const bytes = storage?.downloads?.[path] ?? new TextEncoder().encode("%PDF-1.4 test")
      return { data: { arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), type: "application/pdf" }, error: null }
    }),
    upload: vi.fn(async () => ({ error: null })),
    list: vi.fn(async () => ({ data: [{ name: "signed.pdf" }], error: null })),
    remove: vi.fn(async (paths?: string[]) => { for (const x of paths ?? []) storage?.removed?.push(`${name ?? "?"}/${x}`); return { error: null } }),
    createSignedUrl: vi.fn(async () => ({ data: { signedUrl: "https://signed.example/url" } })),
  })
  return { from, storage: { from: bucket } }
}

/**
 * Google Drive double. "forbid" (default): every function records the call and throws — nothing in the test may reach Drive.
 * "record": the calls are recorded and answer plausibly, for a company that is deliberately left on its old folder.
 */
export function driveSpy(driveCalls: string[], mode: "forbid" | "record" = "forbid") {
  const answer = (name: string) => {
    if (name.startsWith("upload")) return { id: "drive-file-1", name: "f.pdf" }
    if (name === "createFolder") return { id: "drive-folder-new" }
    if (name === "downloadFileBinary") return { buffer: Buffer.from("x") }
    return { files: [] }
  }
  const spy = (name: string) => vi.fn(async () => {
    driveCalls.push(name)
    if (mode === "forbid") throw new Error(`Drive must not be called: ${name}`)
    return answer(name)
  })
  const names = ["listFolder", "listFolderAnyDrive", "createFolder", "uploadBinaryToDrive", "uploadBinaryToDriveUpsert", "downloadFileBinary", "findTaxFolder", "findOrCreateYearFolder", "driveParentIds", "trashFile", "moveFile", "ensureDrivePath"]
  return Object.fromEntries(names.map((n) => [n, spy(n)]))
}

/** The accounts row a test gives the company: how the "no storage" decision is made. */
export const ACCOUNT_REFUSED = { status: "Active", drive_folder_id: null, gdrive_folder_url: null }
export const ACCOUNT_CLOSED_WITH_FOLDER = { status: "Closed", drive_folder_id: "OLDFOLDER", gdrive_folder_url: null }
export const ACCOUNT_OLD_FOLDER = { status: "Active", drive_folder_id: "OLDFOLDER", gdrive_folder_url: null }

/** Same as driveSpy, but the mode is read at call time (a test can switch it). */
export function driveSpyDynamic(driveCalls: string[], getMode: () => "forbid" | "record") {
  const forbid = driveSpy(driveCalls, "forbid")
  const record = driveSpy(driveCalls, "record")
  return Object.fromEntries(Object.keys(forbid).map((k) => [k, (...a: unknown[]) => (getMode() === "forbid" ? forbid : record)[k](...(a as []))]))
}
