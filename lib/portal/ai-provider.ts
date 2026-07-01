/**
 * Shared AI provider for all in-app AI features.
 *
 * POLICY (2026-06-30, Antonio's directive): Sonnet or Opus ONLY. No Haiku, no
 * GPT/OpenAI. Client-facing and internal AI content must come from a top-tier
 * Anthropic model. Failover is Anthropic-internal: primary model → the other
 * Anthropic model (Sonnet ⇄ Opus). There is intentionally no cross-provider
 * (OpenAI) fallback anymore.
 *
 * TEMPERATURE SHAPING (critical): Opus 4.7+ REJECTS the `temperature` sampling
 * parameter with a 400. Sonnet 4.6 accepts it. So `temperature` is sent only to
 * models in MODELS_ACCEPTING_TEMPERATURE — never to Opus.
 *
 * TIMEOUTS: callers generating large outputs (e.g. the offer narrative, ~4096
 * tokens) must pass an explicit `timeoutMs` AND set a matching route
 * `maxDuration`, because a big Sonnet generation runs well past the small
 * default. The default was too short and silently timed the offer narrative out.
 */

export interface AIRequest {
  systemPrompt: string
  userPrompt: string
  maxTokens: number
  temperature: number
  /**
   * Primary Anthropic model. Defaults to 'sonnet'. Only 'sonnet' | 'opus' are
   * allowed — Haiku is intentionally not an option (policy above).
   */
  model?: 'sonnet' | 'opus'
  /**
   * Optional per-call timeout for EACH Anthropic attempt (primary and fallback),
   * in ms. Omit for the default. Large-output callers should raise this and set
   * a matching route `maxDuration`.
   */
  timeoutMs?: number
}

export interface AIResult {
  text: string
  provider: 'anthropic'
  /** Which Anthropic model actually produced the text. */
  model: 'sonnet' | 'opus'
}

// Anthropic model IDs keyed by the friendly name passed in AIRequest.model.
const ANTHROPIC_MODELS = {
  sonnet: 'claude-sonnet-4-6',
  opus: 'claude-opus-4-8',
} as const

type ModelKey = keyof typeof ANTHROPIC_MODELS

// Default per-attempt timeout. Kept moderate for the frequent small-output
// callers (chat polish, suggestions — they finish in a few seconds). Large-output
// callers override via req.timeoutMs.
const DEFAULT_TIMEOUT_MS = 30_000

// Models that accept the `temperature` sampling parameter. Opus 4.7+ 400s on it.
const MODELS_ACCEPTING_TEMPERATURE: ReadonlySet<ModelKey> = new Set<ModelKey>(['sonnet'])

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/**
 * Call one Anthropic model. Throws on error or timeout.
 * `temperature` is included only for models that accept it (never Opus).
 */
async function callAnthropic(req: AIRequest, modelKey: ModelKey): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured')

  const modelId = ANTHROPIC_MODELS[modelKey]
  const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS

  const body: Record<string, unknown> = {
    model: modelId,
    max_tokens: req.maxTokens,
    system: req.systemPrompt,
    messages: [{ role: 'user', content: req.userPrompt }],
  }
  if (MODELS_ACCEPTING_TEMPERATURE.has(modelKey)) {
    body.temperature = req.temperature
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })

    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error(`Anthropic API error ${res.status} (${modelId}): ${JSON.stringify(err)}`)
    }

    const data = await res.json()
    const text = data.content?.[0]?.text?.trim()
    if (!text) throw new Error(`Empty response from Anthropic (${modelId})`)
    return text
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') {
      throw new Error(`Anthropic timed out after ${timeoutMs}ms (${modelId})`)
    }
    throw e
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * Call AI with Anthropic-internal failover: primary model → the other model.
 * Sonnet ⇄ Opus only. No Haiku, no OpenAI. On total failure, throws an error
 * whose message carries BOTH underlying causes so the caller can surface it
 * (no more opaque "AI generation failed").
 */
export async function callAI(req: AIRequest): Promise<AIResult> {
  const primary: ModelKey = req.model ?? 'sonnet'
  const fallback: ModelKey = primary === 'sonnet' ? 'opus' : 'sonnet'

  try {
    const text = await callAnthropic(req, primary)
    console.warn(`[ai-provider] Used: anthropic/${ANTHROPIC_MODELS[primary]}`)
    return { text, provider: 'anthropic', model: primary }
  } catch (primaryErr) {
    console.error(`[ai-provider] ${primary} failed, falling back to ${fallback}:`, errMsg(primaryErr))
    try {
      const text = await callAnthropic(req, fallback)
      console.warn(`[ai-provider] Used: anthropic/${ANTHROPIC_MODELS[fallback]} (fallback)`)
      return { text, provider: 'anthropic', model: fallback }
    } catch (fallbackErr) {
      const detail = `${primary}: ${errMsg(primaryErr)} | ${fallback}: ${errMsg(fallbackErr)}`
      console.error('[ai-provider] Both Anthropic models failed:', detail)
      throw new Error(`All AI models failed — ${detail}`)
    }
  }
}
