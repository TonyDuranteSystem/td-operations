import { describe, it, expect } from "vitest"
import { staleStagingPaths, sweepStoreStaging, type SweepBucket } from "@/lib/crm-store/staging-sweep"

const NOW = new Date("2026-10-25T12:00:00Z")
const P = "crm-uploads/store-staging/"
const ago = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString()

describe("staleStagingPaths", () => {
  it("keeps files younger than 24h and returns older ones", () => {
    expect(staleStagingPaths([
      { path: `${P}o1/a.pdf`, created_at: ago(25) },
      { path: `${P}o1/b.pdf`, created_at: ago(23) },
    ], NOW)).toEqual([`${P}o1/a.pdf`])
  })
  it("never touches other prefixes, traversal, folder markers or unreadable times", () => {
    expect(staleStagingPaths([
      { path: "fax-upload/x.pdf", created_at: ago(99) },
      { path: `${P}../x.pdf`, created_at: ago(99) },
      { path: `${P}o1/`, created_at: ago(99) },
      { path: `${P}o1/no-time.pdf`, created_at: null },
      { path: `${P}o1/bad.pdf`, created_at: "nonsense" },
    ], NOW)).toEqual([])
  })
})

function fakeBucket(tree: Record<string, Array<{ name: string; id: string | null; created_at?: string }>>) {
  const removed: string[][] = []
  const bucket: SweepBucket = {
    async list(path, o) { return { data: (tree[path] ?? []).slice(o.offset, o.offset + o.limit), error: null } },
    async remove(paths) { removed.push(paths); return { error: null } },
  }
  return { bucket, removed }
}

describe("sweepStoreStaging", () => {
  const tree = {
    "crm-uploads/store-staging": [{ name: "o1", id: null }, { name: "o2", id: null }],
    "crm-uploads/store-staging/o1": [{ name: "old.pdf", id: "1", created_at: ago(30) }, { name: "new.pdf", id: "2", created_at: ago(1) }],
    "crm-uploads/store-staging/o2": [{ name: "old2.pdf", id: "3", created_at: ago(48) }],
  }
  it("deletes only stale files across owner folders", async () => {
    const { bucket, removed } = fakeBucket(tree)
    const r = await sweepStoreStaging({ now: NOW, bucket })
    expect(r).toMatchObject({ listed: 3, stale: 2, deleted: 2, dryRun: false, error: null })
    expect(removed).toEqual([[`${P}o1/old.pdf`, `${P}o2/old2.pdf`]])
  })
  it("dry run deletes nothing", async () => {
    const { bucket, removed } = fakeBucket(tree)
    const r = await sweepStoreStaging({ now: NOW, bucket, dryRun: true })
    expect(r).toMatchObject({ stale: 2, deleted: 0, dryRun: true })
    expect(removed).toEqual([])
  })
  it("caps deletions per run", async () => {
    const { bucket, removed } = fakeBucket(tree)
    const r = await sweepStoreStaging({ now: NOW, bucket, maxDelete: 1 })
    expect(r).toMatchObject({ stale: 2, deleted: 1, capped: true })
    expect(removed[0]).toHaveLength(1)
  })
})
