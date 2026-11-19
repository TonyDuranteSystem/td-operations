// The client iPhone app: an alert that arrives while the app is open refreshes the bar's numbers (dev job 056a70d0, 13 Nov 2026).
// Real case: Antonio had the app open, sent himself a chat message, saw the lock-screen alert but no red number on the Chat tab, because the bar was only
// asked again when the app came to the front, the address changed or a page finished loading. The rule itself is tested in ios/TDClient (`swift test`,
// AlertRefreshTests); these guards pin the wiring and the build number, which the Swift tests cannot see.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const read = (p: string) => readFileSync(join(__dirname, '..', '..', p), 'utf8')

describe('alert arrives while the app is open → the bar is asked again', () => {
  const app = read('ios/TDClient/App/TDClientApp.swift')
  const model = read('ios/TDClient/App/ClientModel.swift')
  const rules = read('ios/TDClient/Sources/TDClientCore/Rules.swift')

  it('the open-app alert handler asks the model to refresh, then still shows the banner', () => {
    const handler = app.slice(app.indexOf('willPresent'), app.indexOf('didReceive response'))
    expect(handler).toContain('alertArrivedWhileOpen()')
    expect(handler).toContain('[.banner, .list, .sound, .badge]')
    // the refresh is started before the options are returned, so the banner is never held up by it
    expect(handler.indexOf('alertArrivedWhileOpen()')).toBeLessThan(handler.indexOf('return [.banner'))
  })

  it('the model refreshes at every delay of the rule, and each refresh is its own task (the banner does not wait)', () => {
    const body = model.slice(model.indexOf('func alertArrivedWhileOpen()'), model.indexOf('func open(path'))
    expect(body).toContain('for delay in AlertRefreshRules.delays')
    expect(body).toContain('Task { @MainActor in')
    expect(body).toContain('await self.refreshMe()')
  })

  it('the rule asks at once and once more a few seconds later (the chat page marks a message read in between)', () => {
    expect(rules).toMatch(/public static let delays: \[TimeInterval\] = \[0, 4\]/)
  })

  it('the open(path:) doc comment still sits on open(path:), not on the new method', () => {
    expect(model).toMatch(/\/\/\/ Only a same-site path is ever opened[^\n]*\n    func open\(path: String\)/)
  })
})

describe('the next TestFlight build number', () => {
  it('the project generator defaults to build 9 (builds 7 and 8 are already uploaded)', () => {
    expect(read('ios/TDClient/generate_xcodeproj.rb')).toContain("(ENV['TD_BUILD'] || '9')")
  })
})
