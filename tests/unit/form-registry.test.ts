import { describe, expect, it } from "vitest"
import fs from "fs"
import path from "path"
import {
  FORM_REGISTRY,
  FORM_BY_TYPE,
  FORM_BY_TABLE,
  type FormDefinition,
} from "@/lib/forms/registry"

describe("FORM_REGISTRY", () => {
  it("has at least two entries", () => {
    expect(FORM_REGISTRY.length).toBeGreaterThanOrEqual(2)
  })

  it("every entry has required fields", () => {
    for (const def of FORM_REGISTRY) {
      expect(typeof def.form_type).toBe("string")
      expect(def.form_type.length).toBeGreaterThan(0)
      expect(typeof def.table).toBe("string")
      expect(def.table.length).toBeGreaterThan(0)
      expect(typeof def.publicPath).toBe("string")
      expect(def.publicPath.length).toBeGreaterThan(0)
    }
  })

  it("form_type values are unique", () => {
    const types = FORM_REGISTRY.map(f => f.form_type)
    expect(new Set(types).size).toBe(types.length)
  })

  it("table values are unique", () => {
    const tables = FORM_REGISTRY.map(f => f.table)
    expect(new Set(tables).size).toBe(tables.length)
  })

  it("publicPath values are unique", () => {
    const paths = FORM_REGISTRY.map(f => f.publicPath)
    expect(new Set(paths).size).toBe(paths.length)
  })

  it("each publicPath maps to an existing app directory", () => {
    const appRoot = path.resolve(process.cwd(), "app")
    for (const def of FORM_REGISTRY) {
      const dir = path.join(appRoot, def.publicPath)
      expect(fs.existsSync(dir), `app/${def.publicPath} does not exist for form_type '${def.form_type}'`).toBe(true)
    }
  })
})

describe("FORM_BY_TYPE", () => {
  it("looks up by form_type", () => {
    for (const def of FORM_REGISTRY) {
      expect(FORM_BY_TYPE[def.form_type]).toEqual(def)
    }
  })

  it("returns undefined for unknown type", () => {
    expect(FORM_BY_TYPE["nonexistent_form_type"]).toBeUndefined()
  })

  it("known entries: contact_request", () => {
    const def = FORM_BY_TYPE["contact_request"] as FormDefinition
    expect(def.table).toBe("contact_request_forms")
    expect(def.publicPath).toBe("contact-request")
  })

  it("known entries: member_info", () => {
    const def = FORM_BY_TYPE["member_info"] as FormDefinition
    expect(def.table).toBe("member_info_requests")
    expect(def.publicPath).toBe("member-info")
  })
})

describe("FORM_BY_TABLE", () => {
  it("looks up by table name", () => {
    for (const def of FORM_REGISTRY) {
      expect(FORM_BY_TABLE[def.table]).toEqual(def)
    }
  })

  it("returns undefined for unknown table", () => {
    expect(FORM_BY_TABLE["nonexistent_table"]).toBeUndefined()
  })
})
