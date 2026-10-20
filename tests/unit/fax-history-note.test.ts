import { describe, it, expect } from "vitest"
import { faxNoCopyNote } from "@/lib/fax/history-note"

describe("faxNoCopyNote", () => {
  it("says plainly why there is nothing to open", () => {
    expect(faxNoCopyNote({ noCopyReason: "my_files", filingStatus: "done", savedAtPlace: "My files › x" })).toMatch(/Saved in My files/)
    expect(faxNoCopyNote({ noCopyReason: "personal_paper", filingStatus: "done", savedAtPlace: null })).toMatch(/No copy was kept/)
    expect(faxNoCopyNote({ noCopyReason: "personal_paper", filingStatus: "done", savedAtPlace: "Business › Fax" })).toMatch(/Saved at Business › Fax\. It is a person's own paper/)
    expect(faxNoCopyNote({ noCopyReason: null, filingStatus: "failed", savedAtPlace: null })).toMatch(/WAS sent, but the copy could not be saved/)
    expect(faxNoCopyNote({ noCopyReason: null, filingStatus: "pending", savedAtPlace: null })).toMatch(/did not finish/)
  })
  it("says nothing when all is well", () => {
    expect(faxNoCopyNote({ noCopyReason: null, filingStatus: "done", savedAtPlace: "A › B" })).toBeNull()
    expect(faxNoCopyNote({ noCopyReason: null, filingStatus: null, savedAtPlace: null })).toBeNull()
  })
})
