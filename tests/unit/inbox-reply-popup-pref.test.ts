import { describe, it, expect } from "vitest"
import {
  REPLY_POPUP_PREF_KEY,
  readReplyPopupDefault,
  writeReplyPopupDefault,
  type PrefStorage,
} from "../../lib/inbox/reply-popup-pref"

function fakeStorage(initial: Record<string, string> = {}): PrefStorage & { data: Record<string, string> } {
  const data = { ...initial }
  return {
    data,
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => { data[k] = v },
    removeItem: (k) => { delete data[k] },
  }
}

const throwing: PrefStorage = {
  getItem: () => { throw new Error("blocked") },
  setItem: () => { throw new Error("blocked") },
  removeItem: () => { throw new Error("blocked") },
}

describe("reply pop-up preference", () => {
  it("is OFF when nothing was ever chosen", () => {
    expect(readReplyPopupDefault(fakeStorage())).toBe(false)
  })

  it("turns ON and OFF, and survives a re-read", () => {
    const s = fakeStorage()
    expect(writeReplyPopupDefault(true, s)).toBe(true)
    expect(s.data[REPLY_POPUP_PREF_KEY]).toBe("1")
    expect(readReplyPopupDefault(s)).toBe(true)
    expect(writeReplyPopupDefault(false, s)).toBe(true)
    expect(REPLY_POPUP_PREF_KEY in s.data).toBe(false)
    expect(readReplyPopupDefault(s)).toBe(false)
  })

  it("treats anything that is not the exact ON value as OFF (junk in storage never opens a pop-up)", () => {
    for (const junk of ["0", "true", "yes", "", "1 ", "null"]) {
      expect(readReplyPopupDefault(fakeStorage({ [REPLY_POPUP_PREF_KEY]: junk }))).toBe(false)
    }
  })

  it("never throws when storage is blocked — it just reads as OFF and reports the write failed", () => {
    expect(readReplyPopupDefault(throwing)).toBe(false)
    expect(writeReplyPopupDefault(true, throwing)).toBe(false)
    expect(writeReplyPopupDefault(false, throwing)).toBe(false)
  })

  it("is OFF / not stored when there is no storage at all (server rendering, private window)", () => {
    expect(readReplyPopupDefault(null)).toBe(false)
    expect(writeReplyPopupDefault(true, null)).toBe(false)
  })
})
