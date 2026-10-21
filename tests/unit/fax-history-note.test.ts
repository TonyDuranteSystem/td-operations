import { describe, it, expect } from "vitest"
import { faxNoCopyNote, claimShownAs } from "@/lib/fax/history-note"

describe("faxNoCopyNote", () => {
  it("says plainly why there is nothing to open", () => {
    expect(faxNoCopyNote({ noCopyReason: "my_files", filingStatus: "done", savedAtPlace: "My files › x" })).toMatch(/Saved in My files/)
    expect(faxNoCopyNote({ noCopyReason: null, filingStatus: "failed", savedAtPlace: null })).toMatch(/WAS sent, but the copy could not be saved/)
    expect(faxNoCopyNote({ noCopyReason: null, filingStatus: "pending", savedAtPlace: null })).toMatch(/did not finish/)
  })
  it("says nothing when all is well", () => {
    expect(faxNoCopyNote({ noCopyReason: null, filingStatus: "done", savedAtPlace: "A › B" })).toBeNull()
    expect(faxNoCopyNote({ noCopyReason: null, filingStatus: null, savedAtPlace: null })).toBeNull()
  })
})

describe("claimShownAs / the stored-file note", () => {
  const now = new Date("2026-10-20T12:00:00Z")
  it("a claim younger than 2 minutes is 'sending', older (or unreadable) is 'outcome unknown' — never 'sent'", () => {
    expect(claimShownAs("2026-10-20T11:59:30Z", now)).toBe("sending")
    expect(claimShownAs("2026-10-20T11:57:00Z", now)).toBe("unknown")
    expect(claimShownAs(null, now)).toBe("unknown")
    expect(claimShownAs("garbage", now)).toBe("unknown")
  })
  it("a fax of a file already in the storage says no copy was made", () => {
    expect(faxNoCopyNote({ noCopyReason: null, filingStatus: "not_needed", savedAtPlace: null, source: "stored_file" })).toMatch(/Faxed straight from the storage/)
  })
})
