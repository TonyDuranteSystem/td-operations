import { describe, expect, it } from "vitest"
import { isSound, meterFill, rmsOf, SOUND_THRESHOLD } from "@/lib/media/sound-level"

describe("is the microphone hearing anything?", () => {
  it("exact silence (a muted or wrong input device) is not sound, an empty slice neither", () => {
    expect(rmsOf(new Float32Array(1024))).toBe(0)
    expect(rmsOf([])).toBe(0)
    expect(isSound(0)).toBe(false)
    expect(isSound(rmsOf(new Float32Array(1024)))).toBe(false)
  })
  it("a quiet voice and a loud voice are sound", () => {
    const wave = (amp: number) => Float32Array.from({ length: 1024 }, (_, i) => amp * Math.sin(i / 7))
    expect(isSound(rmsOf(wave(0.02)))).toBe(true)
    expect(isSound(rmsOf(wave(0.5)))).toBe(true)
  })
  it("faint hiss just under the line is not sound, just over it is", () => {
    expect(isSound(SOUND_THRESHOLD * 0.9)).toBe(false)
    expect(isSound(SOUND_THRESHOLD)).toBe(true)
  })
  it("never trusts a number that is not a number", () => {
    expect(isSound(Number.NaN)).toBe(false)
    expect(meterFill(Number.NaN)).toBe(0)
    expect(meterFill(-1)).toBe(0)
  })
  it("the bar shows speech and never overflows", () => {
    expect(meterFill(0)).toBe(0)
    expect(meterFill(0.05)).toBeGreaterThan(0.3)
    expect(meterFill(1)).toBe(1)
  })
})
