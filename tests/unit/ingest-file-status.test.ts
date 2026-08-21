import { describe, it, expect } from "vitest"
import {
  computeIngestFileStates,
  summarizeIngestFileStates,
  buildIngestFileEntries,
  displayStatementFileName,
  FORMAT_CONFIRMATION_MARKER,
  type IngestJobRow,
} from "@/lib/tax/ingest-file-status"

// Card 4a39e0fd: ONE per-file state implementation shared by the client GET,
// the "statements ready" gate, and the staff surfaces.

const row = (over: Partial<IngestJobRow>): IngestJobRow => ({
  status: "completed",
  result: { ok: true },
  payload: { tax_year: 2025, path: "tax/a/2025/f1.csv" },
  ...over,
})

describe("computeIngestFileStates", () => {
  it("any successful job wins over earlier failures for the SAME file", () => {
    const states = computeIngestFileStates(
      [
        row({ status: "failed", result: { ok: false } }),
        row({ status: "completed", result: { ok: true } }),
      ],
      2025,
    )
    expect(states.get("tax/a/2025/f1.csv")).toBe("succeeded")
  })

  it("failed with no success → failed; pending beats failed (a retry is running)", () => {
    const failedOnly = computeIngestFileStates([row({ status: "failed", result: { ok: false } })], 2025)
    expect(failedOnly.get("tax/a/2025/f1.csv")).toBe("failed")

    const retrying = computeIngestFileStates(
      [row({ status: "failed", result: { ok: false } }), row({ status: "pending", result: null })],
      2025,
    )
    expect(retrying.get("tax/a/2025/f1.csv")).toBe("pending")
  })

  it("completed with ok:false counts as failed (the unreadable-file class)", () => {
    const states = computeIngestFileStates([row({ status: "completed", result: { ok: false } })], 2025)
    expect(states.get("tax/a/2025/f1.csv")).toBe("failed")
  })

  it("quarantine marker → quarantined, never failed (client must not be told to re-upload)", () => {
    const states = computeIngestFileStates(
      [row({ status: "failed", result: { ok: false, steps: [{ detail: `${FORMAT_CONFIRMATION_MARKER}{"file":"f1.csv"}` }] } })],
      2025,
    )
    expect(states.get("tax/a/2025/f1.csv")).toBe("quarantined")
  })

  it("scopes to the tax year, ignores cancelled jobs and pathless rows", () => {
    const states = computeIngestFileStates(
      [
        row({ payload: { tax_year: 2024, path: "tax/a/2024/old.csv" }, status: "failed", result: { ok: false } }),
        row({ status: "cancelled", result: { ok: false } }),
        row({ payload: { tax_year: 2025 }, status: "failed", result: { ok: false } }),
      ],
      2025,
    )
    // The 2024 failure is out of scope; the cancelled 2025 row is ignored — the
    // file has NO state at all (delete-supersede must not resurrect it as failed).
    expect(states.size).toBe(0)
  })

  it("payload tax_year as string still matches (JSONB numbers arrive as either)", () => {
    const states = computeIngestFileStates([row({ payload: { tax_year: "2025", path: "p" } })], 2025)
    expect(states.get("p")).toBe("succeeded")
  })

  // 2026-08-20 hard-stop plan: workspace jobs (ingest_workspace_statement)
  // never carry tax_year in their payload at all — a workspace has exactly
  // one tax year, via related_entity_id scoping at the query level, not this
  // field. Before this fix, a MISSING tax_year was treated as "" !== "2025"
  // and silently dropped every workspace file — this is the regression test
  // for that (the staff GET route wiring this shared helper up for the
  // first time would otherwise have shipped with every workspace reporting
  // zero files, always).
  it("a job with NO tax_year in its payload at all is never filtered out, regardless of the year argument passed", () => {
    const noYear = [row({ payload: { path: "ws/f1.csv" }, status: "completed", result: { ok: true } })]
    expect(computeIngestFileStates(noYear, 2025).get("ws/f1.csv")).toBe("succeeded")
    expect(computeIngestFileStates(noYear, 1999).get("ws/f1.csv")).toBe("succeeded")
    expect(computeIngestFileStates(noYear, 0).get("ws/f1.csv")).toBe("succeeded")
  })

  it("a job that DOES carry tax_year is still correctly excluded on a mismatch (the fix must not weaken the existing client-account scoping)", () => {
    const wrongYear = [row({ payload: { tax_year: 2024, path: "acct/old.csv" }, status: "completed", result: { ok: true } })]
    expect(computeIngestFileStates(wrongYear, 2025).size).toBe(0)
  })

  it("summarize counts every state", () => {
    const states = computeIngestFileStates(
      [
        row({ payload: { tax_year: 2025, path: "ok.csv" } }),
        row({ payload: { tax_year: 2025, path: "dead.csv" }, status: "failed", result: { ok: false } }),
        row({ payload: { tax_year: 2025, path: "wip.csv" }, status: "processing", result: null }),
        row({
          payload: { tax_year: 2025, path: "quar.csv" }, status: "failed",
          result: { ok: false, steps: [{ detail: `${FORMAT_CONFIRMATION_MARKER}{}` }] },
        }),
      ],
      2025,
    )
    expect(summarizeIngestFileStates(states)).toEqual({ pending: 1, succeeded: 1, failed: 1, quarantined: 1 })
  })
})


