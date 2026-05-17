/**
 * Pure-logic tests for the template interpolators added in Slice 7 to support
 * the api_call primitive's url_template + body_template substitution.
 */

import { describe, expect, it } from "vitest"
import {
  interpolateRecord,
  interpolateRecordStrict,
  interpolateString,
  interpolateStringStrict,
} from "@/lib/chat/handler-primitives"

describe("interpolateString", () => {
  it("substitutes simple tokens", () => {
    expect(interpolateString("/api/x/{account_id}", { account_id: "a-1" })).toBe("/api/x/a-1")
  })

  it("leaves missing tokens as placeholders (non-strict)", () => {
    expect(interpolateString("/api/x/{missing}", {})).toBe("/api/x/{missing}")
  })

  it("substitutes multiple tokens in one string", () => {
    expect(
      interpolateString("/a/{x}/b/{y}", { x: "1", y: "2" }),
    ).toBe("/a/1/b/2")
  })

  it("resolves dot-paths (for response interpolation)", () => {
    expect(
      interpolateString("/tasks/{response.task_id}", { response: { task_id: "t-42" } }),
    ).toBe("/tasks/t-42")
  })

  it("coerces numbers and booleans to string", () => {
    expect(interpolateString("v={n}", { n: 7 })).toBe("v=7")
    expect(interpolateString("v={b}", { b: true })).toBe("v=true")
  })

  it("treats null/undefined as missing (leaves placeholder)", () => {
    expect(interpolateString("/{x}", { x: null })).toBe("/{x}")
    expect(interpolateString("/{x}", { x: undefined })).toBe("/{x}")
  })
})

describe("interpolateStringStrict", () => {
  it("returns the interpolated string when all tokens are present", () => {
    expect(
      interpolateStringStrict("/a/{x}/b", { x: "1" }),
    ).toBe("/a/1/b")
  })

  it("returns null when any token is missing", () => {
    expect(interpolateStringStrict("/a/{x}", {})).toBeNull()
  })

  it("returns null when a token is null/undefined/empty string", () => {
    expect(interpolateStringStrict("/a/{x}", { x: null })).toBeNull()
    expect(interpolateStringStrict("/a/{x}", { x: undefined })).toBeNull()
    expect(interpolateStringStrict("/a/{x}", { x: "" })).toBeNull()
  })

  it("returns the original string when there are no tokens", () => {
    expect(interpolateStringStrict("/api/static", {})).toBe("/api/static")
  })
})

describe("interpolateRecord", () => {
  it("interpolates string leaves; passes non-string leaves through unchanged", () => {
    const out = interpolateRecord(
      {
        url: "/api/{x}",
        count: 5,
        flag: true,
        list: [1, 2],
        nested: { keep: "as-is {y}" },
      },
      { x: "v", y: "Y" },
    )
    expect(out).toEqual({
      url: "/api/v",
      count: 5,
      flag: true,
      list: [1, 2],
      nested: { keep: "as-is {y}" }, // nested objects pass through unchanged (one-level interpolation)
    })
  })
})

describe("interpolateRecordStrict", () => {
  it("returns null if ANY string leaf has a missing token", () => {
    expect(
      interpolateRecordStrict(
        { a: "/api/{x}", b: "ok" },
        { x: "1" },
      ),
    ).toEqual({ a: "/api/1", b: "ok" })

    expect(
      interpolateRecordStrict(
        { a: "/api/{x}", b: "needs {missing}" },
        { x: "1" },
      ),
    ).toBeNull()
  })

  it("returns the full record when all tokens are present", () => {
    const out = interpolateRecordStrict(
      {
        topic_name: "Banking",
        account_id: "{account_id}",
        contact_id: "{contact_id}",
        starter_message_en: "Hi",
      },
      { account_id: "a-1", contact_id: "c-1" },
    )
    expect(out).toEqual({
      topic_name: "Banking",
      account_id: "a-1",
      contact_id: "c-1",
      starter_message_en: "Hi",
    })
  })
})
