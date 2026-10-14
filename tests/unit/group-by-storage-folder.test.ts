import { describe, it, expect } from "vitest"
import { groupByStorageFolder } from "@/lib/documents/group-by-storage-folder"

const d = (file_name: string, category: number | null, tax_year: number | null = null) => ({ file_name, category, tax_year })

describe("groupByStorageFolder — the account's documents organised like the Storage", () => {
  it("orders the folders 1..5 and puts anything without a folder last as Other", () => {
    const g = groupByStorageFolder([d("b", 5), d("a", 1), d("x", null), d("t", 3, 2024), d("m", 4), d("p", 2)])
    expect(g.map((x) => x.title)).toEqual(["1. Company", "2. Contacts", "3. Tax", "4. Banking", "5. Correspondence", "Other"])
  })
  it("inside Tax there is a section per year, newest first; other folders are one list sorted by name", () => {
    const g = groupByStorageFolder([d("Return 2024", 3, 2024), d("Return 2025", 3, 2025), d("Ext 2025", 3, 2025), d("Zeta", 1), d("Alpha", 1)])
    const tax = g.find((x) => x.title === "3. Tax")!
    expect(tax.sections.map((s) => s.title)).toEqual(["2025", "2024"])
    expect(tax.sections[0].docs.map((x) => x.file_name)).toEqual(["Ext 2025", "Return 2025"])
    const company = g.find((x) => x.title === "1. Company")!
    expect(company.sections).toHaveLength(1)
    expect(company.sections[0].docs.map((x) => x.file_name)).toEqual(["Alpha", "Zeta"])
    expect(company.count).toBe(2)
  })
  it("a tax file with no year goes to 'No year'; an unknown category number is Other", () => {
    const g = groupByStorageFolder([d("t", 3, null), d("u", 9)])
    expect(g.find((x) => x.title === "3. Tax")!.sections[0].title).toBe("No year")
    expect(g.find((x) => x.title === "Other")!.count).toBe(1)
  })
  it("no documents → no folders", () => {
    expect(groupByStorageFolder([])).toEqual([])
  })
})
