/**
 * lib/storage/upload-guard.ts — pins the generic signed-upload endpoint to the
 * one bucket and the five path prefixes its real dashboard callers use.
 *
 * Guards the escalation found in the 2026-07-20 council review: the route
 * previously minted a SERVICE-ROLE upload URL for any `{bucket, path}` a caller
 * supplied, and middleware runs no role check on /api paths — so a logged-in
 * client portal user could obtain write access to any bucket at any path.
 */

import { describe, it, expect } from "vitest"
import {
  validateStorageUploadTarget,
  ALLOWED_UPLOAD_PREFIXES,
  MAX_UPLOAD_PATH_LENGTH,
} from "@/lib/storage/upload-guard"

const BUCKET = "onboarding-uploads"

describe("validateStorageUploadTarget — the five real callers still work", () => {
  const realCallerPaths: Array<[string, string]> = [
    ["flows/document-upload", "flow-uploads/2f1c8b90-0000-4000-8000-000000000001/1784000000000_articles.pdf"],
    ["accounts/file-manager", "crm-account-uploads/30c2cd96-03e4-43cf-9536-81d961b18b1d/1784000000000_statement.pdf"],
    ["accounts/account-detail (DBA)", "crm-dba-uploads/30c2cd96-0000-4000-8000-000000000002/abc/1784000000000_dba.pdf"],
    ["contacts/contact-detail", "crm-uploads/9a7b6c5d-0000-4000-8000-000000000003/1784000000000_passport.png"],
    ["contacts/chain-audit-dialog", "articles/9a7b6c5d-0000-4000-8000-000000000004/1784000000000.pdf"],
  ]

  it.each(realCallerPaths)("accepts the %s path", (_label, path) => {
    const result = validateStorageUploadTarget({ bucket: BUCKET, path })
    expect(result).toEqual({ error: null, status: null, bucket: BUCKET, path })
  })

  it("covers every declared prefix with a caller case (list and tests stay in sync)", () => {
    const covered = new Set(
      realCallerPaths.map(([, path]) =>
        ALLOWED_UPLOAD_PREFIXES.find(p => path.startsWith(p)),
      ),
    )
    expect(covered.size).toBe(ALLOWED_UPLOAD_PREFIXES.length)
    expect(covered.has(undefined)).toBe(false)
  })
})

describe("validateStorageUploadTarget — bucket allow-list", () => {
  it.each([
    "worker-attachments",
    "signed-contracts",
    "signed-leases",
    "assets",
    "td-operations",
  ])("refuses bucket %s", bucket => {
    const result = validateStorageUploadTarget({
      bucket,
      path: "flow-uploads/sd/file.pdf",
    })
    expect(result.error).toBeTruthy()
    expect(result.status).toBe(400)
  })

  it("refuses a bucket that only looks like the allowed one", () => {
    expect(validateStorageUploadTarget({ bucket: "onboarding-uploads-evil", path: "flow-uploads/a/b.pdf" }).error).toBeTruthy()
    expect(validateStorageUploadTarget({ bucket: "Onboarding-Uploads", path: "flow-uploads/a/b.pdf" }).error).toBeTruthy()
  })
})

describe("validateStorageUploadTarget — path shape", () => {
  it("refuses a path outside every known prefix", () => {
    expect(validateStorageUploadTarget({ bucket: BUCKET, path: "fax-attachments/x.pdf" }).error).toBeTruthy()
    expect(validateStorageUploadTarget({ bucket: BUCKET, path: "anything/else.pdf" }).error).toBeTruthy()
  })

  it("refuses traversal even under an allowed prefix", () => {
    const traversals = [
      "flow-uploads/../fax-attachments/steal.pdf",
      "flow-uploads/sd/../../signed-contracts/tampered.pdf",
      "articles/..",
    ]
    for (const path of traversals) {
      const result = validateStorageUploadTarget({ bucket: BUCKET, path })
      expect(result.error, `expected refusal for ${path}`).toBeTruthy()
    }
  })

  it("refuses absolute paths, backslashes and NUL bytes", () => {
    expect(validateStorageUploadTarget({ bucket: BUCKET, path: "/flow-uploads/a.pdf" }).error).toBeTruthy()
    expect(validateStorageUploadTarget({ bucket: BUCKET, path: "flow-uploads\\a.pdf" }).error).toBeTruthy()
    expect(validateStorageUploadTarget({ bucket: BUCKET, path: "flow-uploads/a\0.pdf" }).error).toBeTruthy()
  })

  it("refuses an over-long path but accepts one at the limit", () => {
    const prefix = "flow-uploads/"
    const atLimit = prefix + "a".repeat(MAX_UPLOAD_PATH_LENGTH - prefix.length)
    expect(atLimit.length).toBe(MAX_UPLOAD_PATH_LENGTH)
    expect(validateStorageUploadTarget({ bucket: BUCKET, path: atLimit }).error).toBeNull()
    expect(validateStorageUploadTarget({ bucket: BUCKET, path: atLimit + "a" }).error).toBeTruthy()
  })
})

describe("validateStorageUploadTarget — malformed input", () => {
  it.each([
    ["both missing", {}],
    ["bucket missing", { path: "flow-uploads/a.pdf" }],
    ["path missing", { bucket: BUCKET }],
    ["empty bucket", { bucket: "", path: "flow-uploads/a.pdf" }],
    ["empty path", { bucket: BUCKET, path: "" }],
    ["numeric bucket", { bucket: 42, path: "flow-uploads/a.pdf" }],
    ["array path", { bucket: BUCKET, path: ["flow-uploads/a.pdf"] }],
    ["null path", { bucket: BUCKET, path: null }],
    ["object bucket", { bucket: { toString: () => BUCKET }, path: "flow-uploads/a.pdf" }],
  ])("refuses %s without throwing", (_label, input) => {
    const result = validateStorageUploadTarget(input as { bucket?: unknown; path?: unknown })
    expect(result.error).toBeTruthy()
  })
})
