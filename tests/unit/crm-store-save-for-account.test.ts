import { describe, it, expect, vi } from "vitest"
import { saveDocumentForAccount, saveDocumentForContact, saveSignedPdfForAccount, CompanyMovingError, GENERIC_CLIENT_TYPE, type SaveDeps } from "@/lib/crm-store/save-for-account"
import type { CompanyDocState } from "@/lib/crm-store/switched-drive-guard"

const FILE = "0f1e2d3c-4b5a-4968-8776-a5b4c3d2e1f0"
const mk = (state: CompanyDocState, over: Partial<SaveDeps> = {}): SaveDeps & { calls: Record<string, ReturnType<typeof vi.fn>> } => {
  const calls = {
    save: vi.fn(async () => ({ status: "created", fileId: FILE })),
    upsertRow: vi.fn(async () => ({ id: "row-1", inserted: true })),
    personOwner: vi.fn(async () => "person-owner"),
    liveOwner: vi.fn(async () => "company-owner"),
  }
  return {
    state: async () => state,
    liveOwner: calls.liveOwner,
    personOwner: calls.personOwner,
    save: calls.save as unknown as SaveDeps["save"],
    upsertRow: calls.upsertRow as unknown as SaveDeps["upsertRow"],
    pointer: (id: string) => `store:${id}`,
    calls,
    ...over,
  }
}
const base = { accountId: "acc-1", name: "Lease.pdf", bytes: Buffer.from("pdf"), mimeType: "application/pdf", folder: "company" as const, documentType: "office_lease", callerKey: "lease:acc-1:1" }

describe("saveDocumentForAccount — where do this company's files live?", () => {
  it("a company still on Drive: nothing is saved here, the caller carries on with Drive", async () => {
    const d = mk("drive")
    expect(await saveDocumentForAccount(base, d)).toEqual({ route: "drive" })
    expect(d.calls.save).not.toHaveBeenCalled()
    expect(d.calls.upsertRow).not.toHaveBeenCalled()
  })

  it("a company being moved: refused with a plain message, nothing saved", async () => {
    const d = mk("moving")
    await expect(saveDocumentForAccount(base, d)).rejects.toBeInstanceOf(CompanyMovingError)
    expect(d.calls.save).not.toHaveBeenCalled()
  })

  it("a switched company: saved in its storage and listed in the CRM documents list, hidden from the client by default", async () => {
    const d = mk("store")
    const r = await saveDocumentForAccount({ ...base, row: { category: 1 } }, d)
    expect(r).toEqual({ route: "store", fileId: FILE, pointer: `store:${FILE}`, documentRowId: "row-1", status: "created" })
    expect(d.calls.save).toHaveBeenCalledWith(expect.objectContaining({ ownerId: "company-owner", folderKind: "company", documentType: "office_lease", callerKey: "lease:acc-1:1", published: false }))
    expect(d.calls.upsertRow).toHaveBeenCalledWith(FILE, expect.objectContaining({ file_name: "Lease.pdf", account_id: "acc-1", portal_visible: false, category: 1, file_size: 3 }), "created")
  })

  it("an untyped file meant for the CLIENT gets the generic type (an untyped store file is closed to clients); an internal one may stay untyped", async () => {
    const shown = mk("store")
    await saveDocumentForAccount({ ...base, documentType: null, portalVisible: true }, shown)
    expect(shown.calls.save).toHaveBeenCalledWith(expect.objectContaining({ documentType: GENERIC_CLIENT_TYPE, published: true }))
    expect(GENERIC_CLIENT_TYPE).toBe("other_document")
    const hidden = mk("store")
    await saveDocumentForAccount({ ...base, documentType: null, portalVisible: false }, hidden)
    expect(hidden.calls.save).toHaveBeenCalledWith(expect.objectContaining({ documentType: null, published: false }))
    const named = mk("store")
    await saveDocumentForAccount({ ...base, documentType: "office_lease", portalVisible: true }, named)
    expect(named.calls.save).toHaveBeenCalledWith(expect.objectContaining({ documentType: "office_lease" }))
  })

  it("shown to the client only when the caller says so", async () => {
    const d = mk("store")
    await saveDocumentForAccount({ ...base, portalVisible: true }, d)
    expect(d.calls.save).toHaveBeenCalledWith(expect.objectContaining({ published: true }))
    expect(d.calls.upsertRow).toHaveBeenCalledWith(FILE, expect.objectContaining({ portal_visible: true }), "created")
  })

  it("a personal document (passport) goes to the PERSON's own storage, listed against the person, never the company", async () => {
    const d = mk("store")
    await saveDocumentForAccount({ ...base, folder: "contacts", documentType: "passport", person: { contactId: "c-1", name: "Mario Rossi" } }, d)
    expect(d.calls.personOwner).toHaveBeenCalledWith("c-1", "Mario Rossi")
    expect(d.calls.save).toHaveBeenCalledWith(expect.objectContaining({ ownerId: "person-owner", folderKind: "personal" }))
    expect(d.calls.upsertRow).toHaveBeenCalledWith(FILE, expect.objectContaining({ account_id: null, contact_id: "c-1" }), "created")
  })

  it("a switched company with no storage found is an error — never a silent fallback to Drive", async () => {
    const d = mk("store", { liveOwner: async () => null })
    await expect(saveDocumentForAccount(base, d)).rejects.toThrow(/could not be found/)
    expect(d.calls.save).not.toHaveBeenCalled()
  })

  it("a failed storage save for a switched company is an error — never a silent fallback to Drive", async () => {
    const d = mk("store", { save: async () => { throw new Error("store down") } })
    await expect(saveDocumentForAccount(base, d)).rejects.toThrow("store down")
  })

  it("an unreadable state refuses (fail closed): the lookup error is raised, nothing is saved", async () => {
    const d = mk("store", { state: async () => { throw new Error("Could not check where this company's files live — please try again.") } })
    await expect(saveDocumentForAccount(base, d)).rejects.toThrow(/Could not check/)
    expect(d.calls.save).not.toHaveBeenCalled()
  })
})

