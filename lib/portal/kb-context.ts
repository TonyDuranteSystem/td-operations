import { supabaseAdmin } from '@/lib/supabase-admin'

interface KBResult {
  articles: Array<{ title: string; category: string; content: string }>
  responses: Array<{ title: string; category: string; service_type: string | null; response_text: string; tags: string[] | null }>
}

/**
 * Fetch relevant KB articles and approved responses for AI context.
 * Uses keyword matching against both tables.
 */
export async function fetchKBContext(query: string): Promise<string> {
  if (!query?.trim()) return ''

  const [articlesResult, responsesResult] = await Promise.all([
    supabaseAdmin
      .from('knowledge_articles')
      .select('title, category, content')
      .or(`title.ilike.%${query}%,content.ilike.%${query}%`)
      .limit(3),

    supabaseAdmin
      .from('approved_responses')
      .select('title, category, service_type, response_text, tags')
      .or(`title.ilike.%${query}%,response_text.ilike.%${query}%`)
      .limit(3),
  ])

  const kb: KBResult = {
    articles: articlesResult.data ?? [],
    responses: responsesResult.data ?? [],
  }

  const sections: string[] = []

  if (kb.articles.length > 0) {
    sections.push(
      'BUSINESS RULES & KNOWLEDGE (from KB):\n' +
      kb.articles
        .map(a => `[${a.category}] ${a.title}:\n${a.content.slice(0, 400)}`)
        .join('\n\n')
    )
  }

  if (kb.responses.length > 0) {
    sections.push(
      'APPROVED RESPONSE TEMPLATES (match Antonio\'s tone exactly):\n' +
      kb.responses
        .map(r => {
          const meta = [r.category, r.service_type].filter(Boolean).join(' / ')
          return `[${meta}] ${r.title}:\n"${r.response_text.slice(0, 400)}"`
        })
        .join('\n\n')
    )
  }

  return sections.join('\n\n')
}

/**
 * Extract a search query from the last client message and account context.
 */
export function buildKBQuery(lastMessage: string, extraKeywords: string[] = []): string {
  // Take first 80 chars of last message + any extra keywords
  const msgPart = lastMessage.trim().slice(0, 80)
  const keywords = extraKeywords.filter(Boolean).join(' ')
  return [msgPart, keywords].filter(Boolean).join(' ').slice(0, 120)
}
