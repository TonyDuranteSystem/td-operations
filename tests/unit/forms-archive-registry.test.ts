import { describe, it, expect } from "vitest"
import { bankingConfigAndBucket, deriveUploadPaths, getArchiveRecipe, ARCHIVE_RECIPES } from "@/lib/forms/archive-registry"

describe("deriveUploadPaths (bug-hunter blocker guard)", () => {
  it("recovers a portal-wizard submission's files from submitted_data when the column is EMPTY", () => {
    // Wizard banking rows never persist the upload_paths column — the paths live
    // inside submitted_data. Reading the column alone would archive an empty
    // package and silently lose the client's KYC files. This is the exact
    // regression the fix guards against.
    const submitted = {
      bank_name: "Payset",
      passport: ["banking_payset/acct-1/passport.pdf"],
      proof_of_address: "banking_payset/acct-1/utility.pdf",
    }
    expect(deriveUploadPaths(null, submitted).sort()).toEqual([
      "banking_payset/acct-1/passport.pdf",
      "banking_payset/acct-1/utility.pdf",
    ])
  })

  it("uses the column for external-form submissions (paths in the column, none in data)", () => {
    expect(deriveUploadPaths(["banking/acct-2/statements.pdf"], { bank_name: "Relay" })).toEqual([
      "banking/acct-2/statements.pdf",
    ])
  })

  it("unions and de-dupes when a path appears in BOTH the column and the data", () => {
    const p = "banking_relay/acct-3/id.png"
    expect(deriveUploadPaths([p], { id_doc: p })).toEqual([p])
  })

  it("returns an empty list for a truly file-less submission (no false files)", () => {
    expect(deriveUploadPaths(null, { bank_name: "Payset" })).toEqual([])
    expect(deriveUploadPaths(undefined, undefined)).toEqual([])
  })

  it("ignores non-upload strings inside the data (only wizard-prefixed paths count)", () => {
    expect(deriveUploadPaths(null, { note: "just a note", website: "https://x.com" })).toEqual([])
  })
})

describe("bankingConfigAndBucket", () => {
  it("maps the portal-wizard Relay origin to the relay config + onboarding bucket", () => {
    expect(bankingConfigAndBucket("relay")).toEqual({ configKey: "banking_relay", bucket: "onboarding-uploads" })
  })
  it("maps the portal-wizard Payset origin to the payset config + onboarding bucket", () => {
    expect(bankingConfigAndBucket("payset")).toEqual({ configKey: "banking_payset", bucket: "onboarding-uploads" })
  })
  it("falls back to the external-form config + banking bucket for any other provider", () => {
    expect(bankingConfigAndBucket("mercury")).toEqual({ configKey: "banking", bucket: "banking-uploads" })
    expect(bankingConfigAndBucket("")).toEqual({ configKey: "banking", bucket: "banking-uploads" })
    expect(bankingConfigAndBucket(null)).toEqual({ configKey: "banking", bucket: "banking-uploads" })
    expect(bankingConfigAndBucket(undefined)).toEqual({ configKey: "banking", bucket: "banking-uploads" })
  })
})

describe("banking recipe registration", () => {
  const recipe = getArchiveRecipe("banking")

  it("is registered", () => {
    expect(recipe).not.toBeNull()
    expect(ARCHIVE_RECIPES.banking).toBeDefined()
    expect(recipe?.table).toBe("banking_submissions")
  })

  it("selects created_at (the sweep needs it) and the marker columns", () => {
    expect(recipe?.selectColumns).toContain("created_at")
    expect(recipe?.selectColumns).toContain("drive_archived_at")
    expect(recipe?.selectColumns).toContain("drive_archive_meta")
    expect(recipe?.selectColumns).toContain("provider")
  })

  it("treats completed / reviewed as real, and pending / draft as not real", () => {
    expect(recipe?.isReal({ status: "completed" })).toBe(true)
    expect(recipe?.isReal({ status: "reviewed" })).toBe(true)
    expect(recipe?.isReal({ status: "pending" })).toBe(false)
    expect(recipe?.isReal({ status: null })).toBe(false)
    expect(recipe?.isReal({})).toBe(false)
  })

  it("returns null recipe for an unregistered form type", () => {
    expect(getArchiveRecipe("formation")).toBeNull()
    expect(getArchiveRecipe("nonsense")).toBeNull()
  })
})
