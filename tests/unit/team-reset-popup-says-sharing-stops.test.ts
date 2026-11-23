/**
 * The owner's Team page "Reset password" popup tells the person pressing it that personal-document sharing with that login stops
 * (a reset ends it — dev job e59dd470), and the list refreshes afterwards so the "sharing" marks read the new state.
 * The popup is a native confirm box, so this reads the source the screen is built from.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

const src = readFileSync(join(__dirname, '../../components/portal/team-manager.tsx'), 'utf8')
const resetPw = src.slice(src.indexOf('const resetPw = async'), src.indexOf('const switchPerson = async'))

describe('Team page: Reset password', () => {
  it('the popup says personal documents shared with the login stop being shared', () => {
    expect(resetPw).toMatch(/confirm\(`Reset \$\{name\}'s password\?/)
    expect(resetPw).toMatch(/personal documents shared with this login stop being shared/)
  })
  it('after a reset the list refreshes (the sharing marks must read the new state)', () => {
    expect(resetPw).toMatch(/setHandover\(\{ kind: 'reset'/)
    expect(resetPw).toMatch(/router\.refresh\(\)/)
  })
})
