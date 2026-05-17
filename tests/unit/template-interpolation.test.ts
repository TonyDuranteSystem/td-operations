/**
 * Slice 8 Pass 6 — template-interpolation unit tests
 *
 * Covers the extracted neutral interpolators: interpolateString (lenient) +
 * interpolateStringStrict + resolvePath. Pure logic.
 */

import { describe, it, expect } from "vitest"
import {
  interpolateString,
  interpolateStringStrict,
  resolvePath,
} from "@/lib/template-interpolation"

describe("resolvePath", () => {
  it("resolves a top-level key", () => {
    expect(resolvePath({ name: "ACME" }, "name")).toBe("ACME")
  })

  it("resolves a dotted nested path", () => {
    expect(resolvePath({ response: { task_id: "abc" } }, "response.task_id")).toBe("abc")
  })

  it("returns undefined for missing top-level key", () => {
    expect(resolvePath({ a: 1 }, "b")).toBeUndefined()
  })

  it("returns undefined when an intermediate is not an object", () => {
    expect(resolvePath({ a: "string" }, "a.b")).toBeUndefined()
  })

  it("returns undefined when an intermediate is null", () => {
    expect(resolvePath({ a: null }, "a.b")).toBeUndefined()
  })
})

describe("interpolateString (lenient)", () => {
  it("replaces a single token", () => {
    expect(interpolateString("Hello {name}", { name: "Antonio" })).toBe("Hello Antonio")
  })

  it("replaces multiple tokens", () => {
    expect(interpolateString("{greet} {name}!", { greet: "Hi", name: "Luca" })).toBe("Hi Luca!")
  })

  it("LEAVES literal {token} for missing tokens (lenient)", () => {
    expect(interpolateString("Hello {missing}", {})).toBe("Hello {missing}")
  })

  it("LEAVES literal {token} when value is null (lenient)", () => {
    expect(interpolateString("Hello {x}", { x: null })).toBe("Hello {x}")
  })

  it("substitutes empty string for empty value (lenient passes through)", () => {
    expect(interpolateString("[{x}]", { x: "" })).toBe("[]")
  })

  it("coerces non-string values to string", () => {
    expect(interpolateString("year={y}", { y: 2025 })).toBe("year=2025")
    expect(interpolateString("on={b}", { b: true })).toBe("on=true")
  })

  it("supports nested dot paths", () => {
    expect(interpolateString("id={r.task_id}", { r: { task_id: "t1" } })).toBe("id=t1")
  })
})

describe("interpolateStringStrict", () => {
  it("returns interpolated string when all tokens present", () => {
    expect(interpolateStringStrict("Hello {name}", { name: "Antonio" })).toBe("Hello Antonio")
  })

  it("returns null when a token is missing", () => {
    expect(interpolateStringStrict("Hello {missing}", {})).toBeNull()
  })

  it("returns null when a token resolves to null", () => {
    expect(interpolateStringStrict("Hello {x}", { x: null })).toBeNull()
  })

  it("returns null when a token resolves to empty string", () => {
    expect(interpolateStringStrict("[{x}]", { x: "" })).toBeNull()
  })

  it("returns null when ANY of multiple tokens is missing", () => {
    expect(interpolateStringStrict("{a} {b}", { a: "ok" })).toBeNull()
  })

  it("returns interpolated string when ALL multiple tokens present", () => {
    expect(interpolateStringStrict("{a}-{b}", { a: "x", b: "y" })).toBe("x-y")
  })

  it("returns original string when there are no tokens to interpolate", () => {
    expect(interpolateStringStrict("static text", {})).toBe("static text")
  })
})
