export interface AIRequest {
  systemPrompt: string
  userPrompt: string
  maxTokens: number
  temperature: number
}

export interface AIResult {
  text: string
  provider: 'anthropic' | 'openai'
}

const ANTHROPIC_TIMEOUT_MS = 5_000
const OPENAI_TIMEOUT_MS = 20_000

/**
 * Call Claude Haiku (primary). Throws on error or timeout.
 */
async function callAnthropic(req: AIRequest): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured')

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), ANTHROPIC_TIMEOUT_MS)

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: req.maxTokens,
        system: req.systemPrompt,
        messages: [{ role: 'user', content: req.userPrompt }],
        temperature: req.temperature,
      }),
      signal: controller.signal,
    })

    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error(`Anthropic API error ${res.status}: ${JSON.stringify(err)}`)
    }

    const data = await res.json()
    const text = data.content?.[0]?.text?.trim()
    if (!text) throw new Error('Empty response from Anthropic')
    return text
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * Call GPT-4o-mini (fallback). Throws on error or timeout.
 */
async function callOpenAI(req: AIRequest): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) throw new Error('OPENAI_API_KEY not configured')

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS)

  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: req.systemPrompt },
          { role: 'user', content: req.userPrompt },
        ],
        max_tokens: req.maxTokens,
        temperature: req.temperature,
      }),
      signal: controller.signal,
    })

    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error(`OpenAI API error ${res.status}: ${JSON.stringify(err)}`)
    }

    const data = await res.json()
    const text = data.choices?.[0]?.message?.content?.trim()
    if (!text) throw new Error('Empty response from OpenAI')
    return text
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * Call AI with automatic failover: Claude Haiku (primary) → GPT-4o-mini (fallback).
 * Logs which provider was used for monitoring.
 */
export async function callAI(req: AIRequest): Promise<AIResult> {
  try {
    const text = await callAnthropic(req)
    console.warn('[ai-provider] Used: anthropic/claude-haiku-4-5-20251001')
    return { text, provider: 'anthropic' }
  } catch (primaryErr) {
    console.error('[ai-provider] Anthropic failed, falling back to OpenAI:', primaryErr instanceof Error ? primaryErr.message : primaryErr)
    try {
      const text = await callOpenAI(req)
      console.warn('[ai-provider] Used: openai/gpt-4o-mini (fallback)')
      return { text, provider: 'openai' }
    } catch (fallbackErr) {
      console.error('[ai-provider] Both providers failed. OpenAI error:', fallbackErr instanceof Error ? fallbackErr.message : fallbackErr)
      throw new Error('All AI providers failed')
    }
  }
}
