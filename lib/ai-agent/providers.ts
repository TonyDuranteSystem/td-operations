/**
 * AI Provider abstraction — Claude (primary) + GPT-4o (fallback).
 * Handles tool-use loops for both providers.
 */
import { SYSTEM_PROMPT } from './system-prompt'

interface Message {
  role: 'user' | 'assistant'
  content: string
}

interface AgentResponse {
  reply: string
  provider: 'claude' | 'openai'
  toolsUsed: string[]
}

// Max tool-use iterations to prevent infinite loops
const MAX_TOOL_LOOPS = 8

// ============================================================
// Shared Tool definitions + execution (imported lazily)
// ============================================================

async function getTools() {
  const { AGENT_TOOLS, executeTool } = await import('./tools')
  return { AGENT_TOOLS, executeTool }
}

// ============================================================
// CLAUDE (Anthropic) — Primary Provider
// ============================================================

async function callClaude(messages: Message[]): Promise<AgentResponse> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured')

  const { AGENT_TOOLS, executeTool } = await getTools()

  // Convert tools to Claude format
  const claudeTools = AGENT_TOOLS.map(t => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters,
  }))

  const toolsUsed: string[] = []
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let currentMessages: any[] = messages.map(m => ({
    role: m.role,
    content: m.content,
  }))

  for (let i = 0; i < MAX_TOOL_LOOPS; i++) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 55_000)

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2048,
        system: SYSTEM_PROMPT,
        tools: claudeTools,
        messages: currentMessages,
      }),
      signal: controller.signal,
    })
    clearTimeout(timeout)

    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error(`Claude API error ${res.status}: ${JSON.stringify(err)}`)
    }

    const data = await res.json()

    // Check if the model wants to use tools
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const toolUseBlocks = data.content.filter((b: any) => b.type === 'tool_use')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const textBlocks = data.content.filter((b: any) => b.type === 'text')

    if (toolUseBlocks.length === 0 || data.stop_reason === 'end_turn') {
      // No tools or end_turn — return text response
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const reply = textBlocks.map((b: any) => b.text).join('\n') || ''

      // If there are tool results pending but also text, return the text
      if (reply) return { reply, provider: 'claude', toolsUsed }

      // Edge case: no text and no tools
      if (toolUseBlocks.length === 0) {
        return { reply: 'No response generated.', provider: 'claude', toolsUsed }
      }
    }

    // Execute tools
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const toolResults: any[] = []
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const toolBlock of toolUseBlocks) {
      toolsUsed.push(toolBlock.name)
      const result = await executeTool(toolBlock.name, toolBlock.input || {})
      toolResults.push({
        type: 'tool_result',
        tool_use_id: toolBlock.id,
        content: result,
      })
    }

    // Add assistant message with tool use + tool results
    currentMessages = [
      ...currentMessages,
      { role: 'assistant', content: data.content },
      { role: 'user', content: toolResults },
    ]
  }

  return { reply: 'Reached maximum tool iterations. Please try a simpler request.', provider: 'claude', toolsUsed }
}

// ============================================================
// GPT-4o (OpenAI) — Fallback Provider
// ============================================================

async function callOpenAI(messages: Message[]): Promise<AgentResponse> {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) throw new Error('OPENAI_API_KEY not configured')

  const { AGENT_TOOLS, executeTool } = await getTools()

  // Convert tools to OpenAI format
  const openaiTools = AGENT_TOOLS.map(t => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }))

  const toolsUsed: string[] = []
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let currentMessages: any[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...messages.map(m => ({ role: m.role, content: m.content })),
  ]

  for (let i = 0; i < MAX_TOOL_LOOPS; i++) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 55_000)

    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: currentMessages,
        tools: openaiTools,
        max_tokens: 2048,
        temperature: 0.3,
      }),
      signal: controller.signal,
    })
    clearTimeout(timeout)

    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error(`OpenAI API error ${res.status}: ${JSON.stringify(err)}`)
    }

    const data = await res.json()
    const choice = data.choices?.[0]
    if (!choice) throw new Error('No response from OpenAI')

    // Check for tool calls
    if (choice.finish_reason === 'tool_calls' || choice.message?.tool_calls?.length) {
      const toolCalls = choice.message.tool_calls || []
      currentMessages = [...currentMessages, choice.message]

      for (const tc of toolCalls) {
        toolsUsed.push(tc.function.name)
        let args = {}
        try { args = JSON.parse(tc.function.arguments || '{}') } catch { /* empty */ }
        const result = await executeTool(tc.function.name, args)
        currentMessages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: result,
        })
      }
      continue
    }

    // No tools — return text
    const reply = choice.message?.content?.trim() || 'No response generated.'
    return { reply, provider: 'openai', toolsUsed }
  }

  return { reply: 'Reached maximum tool iterations. Please try a simpler request.', provider: 'openai', toolsUsed }
}

// ============================================================
// Main Entry — Claude first, fallback to OpenAI
// ============================================================

export async function callAgent(messages: Message[]): Promise<AgentResponse> {
  // Try Claude first
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      return await callClaude(messages)
    } catch (err) {
      console.error('[ai-agent] Claude failed, falling back to OpenAI:', err instanceof Error ? err.message : err)
    }
  }

  // Fallback to OpenAI
  if (process.env.OPENAI_API_KEY) {
    try {
      return await callOpenAI(messages)
    } catch (err) {
      console.error('[ai-agent] OpenAI also failed:', err instanceof Error ? err.message : err)
      throw new Error('Both AI providers failed. Please try again later.')
    }
  }

  throw new Error('No AI provider configured. Add ANTHROPIC_API_KEY or OPENAI_API_KEY.')
}