describe("saveDocumentForContact — a person's own documents", () => {
  const mkP = (owner: string | null) => {
    const save = vi.fn(async () => ({ status: "created", fileId: FILE }))
    const upsertRow = vi.fn(async () => ({ id: "row-p", inserted: true }))
    return { save, upsertRow, deps: { liveOwnerOfContact: async () => owner, save: save as unknown as SaveDeps["save"], upsertRow: upsertRow as unknown as SaveDeps["upsertRow"], pointer: (id: string) => `store:${id}` } }
  }
  const pass = { contactId: "c-1", name: "Passport.pdf", bytes: Buffer.from("pdf"), mimeType: "application/pdf", documentType: "passport", callerKey: "pass:c-1:1" }

  it("a person still on Drive: the caller carries on with Drive", async () => {
    const m = mkP(null)
    expect(await saveDocumentForContact(pass, m.deps)).toEqual({ route: "drive" })
    expect(m.save).not.toHaveBeenCalled()
  })

  it("a person with a live storage: saved in THEIR personal folder, listed against them, hidden from the client by default", async () => {
    const m = mkP("person-owner")
    const r = await saveDocumentForContact({ ...pass, accountId: "acc-1", row: { category: 2 } }, m.deps)
    expect(r).toEqual({ route: "store", fileId: FILE, pointer: `store:${FILE}`, documentRowId: "row-p", status: "created" })
    expect(m.save).toHaveBeenCalledWith(expect.objectContaining({ ownerId: "person-owner", folderKind: "personal", documentType: "passport", published: false }))
    expect(m.upsertRow).toHaveBeenCalledWith(FILE, expect.objectContaining({ contact_id: "c-1", account_id: "acc-1", portal_visible: false, category: 2 }), "created")
  })
})

describe("saveDocumentForContact — the ITIN folder", () => {
  const doc = { contactId: "c-1", name: "W-7_X.pdf", bytes: Buffer.from("pdf"), mimeType: "application/pdf", documentType: "form_w_7", callerKey: "itin:c-1:w7", folderKind: "itin" as const }
  it("saves into the person's ITIN folder when asked", async () => {
    const save = vi.fn(async () => ({ status: "created", fileId: FILE }))
    const deps = { liveOwnerOfContact: async () => "person-owner", save: save as unknown as SaveDeps["save"], upsertRow: (async () => ({ id: "row", inserted: true })) as unknown as SaveDeps["upsertRow"], pointer: (id: string) => `store:${id}` }
    await saveDocumentForContact(doc, deps)
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ folderKind: "itin", documentType: "form_w_7" }))
  })
  it("a person storage with no ITIN folder gets Personal documents instead of an error", async () => {
    const calls: string[] = []
    const save = vi.fn(async (p: { folderKind: string }) => { calls.push(p.folderKind); if (p.folderKind === "itin") throw new Error('store pilot: owner o has no "itin" folder'); return { status: "created", fileId: FILE } })
    const deps = { liveOwnerOfContact: async () => "person-owner", save: save as unknown as SaveDeps["save"], upsertRow: (async () => ({ id: "row", inserted: true })) as unknown as SaveDeps["upsertRow"], pointer: (id: string) => `store:${id}` }
    const r = await saveDocumentForContact(doc, deps)
    expect(calls).toEqual(["itin", "personal"])
    expect(r.route).toBe("store")
  })
  it("any other error is not swallowed", async () => {
    const save = vi.fn(async () => { throw new Error("disk full") })
    const deps = { liveOwnerOfContact: async () => "person-owner", save: save as unknown as SaveDeps["save"], upsertRow: (async () => ({ id: "row", inserted: true })) as unknown as SaveDeps["upsertRow"], pointer: (id: string) => `store:${id}` }
    await expect(saveDocumentForContact(doc, deps)).rejects.toThrow(/disk full/)
  })
})

