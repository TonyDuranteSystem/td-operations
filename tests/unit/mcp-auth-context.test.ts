import { describe, it, expect, afterEach } from 'vitest'
import {
  parseAdditionalStaticKeys,
  resolveAdditionalStaticKeyEmail,
  runWithMcpAuthContext,
  callerIsOwner,
  actingEmailForTeamChat,
} from '@/lib/mcp/auth-context'

const OWNER_EMAIL = 'antonio.durante@tonydurante.us'

describe('parseAdditionalStaticKeys', () => {
  it('returns an empty map when unset', () => {
    expect(parseAdditionalStaticKeys(undefined)).toEqual({})
  })

  it('parses a valid JSON object of email -> key', () => {
    expect(parseAdditionalStaticKeys('{"luca@tonydurante.us":"secret-1"}')).toEqual({
      'luca@tonydurante.us': 'secret-1',
    })
  })

  it('treats malformed JSON as no additional keys, not a crash', () => {
    expect(() => parseAdditionalStaticKeys('not json')).not.toThrow()
    expect(parseAdditionalStaticKeys('not json')).toEqual({})
  })

  it('rejects a JSON array or primitive — must be an object', () => {
    expect(parseAdditionalStaticKeys('["a","b"]')).toEqual({})
    expect(parseAdditionalStaticKeys('"just a string"')).toEqual({})
    expect(parseAdditionalStaticKeys('42')).toEqual({})
  })
})

describe('resolveAdditionalStaticKeyEmail', () => {
  afterEach(() => {
    delete process.env.TD_MCP_ADDITIONAL_KEYS
  })

  it('returns null when no additional keys are configured', () => {
    delete process.env.TD_MCP_ADDITIONAL_KEYS
    expect(resolveAdditionalStaticKeyEmail('anything')).toBeNull()
  })

  it("resolves the matching person's email for their own key", () => {
    process.env.TD_MCP_ADDITIONAL_KEYS = JSON.stringify({
      'luca@tonydurante.us': 'luca-secret',
      'other@tonydurante.us': 'other-secret',
    })
    expect(resolveAdditionalStaticKeyEmail('luca-secret')).toBe('luca@tonydurante.us')
    expect(resolveAdditionalStaticKeyEmail('other-secret')).toBe('other@tonydurante.us')
  })

  it('returns null for a token that matches no configured key', () => {
    process.env.TD_MCP_ADDITIONAL_KEYS = JSON.stringify({ 'luca@tonydurante.us': 'luca-secret' })
    expect(resolveAdditionalStaticKeyEmail('not-a-real-key')).toBeNull()
  })
})

describe('callerIsOwner — the SAME check regardless of auth method', () => {
  it('is false with no context at all', () => {
    expect(callerIsOwner()).toBe(false)
  })

  it('is true for a static-method context whose resolved email is the owner', () => {
    runWithMcpAuthContext({ method: 'static', email: OWNER_EMAIL }, () => {
      expect(callerIsOwner()).toBe(true)
    })
  })

  it('is false for a static-method context resolved to someone else — the whole point of the fix', () => {
    runWithMcpAuthContext({ method: 'static', email: 'luca@tonydurante.us' }, () => {
      expect(callerIsOwner()).toBe(false)
    })
  })

  it('is true for an oauth-method context whose email is the owner', () => {
    runWithMcpAuthContext({ method: 'oauth', email: OWNER_EMAIL }, () => {
      expect(callerIsOwner()).toBe(true)
    })
  })

  it('is false when email is missing, regardless of method', () => {
    runWithMcpAuthContext({ method: 'static', email: null }, () => {
      expect(callerIsOwner()).toBe(false)
    })
    runWithMcpAuthContext({ method: 'oauth' }, () => {
      expect(callerIsOwner()).toBe(false)
    })
  })

  it('is case- and whitespace-insensitive on the owner email', () => {
    runWithMcpAuthContext({ method: 'static', email: '  Antonio.Durante@TonyDurante.us  ' }, () => {
      expect(callerIsOwner()).toBe(true)
    })
  })
})

describe('actingEmailForTeamChat — static and oauth resolve identically', () => {
  it('returns null with no context', () => {
    expect(actingEmailForTeamChat()).toBeNull()
  })

  it("returns the resolved person's email for a static context, not a hardcoded default", () => {
    runWithMcpAuthContext({ method: 'static', email: 'luca@tonydurante.us' }, () => {
      expect(actingEmailForTeamChat()).toBe('luca@tonydurante.us')
    })
  })

  it('returns the resolved email for an oauth context the same way', () => {
    runWithMcpAuthContext({ method: 'oauth', email: 'someone@tonydurante.us' }, () => {
      expect(actingEmailForTeamChat()).toBe('someone@tonydurante.us')
    })
  })

  it('returns null when the context carries no email, for either method', () => {
    runWithMcpAuthContext({ method: 'static', email: null }, () => {
      expect(actingEmailForTeamChat()).toBeNull()
    })
    runWithMcpAuthContext({ method: 'oauth' }, () => {
      expect(actingEmailForTeamChat()).toBeNull()
    })
  })
})
