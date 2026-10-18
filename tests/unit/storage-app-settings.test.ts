import { describe, it, expect } from "vitest"
import { parseSettings, defaultSettings, clientSaveAllowed, ABSOLUTE_MAX_SAVE_MB } from "@/lib/storage-app/settings"

const D = defaultSettings({})

describe("the one settings row of the Mac app: safe defaults", () => {
  it("nothing set → client saves OFF, a second login step required, 2 / 15 minute copies", () => {
    for (const raw of [undefined, null, "x", 5, [], {}]) {
      const s = parseSettings(raw, {})
      expect(s.clientSaves.owners).toEqual([])
      expect(s.requireSecondFactor).toBe(true)
      expect(s.keepSecondsSensitive).toBe(120)
      expect(s.keepSecondsNormal).toBe(900)
      expect(s.maxSaveMB).toBe(ABSOLUTE_MAX_SAVE_MB)
      expect(s.resyncMinutes).toBe(10)
    }
  })
  it("the hourly limits read their env fallbacks, junk falls back to 500", () => {
    expect(defaultSettings({ STORAGE_APP_READ_LIMIT_MB: "2.5" }).readLimitMB).toBe(2.5)
    for (const bad of ["", "abc", "0", "-5", "NaN", undefined]) expect(defaultSettings({ STORAGE_APP_READ_LIMIT_MB: bad }).readLimitMB).toBe(500)
  })
})

describe("field-by-field validation: one bad value never spoils the others", () => {
  it("takes good values, drops bad ones", () => {
    const s = parseSettings({ keepSecondsNormal: 60, keepSecondsSensitive: "soon", maxSaveMB: 9999, leaseHours: 12, resyncMinutes: 0, maxMacsPerLogin: 2.4 }, {})
    expect(s.keepSecondsNormal).toBe(60)
    expect(s.keepSecondsSensitive).toBe(D.keepSecondsSensitive)
    expect(s.maxSaveMB).toBe(ABSOLUTE_MAX_SAVE_MB)            // can never exceed the writer's ceiling
    expect(s.leaseHours).toBe(12)
    expect(s.resyncMinutes).toBe(D.resyncMinutes)
    expect(s.maxMacsPerLogin).toBe(2)
  })
  it("requireSecondFactor only turns off with a real false", () => {
    expect(parseSettings({ requireSecondFactor: false }, {}).requireSecondFactor).toBe(false)
    for (const v of ["false", 0, null]) expect(parseSettings({ requireSecondFactor: v }, {}).requireSecondFactor).toBe(true)
  })
  it("a malformed clientSaves.owners fails CLOSED (nobody), 'all' and a list work", () => {
    expect(parseSettings({ clientSaves: { owners: "everyone" } }, {}).clientSaves.owners).toEqual([])
    expect(parseSettings({ clientSaves: { owners: [1, 2] } }, {}).clientSaves.owners).toEqual([])
    expect(parseSettings({ clientSaves: { owners: ["", "a"] } }, {}).clientSaves.owners).toEqual([])
    expect(parseSettings({ clientSaves: { owners: "all" } }, {}).clientSaves.owners).toBe("all")
    expect(parseSettings({ clientSaves: { owners: [" a ", "b"] } }, {}).clientSaves.owners).toEqual(["a", "b"])
  })
  it("a malformed sensitiveTypes list keeps the built-in list", () => {
    expect(parseSettings({ sensitiveTypes: "passport" }, {}).sensitiveTypes).toEqual(D.sensitiveTypes)
    expect(parseSettings({ sensitiveTypes: ["passport"] }, {}).sensitiveTypes).toEqual(["passport"])
  })
})

describe("clientSaveAllowed", () => {
  const cs = { owners: ["acc-1", "con-9"], ownerKinds: ["company", "person"], folderKinds: ["custom"] }
  it("matches the store owner id, the account id or the contact id", () => {
    expect(clientSaveAllowed(cs, { kind: "company", accountId: "acc-1" })).toBe(true)
    expect(clientSaveAllowed(cs, { kind: "person", contactId: "con-9" })).toBe(true)
    expect(clientSaveAllowed(cs, { kind: "company", ownerId: "acc-1" })).toBe(true)
    expect(clientSaveAllowed(cs, { kind: "company", accountId: "acc-2" })).toBe(false)
    expect(clientSaveAllowed(cs, { kind: "company" })).toBe(false)
  })
  it("a kind that is not listed is refused even with 'all'", () => {
    expect(clientSaveAllowed({ ...cs, owners: "all" }, { kind: "formation" })).toBe(false)
    expect(clientSaveAllowed({ ...cs, owners: "all" }, { kind: "company" })).toBe(true)
    expect(clientSaveAllowed({ ...cs, owners: "all" }, { kind: null })).toBe(false)
  })
})
