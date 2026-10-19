/**
 * Shared test doubles for the Stop Drive S1d writer tests (dev job 264bb882): a tiny Supabase chain double and a Google Drive
 * SPY. `driveSpy` records every Drive call; with `allowListing` the read helpers answer, every WRITE helper records and throws.
 */
import { vi } from "vitest"

export interface Recorded { table: string; op: "insert" | "update" | "upsert" | "delete"; payload: unknown }

export function makeSupabase(rows: Record<string, unknown>, recorded: Recorded[], insertResults: Record<string, unknown> = {}) {
  const from = (table: string) => {
    let inserted = false
    const result = () => (inserted && insertResults[table] !== undefined ? insertResults[table] : rows[table] === undefined ? null : rows[table])
    const chain: Record<string, unknown> = {}
    const ret = () => chain
    for (const m of ["select", "eq", "neq", "in", "is", "not", "or", "order", "limit", "gte", "lte", "ilike", "like", "range", "match", "filter", "contains"]) chain[m] = ret
    for (const m of ["insert", "update", "upsert", "delete"] as const) chain[m] = (p?: unknown) => { if (m === "insert") inserted = true; recorded.push({ table, op: m, payload: p }); return chain }
    const one = () => Promise.resolve({ data: Array.isArray(result()) ? (result() as unknown[])[0] ?? null : result(), error: null })
    chain.single = one
    chain.maybeSingle = one
    chain.then = (resolve: (v: unknown) => unknown) => {
      const r = result()
      return Promise.resolve({ data: r === null ? [] : Array.isArray(r) ? r : [r], error: null }).then(resolve)
    }
    return chain
  }
  const bucket = () => ({
    download: vi.fn(async () => ({ data: { arrayBuffer: async () => new TextEncoder().encode("%PDF-1.4 test").buffer, type: "application/pdf" }, error: null })),
    list: vi.fn(async () => ({ data: [{ name: "signed.pdf" }], error: null })),
    upload: vi.fn(async () => ({ error: null })),
    createSignedUrl: vi.fn(async () => ({ data: { signedUrl: "https://signed.example/u" } })),
  })
  return { from, storage: { from: bucket } }
}

const WRITES = ["createFolder", "uploadBinaryToDrive", "uploadBinaryToDriveUpsert", "trashFile", "moveFile", "renameFile", "ensureDrivePath", "updateBinaryFile", "uploadFile"]
const READS = ["listFolder", "listFolderAnyDrive", "folderFileNameMap", "fileExistsInFolder", "downloadFileBinary", "driveParentIds"]

/** Writes always throw (and are recorded in `writes`); reads answer with an empty folder and are recorded in `reads`. */
export function driveSpy(writes: string[], reads: string[], opts: { writesSucceed?: boolean } = {}) {
  const out: Record<string, unknown> = {}
  for (const n of WRITES) out[n] = vi.fn(async (...a: unknown[]) => {
    writes.push(`${n}(${a.filter((x) => typeof x === "string").join(",")})`)
    if (!opts.writesSucceed) throw new Error(`Drive must not be written: ${n}`)
    return { id: `drive-${n}` }
  })
  for (const n of READS) out[n] = vi.fn(async () => { reads.push(n); return n === "listFolder" || n === "listFolderAnyDrive" ? { files: [] } : null })
  return out
}
