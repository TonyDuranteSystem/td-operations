import { describe, it, expect } from "vitest"
import { buildFolderPathMap } from "@/lib/crm-storage/folder-path"

function stubDb(rows: { id: string; parent_id: string | null; name: string }[]) {
  return {
    from: () => ({
      select: () => ({
        is: () => Promise.resolve({ data: rows }),
      }),
    }),
  }
}

describe("buildFolderPathMap", () => {
  it("returns an empty map when there are no folders", async () => {
    const map = await buildFolderPathMap(stubDb([]))
    expect(map.size).toBe(0)
  })

  it("maps a root folder to just its own name", async () => {
    const map = await buildFolderPathMap(stubDb([{ id: "a", parent_id: null, name: "Clients" }]))
    expect(map.get("a")).toBe("Clients")
  })

  it("joins a nested folder's path with its ancestors, root first", async () => {
    const map = await buildFolderPathMap(
      stubDb([
        { id: "a", parent_id: null, name: "Clients" },
        { id: "b", parent_id: "a", name: "Wyoming" },
        { id: "c", parent_id: "b", name: "Acme LLC" },
      ])
    )
    expect(map.get("c")).toBe("Clients / Wyoming / Acme LLC")
  })

  it("handles multiple independent root folders", async () => {
    const map = await buildFolderPathMap(
      stubDb([
        { id: "a", parent_id: null, name: "Clients" },
        { id: "b", parent_id: null, name: "Internal" },
      ])
    )
    expect(map.get("a")).toBe("Clients")
    expect(map.get("b")).toBe("Internal")
  })
})
