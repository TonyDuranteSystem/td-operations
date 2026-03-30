/**
 * AI Provider abstraction — Claude (primary) + GPT-4o (fallback).
 * Handles tool-use loops for both providers.
 */
import { SYSTEM_PROMPT } from './system-prompt'

interface Message {
  role: 'user' | 'assistant'
  content: string
}

export interface Attachment {
  name: string
  type: string   // MIME type: image/png, image/jpeg, image/webp, application/pdf, text/csv, text/plain
  base64: string // raw base64 (no data: prefix)
}

interface AgentResponse {
  reply: string
  provider: 'claude' | 'openai'
  toolsUsed: string[]
}

// Build Claude multimodal content blocks for the last user message
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildClaudeContent(text: string, attachment: Attachment): any[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const blocks: any[] = []
  const fallbackText = text || `Please analyze this file: ${attachment.name}`

  if (attachment.type.startsWith('image/')) {
    blocks.push({
      type: 'image',
      source: { type: 'base64', media_type: attachment.type, data: attachment.base64 },
    })
    blocks.push({ type: 'text', text: fallbackText })
  } else if (attachment.type === 'application/pdf') {
    blocks.push({
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: attachment.base64 },
    })
    blocks.push({ type: 'text', text: fallbackText })
  } else {
    // TXT, CSV — decode and embed as text context
    const fileText = Buffer.from(attachment.base64, 'base64').toString('utf-8').slice(0, 50000)
    const combined = text
      ? `${text}\n\n--- Attached: ${attachment.name} ---\n${fileText}`
      : `Please analyze this file (${attachment.name}):\n\n${fileText}`
    blocks.push({ type: 'text', text: combined })
  }

  return blocks
}

// Build OpenAI multimodal content blocks for the last user message
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildOpenAIContent(text: string, attachment: Attachment): any[] {
  if (attachment.type.startsWith('image/')) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const blocks: any[] = []
    blocks.push({ type: 'text', text: text || `Please analyze this image: ${attachment.name}` })
    blocks.push({ type: 'image_url', image_url: { url: `data:${attachment.type};base64,${attachment.base64}` } })
    return blocks
  }

  // Non-image: decode to text (PDF not natively supported in OpenAI)
  let fileContent: string
  if (attachment.type === 'application/pdf') {
    fileContent = '[PDF attached — PDF analysis is best with Claude. Switch to Claude provider for better results.]'
  } else {
    fileContent = Buffer.from(attachment.base64, 'base64').toString('utf-8').slice(0, 50000)
  }

  const combined = text
    ? `${text}\n\n--- Attached: ${attachment.name} ---\n${fileContent}`
    : `Please analyze this file (${attachment.name}):\n\n${fileContent}`

  return [{ type: 'text', text: combined }]
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

async function callClaude(messages: Message[], attachment?: Attachment): Promise<AgentResponse> {
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
  let currentMessages: any[] = messages.map(m => ({ role: m.role, content: m.content }))

  // Inject attachment into last user message
  if (attachment) {
    const lastUserIdx = currentMessages.map(m => m.role).lastIndexOf('user')
    if (lastUserIdx >= 0) {
      currentMessages = [
        ...currentMessages.slice(0, lastUserIdx),
        { role: 'user', content: buildClaudeContent(currentMessages[lastUserIdx].content, attachment) },
        ...currentMessages.slice(lastUserIdx + 1),
      ]
    }
  }

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
        model: 'claude-haiku-4-5-20251001',
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

async function callOpenAI(messages: Message[], attachment?: Attachment): Promise<AgentResponse> {
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

  // Inject attachment into last user message
  if (attachment) {
    const lastUserIdx = currentMessages.map((m: { role: string }) => m.role).lastIndexOf('user')
    if (lastUserIdx >= 0) {
      currentMessages = [
        ...currentMessages.slice(0, lastUserIdx),
        { role: 'user', content: buildOpenAIContent(currentMessages[lastUserIdx].content, attachment) },
        ...currentMessages.slice(lastUserIdx + 1),
      ]
    }
  }

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

export async function callAgent(messages: Message[], forcedProvider?: string, attachment?: Attachment): Promise<AgentResponse> {
  // If a specific provider is forced
  if (forcedProvider === 'claude') {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not configured')
    return await callClaude(messages, attachment)
  }
  if (forcedProvider === 'openai') {
    if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY not configured')
    return await callOpenAI(messages, attachment)
  }

  // Auto mode: Try Claude first, fallback to OpenAI
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      return await callClaude(messages, attachment)
    } catch (err) {
      console.error('[ai-agent] Claude failed, falling back to OpenAI:', err instanceof Error ? err.message : err)
    }
  }

  // Fallback to OpenAI
  if (process.env.OPENAI_API_KEY) {
    try {
      return await callOpenAI(messages, attachment)
    } catch (err) {
      console.error('[ai-agent] OpenAI also failed:', err instanceof Error ? err.message : err)
      throw new Error('Both AI providers failed. Please try again later.')
    }
  }

  throw new Error('No AI provider configured. Add ANTHROPIC_API_KEY or OPENAI_API_KEY.')
}
