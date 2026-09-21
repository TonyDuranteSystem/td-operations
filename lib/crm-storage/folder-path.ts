/**
 * Builds a map of folder id -> its full display path ("Parent / Child"),
 * for surfaces (search, favorites) that show a hit alongside where it
 * lives without requiring the caller to already be in that folder.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function buildFolderPathMap(db: any): Promise<Map<string, string>> {
  const { data: folders } = await db.from("crm_storage_folders").select("id, parent_id, name").is("deleted_at", null)
  const byId = new Map<string, { parent_id: string | null; name: string }>()
  for (const row of folders ?? []) byId.set(row.id, { parent_id: row.parent_id, name: row.name })

  const pathCache = new Map<string, string>()
  function pathFor(id: string): string {
    if (pathCache.has(id)) return pathCache.get(id)!
    const node = byId.get(id)
    if (!node) return ""
    const parentPath = node.parent_id ? pathFor(node.parent_id) : ""
    const full = parentPath ? `${parentPath} / ${node.name}` : node.name
    pathCache.set(id, full)
    return full
  }
  for (const id of Array.from(byId.keys())) pathFor(id)
  return pathCache
}
