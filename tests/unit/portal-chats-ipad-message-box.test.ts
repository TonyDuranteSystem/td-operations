/**
 * TD Social on the iPad (Antonio, 2026-11-26, dev job cb02b03d): with the keyboard open the message box ran under the keyboard (the lines being typed
 * were out of sight) and the yellow "Visible to everyone / Addressed to" card took a quarter of the visible screen. He chose "B": in the app nothing
 * sits above the box, the same notice (with the head-count) lives in the Before-you-send pop-up, and the box stops at about a third of the visible
 * screen. The website on a computer is unchanged.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  bucketVisibleHeight,
  COMPOSER_APP_FLOOR_PX,
  COMPOSER_MAX_PX,
  COMPOSER_MIN_PX,
  composerHeight,
  composerMaxHeight,
} from '@/lib/portal-chats/composer-height'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

describe('how tall the message box may grow', () => {
  it('the website keeps its 300 px cap whatever the window height', () => {
    expect(composerMaxHeight(340, false)).toBe(COMPOSER_MAX_PX)
    expect(composerMaxHeight(900, false)).toBe(COMPOSER_MAX_PX)
    expect(composerMaxHeight(null, false)).toBe(COMPOSER_MAX_PX)
  })

  it('in the app it is about a third of the visible height (the iPad with the keyboard open shows about 340 px)', () => {
    expect(composerMaxHeight(340, true)).toBe(102)
    expect(composerMaxHeight(400, true)).toBe(120)
  })

  it('in the app it never passes 300 px, even on a tall screen with no keyboard', () => {
    expect(composerMaxHeight(1000, true)).toBe(300)
    expect(composerMaxHeight(5000, true)).toBe(300)
  })

  it('in the app it never drops under about two lines, even on a very short screen (phone held sideways)', () => {
    expect(composerMaxHeight(150, true)).toBe(COMPOSER_APP_FLOOR_PX)
    expect(composerMaxHeight(1, true)).toBe(COMPOSER_APP_FLOOR_PX)
  })

  it('before the screen is measured (or on a bad reading) the app falls back to the normal cap, never to zero', () => {
    expect(composerMaxHeight(null, true)).toBe(COMPOSER_MAX_PX)
    expect(composerMaxHeight(0, true)).toBe(COMPOSER_MAX_PX)
    expect(composerMaxHeight(-20, true)).toBe(COMPOSER_MAX_PX)
    expect(composerMaxHeight(Number.NaN, true)).toBe(COMPOSER_MAX_PX)
    expect(composerMaxHeight(Number.POSITIVE_INFINITY, true)).toBe(COMPOSER_MAX_PX)
  })

  it('the box is as tall as its text, but not under the minimum and not over the cap', () => {
    expect(composerHeight(20, 300)).toBe(COMPOSER_MIN_PX)
    expect(composerHeight(120, 300)).toBe(120)
    expect(composerHeight(500, 300)).toBe(300)
    expect(composerHeight(500, 102)).toBe(102)
    expect(composerHeight(60, 102)).toBe(60)
  })

  it('a measured height is rounded to the nearest 10 px so a sliding keyboard does not redraw the page on every pixel', () => {
    expect(bucketVisibleHeight(337.4)).toBe(340)
    expect(bucketVisibleHeight(341)).toBe(340)
    expect(bucketVisibleHeight(344.6)).toBe(340)
    expect(bucketVisibleHeight(345)).toBe(350)
    expect(bucketVisibleHeight(2)).toBe(10)
  })
})

describe('wiring in the Portal Chats page', () => {
  const page = read('app/(dashboard)/portal-chats/page.tsx')

  it('both message boxes grow with the same cap, which follows the visible height only in the app', () => {
    expect(page).toContain("composerMaxHeight(useVisibleHeight(appMode), appMode)")
    expect((page.match(/composerHeight\(el\.scrollHeight, composerCap\)/g) ?? []).length).toBe(2)
    expect(page).toContain('[replyText, composerCap]')
    expect(page).toContain('[internalReplyText, composerCap]')
    // the old fixed 300 px growth is gone for the two big boxes
    expect(page).not.toMatch(/el\.style\.height = Math\.max\(44, Math\.min\(el\.scrollHeight, 300\)\)/)
  })

  it('the yellow card above the box is drawn only on the website, from the same trigger as the pop-up notice', () => {
    expect(page).toContain('{!appMode && showAudienceNotice && (')
    expect(page).toContain('const showAudienceNotice = !sendingToClosedAccount && !!audienceTargetId && (audienceTotal > 1 || selectedThreadMembers.length > 1 || addressedToOptions.length > 1)')
  })

  it('the Before-you-send pop-up carries the head-count in the app, for company chats as well as a person\'s chat', () => {
    expect(page).toContain('{appMode && showAudienceNotice && (')
    expect(page).toContain('data-testid="send-audience-notice"')
    expect(page).toContain('people see this:')
    // not shown twice: the older small line inside "Send as" stays on the website only
    expect(page).toContain('{!appMode && !sendingToClosedAccount && !!audienceTargetId && audienceTotal > 1 && (')
  })

  it('the notice never appears for a closed company (sending is blocked there anyway)', () => {
    expect(page).toMatch(/const showAudienceNotice = !sendingToClosedAccount &&/)
  })
})

describe('the visible-height hook', () => {
  const hook = read('lib/app-mode/use-visible-height.ts')

  it('does nothing on the website, reads the visual viewport (keyboard-aware) with the window as fallback, and cleans up', () => {
    expect(hook).toContain('if (!enabled)')
    expect(hook).toContain('window.visualViewport')
    expect(hook).toContain('?? window.innerHeight')
    expect(hook).toContain("removeEventListener('resize'")
  })
})
