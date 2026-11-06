import { describe, it, expect } from 'vitest'
import { suggestedSaveName } from '@/lib/messaging/name-match'

const KEY = '17168461312@c.us'

describe('suggestedSaveName (the name the save form starts with)', () => {
  it('uses the phone-saved name', () => {
    expect(suggestedSaveName('Irshad', [], KEY)).toBe('Irshad')
  })
  it('falls back to the name the sender uses', () => {
    expect(suggestedSaveName(null, ['Irshad'], KEY)).toBe('Irshad')
  })
  it('prefers the phone-saved name over the sender name', () => {
    expect(suggestedSaveName('Irshad Khan', ['irshad k'], KEY)).toBe('Irshad Khan')
  })
  it('gives nothing for junk: empty, digits, our own business name, TD Team, Unknown', () => {
    expect(suggestedSaveName('', [], KEY)).toBeNull()
    expect(suggestedSaveName('+17168461312', [], KEY)).toBeNull()
    expect(suggestedSaveName('Tony Durante LLC', ['TD Team', 'Unknown', null], KEY)).toBeNull()
  })
  it('skips a junk saved name and takes the first real sender name', () => {
    expect(suggestedSaveName('+17168461312', ['Tony Durante LLC', 'Irshad'], KEY)).toBe('Irshad')
  })
  it('trims spaces', () => {
    expect(suggestedSaveName('  Irshad  ', [], KEY)).toBe('Irshad')
  })
})
