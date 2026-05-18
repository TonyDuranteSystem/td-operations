/**
 * buildSnapshotForStorage — guards the "slug must live inside the stored
 * snapshot" invariant. The cf0cb867 bug shipped because two dispatcher sites
 * forgot to inject slug; the helper exists so that bug class becomes
 * structurally impossible. These tests guarantee the helper itself can't
 * regress.
 */

import { describe, it, expect } from "vitest"
import { buildSnapshotForStorage, parseWorkflowSnapshot } from "@/lib/tasks/workflow-snapshot-schema"

describe("buildSnapshotForStorage", () => {
  it("merges slug into metadata", () => {
    const out = buildSnapshotForStorage({
      slug: "my_wf",
      metadata: { version: 1, label_admin: "X" },
    })
    expect(out.slug).toBe("my_wf")
    expect(out.version).toBe(1)
    expect(out.label_admin).toBe("X")
  })

  it("slug from the row overrides any slug already in metadata", () => {
    // Defensive: if someone hand-wrote a slug into metadata and it disagrees
    // with the row's slug column, the row's slug wins (it's the canonical
    // identifier in the DB).
    const out = buildSnapshotForStorage({
      slug: "row_slug",
      metadata: { slug: "different_metadata_slug", version: 1 },
    })
    expect(out.slug).toBe("row_slug")
  })

  it("does not mutate the input metadata object", () => {
    const original = { version: 1 }
    buildSnapshotForStorage({ slug: "x", metadata: original })
    expect(original).toEqual({ version: 1 })
    expect("slug" in original).toBe(false)
  })

  it("handles null metadata gracefully", () => {
    const out = buildSnapshotForStorage({ slug: "lonely", metadata: null })
    expect(out).toEqual({ slug: "lonely" })
  })

  it("produces a snapshot that parseWorkflowSnapshot accepts", () => {
    // End-to-end: helper's output goes straight through the schema validator
    // that the dispatcher + TaskCard use.
    const out = buildSnapshotForStorage({
      slug: "valid_wf",
      metadata: {
        version: 1,
        label_admin: "Valid",
        permission: { role_in: ["admin"] },
        actions: [
          {
            slug: "primary",
            label_admin: "Do",
            permission: { role_in: ["admin"] },
            handler: "task.cancel",
            on_success_status: "Done",
          },
        ],
      },
    })
    expect(() => parseWorkflowSnapshot(out)).not.toThrow()
  })
})
