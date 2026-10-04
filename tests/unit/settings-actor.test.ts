import { describe, it, expect } from "vitest"
import { readFileSync } from "fs"
import { join } from "path"
import { SETTINGS_ACTOR_HEADER, settingsActor } from "@/lib/services/settings-actor"

describe("settingsActor — who changed a service setting (N1a P2)", () => {
  it("keeps a staff email as-is", () => {
    expect(settingsActor("luca@tonydurante.us")).toBe("luca@tonydurante.us")
  })
  it("falls back when there is no label", () => {
    expect(settingsActor(null)).toBe("app:unknown")
    expect(settingsActor("   ")).toBe("app:unknown")
    expect(settingsActor(undefined, "app:config")).toBe("app:config")
  })
  it("strips characters a request header can't carry and caps the length", () => {
    expect(settingsActor("Nicolò\nx@y.com")).toBe("Nicolx@y.com")
    expect(settingsActor("a".repeat(500))).toHaveLength(200)
  })
  it("uses the same header name the database recorder reads", () => {
    const sql = readFileSync(join(process.cwd(), "scripts/migrations/20261004-0100-service-settings-history.sql"), "utf8")
    expect(sql).toContain(`->> '${SETTINGS_ACTOR_HEADER}'`)
  })
})
