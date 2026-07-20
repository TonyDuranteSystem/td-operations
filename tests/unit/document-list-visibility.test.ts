/**
 * lib/documents/list-visibility.ts — decides which documents the CRM account
 * Documents tab shows in its FLAT list (above the Drive folder tree).
 *
 * Fixes Luca's 2026-07-20 report: every Drive-backed document rendered twice,
 * once flat and once in its folder. The flat list must carry only documents
 * with nowhere else to appear — WITHOUT hiding anything from both views, which
 * is the failure mode a council reviewer flagged for a naive sentinel-only
 * filter (an account with no Drive folder renders an empty folder tree).
 */

import { describe, it, expect } from "vitest"
import {
  needsFlatListing,
  filterDocumentsNeedingFlatListing,
} from "@/lib/documents/list-visibility"

const HAS_FOLDER = true
const NO_FOLDER = false

describe("needsFlatListing — account HAS a Drive folder", () => {
  it("drops a real Drive-backed document (the duplication Luca reported)", () => {
    expect(needsFlatListing({ drive_file_id: "1AbCdEfGhIjKlMnOpQrStUvWxYz012345" }, HAS_FOLDER)).toBe(false)
  })

  it("keeps a Supabase Storage fallback document", () => {
    expect(needsFlatListing({ drive_file_id: "storage:flow-uploads/sd/articles.pdf" }, HAS_FOLDER)).toBe(true)
    expect(needsFlatListing({ drive_file_id: "storage:fax-attachments/uuid-doc.pdf" }, HAS_FOLDER)).toBe(true)
  })

  it("keeps a live-rendered SS-4 sentinel", () => {
    expect(needsFlatListing({ drive_file_id: "ss4-live:abc123" }, HAS_FOLDER)).toBe(true)
  })

  it("keeps ANY future prefixed sentinel without needing a code change", () => {
    expect(needsFlatListing({ drive_file_id: "somethingnew:xyz" }, HAS_FOLDER)).toBe(true)
  })

  it("keeps a document with a missing or blank pointer", () => {
    expect(needsFlatListing({ drive_file_id: null }, HAS_FOLDER)).toBe(true)
    expect(needsFlatListing({ drive_file_id: undefined }, HAS_FOLDER)).toBe(true)
    expect(needsFlatListing({}, HAS_FOLDER)).toBe(true)
    expect(needsFlatListing({ drive_file_id: "" }, HAS_FOLDER)).toBe(true)
    expect(needsFlatListing({ drive_file_id: "   " }, HAS_FOLDER)).toBe(true)
  })
})

describe("needsFlatListing — account has NO Drive folder", () => {
  it("keeps EVERYTHING, including Drive-backed rows", () => {
    // FileManager renders only its "No Google Drive folder" empty state here,
    // so dropping these would make them invisible in BOTH views.
    expect(needsFlatListing({ drive_file_id: "1AbCdEfGhIjKlMnOpQrStUvWxYz012345" }, NO_FOLDER)).toBe(true)
    expect(needsFlatListing({ drive_file_id: "storage:flow-uploads/sd/a.pdf" }, NO_FOLDER)).toBe(true)
    expect(needsFlatListing({ drive_file_id: null }, NO_FOLDER)).toBe(true)
  })
})

describe("filterDocumentsNeedingFlatListing", () => {
  const docs = [
    { id: "drive-1", drive_file_id: "1AbCdEfGhIjKlMnOpQrStUvWxYz012345" },
    { id: "storage-1", drive_file_id: "storage:flow-uploads/sd/articles.pdf" },
    { id: "drive-2", drive_file_id: "1ZyXwVuTsRqPoNmLkJiHgFeDcBa543210" },
    { id: "ss4-live-1", drive_file_id: "ss4-live:tok" },
    { id: "orphan-1", drive_file_id: null },
  ]

  it("keeps only the homeless documents when the account has a Drive folder", () => {
    const result = filterDocumentsNeedingFlatListing(docs, HAS_FOLDER)
    expect(result.map(d => d.id)).toEqual(["storage-1", "ss4-live-1", "orphan-1"])
  })

  it("preserves the caller's ordering", () => {
    const reversed = [...docs].reverse()
    const result = filterDocumentsNeedingFlatListing(reversed, HAS_FOLDER)
    expect(result.map(d => d.id)).toEqual(["orphan-1", "ss4-live-1", "storage-1"])
  })

  it("keeps everything when the account has no Drive folder", () => {
    const result = filterDocumentsNeedingFlatListing(docs, NO_FOLDER)
    expect(result).toHaveLength(docs.length)
  })

  it("returns an empty array for null/undefined/empty input", () => {
    expect(filterDocumentsNeedingFlatListing(null, HAS_FOLDER)).toEqual([])
    expect(filterDocumentsNeedingFlatListing(undefined, HAS_FOLDER)).toEqual([])
    expect(filterDocumentsNeedingFlatListing([], HAS_FOLDER)).toEqual([])
  })

  it("does not mutate the input array", () => {
    const input = [...docs]
    filterDocumentsNeedingFlatListing(input, HAS_FOLDER)
    expect(input).toHaveLength(docs.length)
  })

  it("hides the whole list only when every document is Drive-backed", () => {
    const allDrive = [
      { id: "a", drive_file_id: "1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
      { id: "b", drive_file_id: "1BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB" },
    ]
    expect(filterDocumentsNeedingFlatListing(allDrive, HAS_FOLDER)).toEqual([])
  })
})