describe("saveDocumentForContact — a person of a switched company", () => {
  const pass = { contactId: "c-1", name: "Passport.pdf", bytes: Buffer.from("pdf"), mimeType: "application/pdf", documentType: "passport", callerKey: "pass:c-1:2" }
  const mkC = (owner: string | null, companyState: "drive" | "store" | "moving") => {
    const save = vi.fn(async () => ({ status: "created", fileId: FILE }))
    const ensurePerson = vi.fn(async () => "person-owner-new")
    return { save, ensurePerson, deps: { liveOwnerOfContact: async () => owner, save: save as unknown as SaveDeps["save"], upsertRow: (async () => ({ id: "row", inserted: true })) as unknown as SaveDeps["upsertRow"], pointer: (id: string) => `store:${id}`, companyState: async () => companyState, ensurePerson } }
  }

  it("the company is switched but the person has no live storage yet: their own storage is opened for the document (same as the portal)", async () => {
    const m = mkC(null, "store")
    const r = await saveDocumentForContact({ ...pass, viaAccountId: "acc-1", contactName: "Mario Rossi" }, m.deps)
    expect(r.route).toBe("store")
    expect(m.ensurePerson).toHaveBeenCalledWith("c-1", "Mario Rossi")
    expect(m.save).toHaveBeenCalledWith(expect.objectContaining({ ownerId: "person-owner-new", folderKind: "personal" }))
  })

  it("the company is mid-move and the person has no live storage: nothing is opened or saved until the move ends", async () => {
    const m = mkC(null, "moving")
    await expect(saveDocumentForContact({ ...pass, viaAccountId: "acc-1", contactName: "Mario Rossi" }, m.deps)).rejects.toThrow(/being moved/)
    expect(m.ensurePerson).not.toHaveBeenCalled()
    expect(m.save).not.toHaveBeenCalled()
  })

  it("the company is mid-move but the person already has a live storage: it is saved there as usual", async () => {
    const m = mkC("person-owner-1", "moving")
    expect((await saveDocumentForContact({ ...pass, viaAccountId: "acc-1", contactName: "Mario Rossi" }, m.deps)).route).toBe("store")
  })

  it("the company is still on Drive and the person has no live storage: Drive as before", async () => {
    const m = mkC(null, "drive")
    expect(await saveDocumentForContact({ ...pass, viaAccountId: "acc-1", contactName: "Mario Rossi" }, m.deps)).toEqual({ route: "drive" })
    expect(m.ensurePerson).not.toHaveBeenCalled()
  })
})

describe("saveSignedPdfForAccount — the shape most automatic flows share", () => {
  const signed = { accountId: "acc-1", fileName: "Lease - Acme (Signed).pdf", bytes: Buffer.from("%PDF"), label: "Lease Agreement", callerKey: "lease-signed:L1" }

  it("a company still on Drive: the flow carries on with Drive", async () => {
    const d = mk("drive")
    expect(await saveSignedPdfForAccount(signed, d)).toEqual({ route: "drive" })
    expect(d.calls.save).not.toHaveBeenCalled()
  })

  it("a switched company: the PDF goes to 1. Company, visible in the portal, listed with its label; the same key is the same file", async () => {
    const d = mk("store")
    const r = await saveSignedPdfForAccount(signed, d)
    expect(r.route).toBe("store")
    expect(d.calls.save).toHaveBeenCalledWith(expect.objectContaining({ folderKind: "company", mimeType: "application/pdf", callerKey: "lease-signed:L1", published: true }))
    expect(d.calls.upsertRow).toHaveBeenCalledWith(FILE, expect.objectContaining({ document_type_name: "Lease Agreement", category: 1, status: "classified", portal_visible: true }), "created")
  })

  it("category 3 goes to 3. Tax", async () => {
    const d = mk("store")
    await saveSignedPdfForAccount({ ...signed, category: 3 }, d)
    expect(d.calls.save).toHaveBeenCalledWith(expect.objectContaining({ folderKind: "tax" }))
  })
})
