import { readFileSync } from 'fs'
import { describe, expect, it } from 'vitest'

// Dev job e3215801 (2026-10-29): on a Mac with the TD Operations app installed, Chrome opens "Open the workspace" in the installed app window, not a new tab.
// The code asks for a new tab, so the pop-up must not PROMISE one — it only says what is always true.
const SRC = readFileSync('components/storage/workspace-step-body.tsx', 'utf8')

describe('Storage pop-up wording: "Open the workspace"', () => {
  it('never promises a new tab', () => {
    expect(SRC).not.toMatch(/new tab/i)
  })
  it('still tells the person it opens the case and saves nothing here (both the guide-on and guide-off notes)', () => {
    expect(SRC.match(/opens the case(,| and) saves nothing here/g)?.length).toBe(2)
  })
})
