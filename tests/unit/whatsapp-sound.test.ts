import { describe, it, expect } from "vitest"
import {
  normalizeSoundPref, readSoundPref, writeSoundPref, inboundCountFromPayload, claimSoundEvent, gapElapsed,
  WA_SOUND_DEFAULT, WA_SOUND_PREF_KEY, WA_SOUND_MIN_GAP_MS, type SoundStorage,
} from "@/lib/whatsapp-sound"
import { SOUND_LIBRARY, SOUND_NONE } from "@/lib/hooks/use-notification-sound"

const memory = (): SoundStorage & { data: Map<string, string> } => {
  const data = new Map<string, string>()
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) }
}
const broken: SoundStorage = { getItem: () => { throw new Error("blocked") }, setItem: () => { throw new Error("blocked") } }

describe("the chosen tone", () => {
  it("defaults to a tone that is NOT the portal-chat chime", () => {
    expect(WA_SOUND_DEFAULT).not.toBe("chime")
    expect(SOUND_LIBRARY.map((s) => s.id)).toContain(WA_SOUND_DEFAULT)
  })
  it("accepts every library tone and Off; anything else falls back to the default", () => {
    for (const s of SOUND_LIBRARY) expect(normalizeSoundPref(s.id)).toBe(s.id)
    expect(normalizeSoundPref(SOUND_NONE)).toBe(SOUND_NONE)
    expect(normalizeSoundPref("hacked")).toBe(WA_SOUND_DEFAULT)
    expect(normalizeSoundPref(null)).toBe(WA_SOUND_DEFAULT)
    expect(normalizeSoundPref("")).toBe(WA_SOUND_DEFAULT)
  })
  it("round-trips through storage; unreadable or blocked storage = default, never an error", () => {
    const s = memory()
    expect(readSoundPref(s)).toBe(WA_SOUND_DEFAULT)
    writeSoundPref(s, "bell")
    expect(s.data.get(WA_SOUND_PREF_KEY)).toBe("bell")
    expect(readSoundPref(s)).toBe("bell")
    writeSoundPref(s, SOUND_NONE)
    expect(readSoundPref(s)).toBe(SOUND_NONE)
    expect(readSoundPref(broken)).toBe(WA_SOUND_DEFAULT)
    expect(() => writeSoundPref(broken, "bell")).not.toThrow()
    expect(readSoundPref(null)).toBe(WA_SOUND_DEFAULT)
  })
})

describe("what a live-update signal carries", () => {
  it("rings only for { inbound: n >= 1 }", () => {
    expect(inboundCountFromPayload({ inbound: 1 })).toBe(1)
    expect(inboundCountFromPayload({ inbound: 3 })).toBe(3)
    for (const odd of [null, undefined, {}, { inbound: 0 }, { inbound: -1 }, { inbound: "2" }, { inbound: 1.5 }, "x", 5, []]) {
      expect(inboundCountFromPayload(odd)).toBe(0)
    }
  })
})

describe("several tabs, one sound", () => {
  it("the first tab to claim an event plays; the others skip it", () => {
    const s = memory()
    expect(claimSoundEvent(s, "evt-1")).toBe(true)
    expect(claimSoundEvent(s, "evt-1")).toBe(false)
    expect(claimSoundEvent(s, "evt-2")).toBe(true)
  })
  it("no storage → play (a double beep is better than a missed message)", () => {
    expect(claimSoundEvent(broken, "evt-1")).toBe(true)
    expect(claimSoundEvent(null, "evt-1")).toBe(true)
    expect(claimSoundEvent(memory(), "")).toBe(true)
  })
})

describe("a burst rings once", () => {
  it("needs the minimum gap since this tab's last sound", () => {
    expect(gapElapsed(10_000, 0)).toBe(true)
    expect(gapElapsed(WA_SOUND_MIN_GAP_MS, 0)).toBe(true)
    expect(gapElapsed(WA_SOUND_MIN_GAP_MS - 1, 0)).toBe(false)
  })
})
