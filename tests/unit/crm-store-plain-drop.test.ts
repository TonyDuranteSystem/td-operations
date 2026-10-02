import { describe, it, expect } from "vitest"
import { allFolderPaths, filterPlainDrop, folderCount, itemsFromFileList, isInternalOwnerKind, formatBytes, PLAIN_CONCURRENCY, type PlainItem } from "@/lib/crm-store/plain-drop"

const f = (name: string, size = 10) => ({ name, size }) as unknown as File
const item = (name: string, path: string[] = []): PlainItem => ({ file: f(name), path })

describe("which areas are a 'normal storage'", () => {
  it("only the firm's own areas — Business and a staff member's My files", () => {
    expect(isInternalOwnerKind("business")).toBe(true)
    expect(isInternalOwnerKind("private")).toBe(true)
    for (const k of ["company", "person", "formation", null, undefined, ""]) expect(isInternalOwnerKind(k as string | null)).toBe(false)
  })
})

describe("what a plain drop uploads and what it leaves out", () => {
  it("keeps ordinary files of any kind (no type list, no extension list)", () => {
    const { items, skipped } = filterPlainDrop([item("a.pdf"), item("deck.pptx"), item("notes.txt"), item("archive.zip"), item("photo.HEIC")])
    expect(items).toHaveLength(5); expect(skipped).toEqual([])
  })
  it("leaves out Google Docs shortcut files and says why", () => {
    const { items, skipped } = filterPlainDrop([item("Plan.gdoc", ["CRM Projects"]), item("Budget.GSHEET"), item("real.pdf")])
    expect(items.map((i) => i.file.name)).toEqual(["real.pdf"])
    expect(skipped).toHaveLength(2)
    expect(skipped[0].name).toBe("CRM Projects › Plan.gdoc"); expect(skipped[0].why).toMatch(/not the document itself/)
  })
  it("drops operating-system junk without a word", () => {
    const { items, skipped } = filterPlainDrop([item(".DS_Store"), item("Thumbs.db"), item("desktop.ini"), item("._real.pdf"), item("real.pdf")])
    expect(items.map((i) => i.file.name)).toEqual(["real.pdf"]); expect(skipped).toEqual([])
  })
  it("has no file-count limit", () => {
    const many = Array.from({ length: 5000 }, (_, i) => item(`f${i}.txt`, ["Big", `d${i % 50}`]))
    expect(filterPlainDrop(many).items).toHaveLength(5000)
  })
})

describe("folders and the summary", () => {
  it("counts every distinct folder level once", () => {
    expect(folderCount([item("a", ["Top", "A"]), item("b", ["Top", "A"]), item("c", ["Top", "B"]), item("d", [])])).toBe(3)   // Top, Top/A, Top/B
    expect(folderCount([item("a")])).toBe(0)
  })
  it("a folder picked with the browser's box keeps its top folder and sub-folders, never the file name", () => {
    const out = itemsFromFileList([{ file: f("x.pdf"), relative: "CRM Projects/Sub/x.pdf" }, { file: f("y.pdf"), relative: "CRM Projects/y.pdf" }, { file: f("z.pdf"), relative: "" }, { file: f("w.pdf") }])
    expect(out.map((o) => o.path)).toEqual([["CRM Projects", "Sub"], ["CRM Projects"], [], []])
  })
  it("sizes read in plain units; a few uploads run at once", () => {
    expect(formatBytes(512)).toBe("512 B"); expect(formatBytes(2048)).toBe("2 KB"); expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB"); expect(formatBytes(3 * 1024 ** 3)).toBe("3.00 GB")
    expect(PLAIN_CONCURRENCY).toBeGreaterThan(1)
  })
})

describe("folders survive when nothing in them can be uploaded", () => {
  it("keeps a folder whose only content is a Google Docs shortcut", () => {
    const r = filterPlainDrop([item("Doc.gdoc", ["CRM Projects", "SUITE NUMBER"]), item("a.pdf", ["CRM Projects", "STORAGE"])])
    expect(r.items).toHaveLength(1)
    expect(r.folders).toEqual([["CRM Projects"], ["CRM Projects", "SUITE NUMBER"], ["CRM Projects", "STORAGE"]])
  })
  it("allFolderPaths lists every level once, parents first, and adds empty folders", () => {
    expect(allFolderPaths([["A", "B"]], [["A", "C"], ["D"]])).toEqual([["A"], ["D"], ["A", "B"], ["A", "C"]])
  })
})
