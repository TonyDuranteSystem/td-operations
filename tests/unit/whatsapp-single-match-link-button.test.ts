import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

// Antonio, 18 Nov 2026: the bar said "Matches an existing lead" but offered nothing to click. A single match now has a Link button, the same call the several-matches chooser makes.
const src = readFileSync(join(__dirname, '../../components/messaging/whatsapp-contact-match-banner.tsx'), 'utf8')
const single = src.slice(src.indexOf('if (data?.match) {'), src.indexOf('Same name as an existing client'))

describe('WhatsApp match bar, one match', () => {
  it('has a button that links the chat to that one person', () => {
    expect(single).toContain('data-testid="wa-link-match"')
    expect(single).toContain('handleLinkMatch(data.match as ContactMatch)')
  })
  it('only links on a click (no effect links by itself)', () => {
    expect(single).toContain('onClick=')
    expect(src).not.toMatch(/useEffect\([^)]*handleLinkMatch/)
  })
})
