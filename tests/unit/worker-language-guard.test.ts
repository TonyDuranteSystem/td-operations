/**
 * Language guard on the worker's portal send (Adam Marra incident, 2026-07-17).
 *
 * Pins the council-approved contract:
 * - detector is FAIL-OPEN: short / mixed / address-heavy drafts are "unknown";
 * - the guard refuses ONLY Italian-client + confidently-English draft;
 * - after one refusal the SEND LATCH disables sending for the rest of the turn
 *   (the model must not translate-and-resend a draft staff never reviewed);
 * - a refusal is audited via logAction.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

// --- Thenable mock builder (shouldRefusePortalDraftLanguage awaits a .limit()
// chain directly, like the real supabase-js builder) -------------------------
let mockState: {
  accountContactLinks: Array<{ contact_id: string }>
  contactLanguage: string | null
  failQueries?: boolean
}

function makeBuilder(table: string) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const builder: any = {
    select: () => builder,
    eq: () => builder,
    gte: () => builder,
    limit: () => builder,
    insert: () => builder,
    maybeSingle: async () => {
      if (mockState.failQueries) throw new Error("db down")
      if (table === "contacts") return { data: { language: mockState.contactLanguage } }
      return { data: null }
    },
    single: async () => ({ data: { id: "msg-1", created_at: "2026-07-17T00:00:00Z" }, error: null }),
    then: (resolve: (v: unknown) => void, reject: (e: unknown) => void) => {
      if (mockState.failQueries) return Promise.reject(new Error("db down")).then(resolve, reject)
      const data = table === "account_contacts" ? mockState.accountContactLinks : []
      return Promise.resolve({ data }).then(resolve, reject)
    },
  }
  return builder
}

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: { from: (t: string) => makeBuilder(t) },
}))

const logAction = vi.fn()
vi.mock("@/lib/mcp/action-log", () => ({ logAction: (...a: unknown[]) => logAction(...a) }))
vi.mock("@/lib/portal/notifications", () => ({
  createPortalNotification: vi.fn().mockResolvedValue(undefined),
  notifyClientOfAdminMessage: vi.fn().mockResolvedValue(undefined),
}))

import { detectDraftLanguage } from "@/lib/ai-agent/draft-language"
import {
  shouldRefusePortalDraftLanguage,
  executeWorkerTool,
  PORTAL_LANGUAGE_REFUSAL,
  type WorkerSendContext,
} from "@/lib/ai-agent/worker-tools"
import { renderClientCard, sanitizeCardValue } from "@/lib/ai-agent/client-card"

// The REAL drafts from the incident (2026-07-17) — the guard must refuse the
// first and pass the second, or it is worse than useless.
const INCIDENT_ENGLISH_DRAFT = `Hi Adam,

We've uploaded your Office Lease Agreement in the portal — you'll find it under "Sign Documents." Please sign it as soon as possible.

Once you've signed it, you'll need to do two things in your Interactive Brokers application:

1. Update the address for "Proof of Principal Place of Business" — click the edit icon next to the current Wyoming address and change it to: 10225 Ulmerton Rd, Suite 3D-308, Largo, FL 33771

2. Upload the signed Lease Agreement as the proof document for that address.

Let us know if you have any questions!`

const INCIDENT_ITALIAN_DRAFT = `Ciao Adam,

Abbiamo caricato il tuo Contratto di Locazione dell'ufficio nel portale — lo trovi nella sezione "Firma Documenti". Ti chiediamo di firmarlo il prima possibile.

Una volta firmato, dovrai fare due cose nella tua applicazione Interactive Brokers:

1. Aggiorna l'indirizzo nella sezione "Proof of Principal Place of Business" — clicca sull'icona di modifica accanto all'indirizzo del Wyoming e cambialo con: 10225 Ulmerton Rd, Suite 3D-308, Largo, FL 33771

2. Carica il Contratto di Locazione firmato come documento di prova per quell'indirizzo.

Siamo a disposizione per qualsiasi domanda!`

beforeEach(() => {
  mockState = { accountContactLinks: [{ contact_id: "c-1" }], contactLanguage: "Italian" }
  logAction.mockClear()
})

describe("detectDraftLanguage — fail-open contract", () => {
  it("classifies the incident's real English draft as English", () => {
    expect(detectDraftLanguage(INCIDENT_ENGLISH_DRAFT)).toBe("en")
  })
  it("classifies the incident's real Italian draft (with English product terms + a US address) as Italian", () => {
    expect(detectDraftLanguage(INCIDENT_ITALIAN_DRAFT)).toBe("it")
  })
  it("short acks are unknown", () => {
    expect(detectDraftLanguage("si")).toBe("unknown")
    expect(detectDraftLanguage("Ok perfetto — Suite 3D-308")).toBe("unknown")
  })
  it("address/name-heavy short text is unknown", () => {
    expect(detectDraftLanguage("10225 Ulmerton Rd, Suite 3D-308, Largo, FL 33771 — Azor Consulting LLC")).toBe("unknown")
  })
  it("empty / null are unknown", () => {
    expect(detectDraftLanguage("")).toBe("unknown")
    expect(detectDraftLanguage(null)).toBe("unknown")
    expect(detectDraftLanguage(undefined)).toBe("unknown")
  })
})

describe("shouldRefusePortalDraftLanguage", () => {
  it("refuses: Italian-language contact + confidently-English draft", async () => {
    await expect(
      shouldRefusePortalDraftLanguage({ contact_id: "c-1", message: INCIDENT_ENGLISH_DRAFT })
    ).resolves.toBe(true)
  })
  it("allows an Italian draft to an Italian client", async () => {
    await expect(
      shouldRefusePortalDraftLanguage({ contact_id: "c-1", message: INCIDENT_ITALIAN_DRAFT })
    ).resolves.toBe(false)
  })
  it("fail-open: contact language null/blank never refuses", async () => {
    mockState.contactLanguage = null
    await expect(
      shouldRefusePortalDraftLanguage({ contact_id: "c-1", message: INCIDENT_ENGLISH_DRAFT })
    ).resolves.toBe(false)
  })
  it("fail-open: English-language client never refuses", async () => {
    mockState.contactLanguage = "English"
    await expect(
      shouldRefusePortalDraftLanguage({ contact_id: "c-1", message: INCIDENT_ENGLISH_DRAFT })
    ).resolves.toBe(false)
  })
  it("fail-open: multi-contact account (ambiguous member) never refuses", async () => {
    mockState.accountContactLinks = [{ contact_id: "c-1" }, { contact_id: "c-2" }]
    await expect(
      shouldRefusePortalDraftLanguage({ account_id: "a-1", message: INCIDENT_ENGLISH_DRAFT })
    ).resolves.toBe(false)
  })
  it("single-contact account resolves the member and refuses on mismatch", async () => {
    mockState.accountContactLinks = [{ contact_id: "c-1" }]
    await expect(
      shouldRefusePortalDraftLanguage({ account_id: "a-1", message: INCIDENT_ENGLISH_DRAFT })
    ).resolves.toBe(true)
  })
  it("fail-open: a DB error never blocks the send", async () => {
    mockState.failQueries = true
    await expect(
      shouldRefusePortalDraftLanguage({ contact_id: "c-1", message: INCIDENT_ENGLISH_DRAFT })
    ).resolves.toBe(false)
  })
})

describe("send latch + guard wiring in executeWorkerTool", () => {
  it("refuses an English draft to a pinned Italian client, latches, and audits", async () => {
    const sendContext: WorkerSendContext = {
      actor: "crm-portal:test@tonydurante.us",
      pinnedPortalRecipient: { contact_id: "c-1" },
    }
    const result = await executeWorkerTool(
      "send_portal_message",
      { message: INCIDENT_ENGLISH_DRAFT },
      undefined,
      null,
      null,
      sendContext,
    )
    expect(result).toBe(PORTAL_LANGUAGE_REFUSAL)
    expect(sendContext.portalSendLatched).toBe(true)
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({ summary: expect.stringContaining("language guard") })
    )
  })

  it("once latched, EVERY further send this turn is refused (even a correct Italian one)", async () => {
    const sendContext: WorkerSendContext = {
      actor: "crm-portal:test@tonydurante.us",
      pinnedPortalRecipient: { contact_id: "c-1" },
      portalSendLatched: true,
    }
    const result = await executeWorkerTool(
      "send_portal_message",
      { message: INCIDENT_ITALIAN_DRAFT },
      undefined,
      null,
      null,
      sendContext,
    )
    expect(result).toBe(PORTAL_LANGUAGE_REFUSAL)
  })

  it("an Italian draft to the pinned Italian client goes through (no latch)", async () => {
    const sendContext: WorkerSendContext = {
      actor: "crm-portal:test@tonydurante.us",
      pinnedPortalRecipient: { contact_id: "c-1" },
    }
    const result = await executeWorkerTool(
      "send_portal_message",
      { message: INCIDENT_ITALIAN_DRAFT },
      undefined,
      null,
      null,
      sendContext,
    )
    expect(result).toContain("✅")
    expect(sendContext.portalSendLatched).toBeUndefined()
  })

  it("REGRESSION (2026-07-29): the guard survives the recipient unlock — a STAFF-DIRECTED recipient with no pin is still checked", async () => {
    // The guard used to be gated on `pinnedPortalRecipient` existing. Making the
    // recipient staff-directable (Antonio: same capabilities everywhere) would have
    // silently disabled it for exactly the new case: a recipient the model supplies.
    // It now keys off the RESOLVED recipient instead. Without this, an Italian
    // client reached from a panel by name would get an English message.
    const sendContext: { actor: string; portalSendLatched?: boolean } = {
      actor: "crm-portal:luca@tonydurante.us",
    }
    const result = await executeWorkerTool(
      "send_portal_message",
      { contact_id: "c-1", message: INCIDENT_ENGLISH_DRAFT },
      undefined,
      null,
      null,
      sendContext,
    )
    expect(result).not.toContain("✅")
    expect(sendContext.portalSendLatched).toBe(true)
  })

  it("Slack path (no send context at all) is untouched by the guard — English draft still sends", async () => {
    const result = await executeWorkerTool(
      "send_portal_message",
      { contact_id: "c-1", message: INCIDENT_ENGLISH_DRAFT },
      undefined,
      null,
      null,
      undefined,
    )
    expect(result).toContain("✅")
  })
})

describe("client card rendering", () => {
  it("labels the three addresses distinctly and prints not-on-file for missing values", () => {
    const card = renderClientCard({
      companyName: "Azor Consulting LLC",
      entityType: "Single Member LLC",
      stateOfFormation: "Wyoming",
      accountStatus: "Active",
      registeredAgentAddress: "30 N Gould St, STE R, Sheridan, WY 82801",
      registeredAgentProvider: "Harbor Compliance",
      mailingAddress: null,
      contactName: "Adam Marra",
      contactLanguage: "Italian",
      contactEmail: "marra@example.com",
      contactAddress: null,
      services: [{ name: "CMRA", stage: "Lease Created", status: "active" }],
      lease: {
        createdAt: "2026-07-17",
        status: "viewed",
        suite: "3D-308",
        premises: "10225 Ulmerton Rd, Largo, FL 33771",
        pdfGenerated: false,
        signedAt: null,
        pageLanguage: "it",
      },
    })
    expect(card).toContain("Registered Agent address")
    expect(card).toContain("service-of-process ONLY")
    expect(card).toContain("Harbor Compliance")
    expect(card).toContain("Business mailing address (CMRA / TD office")
    expect(card).toContain("not on file")
    expect(card).toContain("language on file: Italian")
    expect(card).toContain("PDF NOT generated yet")
    expect(card).toContain("signing PAGE's display language")
  })

  it("sanitizeCardValue flattens newlines and caps length", () => {
    expect(sanitizeCardValue("a\nb\r\nc")).toBe("a b c")
    expect(sanitizeCardValue("  ")).toBeNull()
    expect(sanitizeCardValue(null)).toBeNull()
    const long = "x".repeat(200)
    expect(sanitizeCardValue(long)!.length).toBeLessThanOrEqual(141)
  })
})
