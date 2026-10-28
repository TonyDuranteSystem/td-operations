import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'

// Opening a TD Talk chat must not download the chat's old voice notes (Antonio 2026-10-28: "every time I open TD Talk the
// system downloads all old audios and the new one is late"). These are source guards: the project has no jsdom to render the player.
const read = (p: string) => readFileSync(p, 'utf8')

describe('voice note loading', () => {
  const player = read('components/team-chat/voice-note.tsx')
  const list = read('components/talk/talk-messages.tsx')

  it('fetches nothing for a note that is far off screen', () => {
    expect(player).toContain("preload={near ? (eager ? 'auto' : 'metadata') : 'none'}")
  })

  it('never loads a whole old note ahead of the tap — only the eager (newest) one', () => {
    // 'auto' may only appear behind the eager flag
    const autos = player.match(/'auto'/g) ?? []
    expect(autos).toHaveLength(1)
    expect(player).toContain("eager ? 'auto'")
  })

  it('TD Talk marks only the newest voice-note message as eager', () => {
    expect(list).toContain('const newestVoiceId = [...messages].reverse().find(')
    expect(list).toContain('eager={m.id === newestVoiceId}')
    // the list passes the id down to every bubble, it is not a prop supplied from outside
    expect(list).toContain('newestVoiceId={newestVoiceId}')
  })
})

describe('new uploads are cacheable', () => {
  it('the direct upload sends a one-year cache lifetime (every file has its own never-reused address)', () => {
    const up = read('lib/team/attachment.ts')
    expect(up).toContain("'cache-control': 'max-age=31536000'")
    expect(read('app/api/team/upload-url/route.ts')).toContain('randomUUID()')
  })
})
