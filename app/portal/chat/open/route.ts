import { NextRequest, NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { createClient } from '@/lib/supabase/server'
import { getClientContactId } from '@/lib/portal-auth'
import { getChatEntities } from '@/lib/portal/queries'
import { chatPathForTopic, entityCookieWrites, resolveChatEntityFromLink } from '@/lib/portal/chat-link'

/**
 * GET /portal/chat/open?account=<id|personal>&topic=<name>
 *
 * Entry point of every "new message" link — email, bell, push, digest (dev job
 * 05d997f2). Saves the linked company with the company switcher's own cookies,
 * then redirects to /portal/chat (on the linked tab), so the sidebar, the chat
 * and the saved selection all agree from the first render and nothing company-
 * related is left in the address bar to override the client's next switch.
 *
 * Only the client's OWN entities are honoured; anything else (unknown id,
 * another client's company, teammates, signed-out users) just opens the chat
 * with the current selection. Signed-out users are sent to login by the portal
 * middleware like any other /portal page.
 */
export async function GET(request: NextRequest) {
  const accountParam = request.nextUrl.searchParams.get('account')
  const topic = request.nextUrl.searchParams.get('topic')
  // RELATIVE Location on purpose: the browser resolves it against the exact
  // address it requested, so the client always stays on the host they came in
  // on (portal domain, preview URL, or a local dev host — Next's own absolute
  // URLs normalise 127.0.0.1 to localhost in dev, which changes the cookie jar).
  const response = new NextResponse(null, { status: 307, headers: { Location: chatPathForTopic(topic) } })

  try {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    const contactId = user ? getClientContactId(user) : null
    if (!contactId || !accountParam) return response

    const entities = await getChatEntities(contactId)
    const cookieStore = await cookies()
    const byId = new Map(entities.map(e => [e.id, e]))
    const formationId = cookieStore.get('portal_formation')?.value
    const accountId = cookieStore.get('portal_account_id')?.value
    // Same precedence as the chat page and the sidebar switcher.
    const current =
      (formationId ? byId.get(formationId) : undefined) ??
      (accountId ? byId.get(accountId) : undefined) ??
      entities[0]

    const linked = resolveChatEntityFromLink(entities, accountParam, current)
    if (linked) {
      for (const c of entityCookieWrites(linked)) {
        response.cookies.set(c.name, c.value, { path: '/portal', maxAge: c.maxAge, sameSite: 'lax' })
      }
    }
  } catch (err) {
    // Never strand the client on an error page for a convenience link.
    console.error('[portal/chat/open] could not apply linked company:', err)
  }
  return response
}
