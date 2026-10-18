/**
 * Shared test doubles for the "Stop Drive" route tests (dev job 264bb882, slice S1c).
 * A tiny Supabase chain double + a Google Drive SPY: every Drive function fails the test when called.
 */
import { vi } from "vitest"

export interface Recorded { table: string; op: "insert" | "update" | "upsert" | "delete"; payload: unknown }

export function makeSupabase(rows: Record<string, unknown>, recorded: Recorded[], storage?: { downloads?: Record<string, Uint8Array> }) {
  const from = (table: string) => {
    let op: Recorded["op"] | null = null
    let payload: unknown = null
    const result = () => {
      const v = rows[table]
      return v === undefined ? null : v
    }
    const chain: Record<string, unknown> = {}
    const ret = () => chain
    for (const m of ["select", "eq", "neq", "in", "is", "not", "or", "order", "limit", "gte", "lte", "ilike", "like", "range", "match", "filter", "contains"]) chain[m] = ret
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
  const bucket = () => ({
    download: vi.fn(async (path: string) => {
      const bytes = storage?.downloads?.[path] ?? new TextEncoder().encode("%PDF-1.4 test")
      return { data: { arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), type: "application/pdf" }, error: null }
    }),
    upload: vi.fn(async () => ({ error: null })),
    list: vi.fn(async () => ({ data: [{ name: "signed.pdf" }], error: null })),
    remove: vi.fn(async () => ({ error: null })),
    createSignedUrl: vi.fn(async () => ({ data: { signedUrl: "https://signed.example/url" } })),
  })
  return { from, storage: { from: bucket } }
}

/** Every export is a function that records the call and throws: nothing in these tests may reach Drive. */
export function driveSpy(driveCalls: string[]) {
  const spy = (name: string) => vi.fn(async () => { driveCalls.push(name); throw new Error(`Drive must not be called: ${name}`) })
  const names = ["listFolder", "listFolderAnyDrive", "createFolder", "uploadBinaryToDrive", "uploadBinaryToDriveUpsert", "downloadFileBinary", "findTaxFolder", "findOrCreateYearFolder", "driveParentIds", "trashFile", "moveFile"]
  return Object.fromEntries(names.map((n) => [n, spy(n)]))
}