describe("displayStatementFileName", () => {
  it("strips the upload machinery prefixes, keeps the client's name", () => {
    expect(displayStatementFileName("tax/sub-1/bank_accounts_0_statements_6a008993_Relay_June.csv")).toBe("Relay_June.csv")
    expect(displayStatementFileName("tax/sub-1/bank_statements_1f00eaac_wise-export.csv")).toBe("wise-export.csv")
    expect(displayStatementFileName("tax/acc/2025/aaaaaaaaaaaaaaaa_Mercury_2025.pdf")).toBe("Mercury_2025.pdf")
    expect(displayStatementFileName("plain.csv")).toBe("plain.csv")
  })
})

describe("buildIngestFileEntries", () => {
  it("failed files carry the plain-language guide text from the ingest step", () => {
    const entries = buildIngestFileEntries(
      [row({
        status: "failed",
        result: { ok: false, steps: [{ detail: "f1.csv: We could not read any transactions from this file. Please upload each statement exactly as your bank exports it." }] },
        payload: { tax_year: 2025, path: "tax/a/2025/aaaaaaaaaaaaaaaa_f1.csv" },
      })],
      2025,
    )
    expect(entries).toHaveLength(1)
    expect(entries[0].state).toBe("failed")
    expect(entries[0].file_name).toBe("f1.csv")
    expect(entries[0].client_error).toContain("Please upload each statement")
  })

  it("succeeded/pending/quarantined entries carry no error text", () => {
    const entries = buildIngestFileEntries(
      [
        row({ payload: { tax_year: 2025, path: "ok.csv" } }),
        row({ payload: { tax_year: 2025, path: "wip.csv" }, status: "pending", result: null }),
      ],
      2025,
    )
    expect(entries.every(e => e.client_error === null)).toBe(true)
  })

  it("empty-but-valid succeeded files carry the empty flag (they must not vanish from the UI)", () => {
    const entries = buildIngestFileEntries(
      [row({ status: "completed", result: { ok: true, summary: "Processed f.csv: empty statement period (0 transactions)" }, payload: { tax_year: 2025, path: "empty.csv" } })],
      2025,
    )
    expect(entries[0].state).toBe("succeeded")
    expect(entries[0].empty).toBe(true)
  })

  it("a failed job with NO ingest-step detail (infra-exhausted throw path) gets the OUR-side copy, never blame-the-file", () => {
    const entries = buildIngestFileEntries(
      [row({ status: "failed", result: null, payload: { tax_year: 2025, path: "f.csv" } })],
      2025,
    )
    expect(entries[0].state).toBe("failed")
    expect(entries[0].client_error).toContain("This is on our side")
    expect(entries[0].client_error).not.toContain("delete it and upload")
  })
})
