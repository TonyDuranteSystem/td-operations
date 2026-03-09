/**
 * OAuth 2.1 Authorization Endpoint
 * GET  /oauth/authorize — Shows login page
 * POST /oauth/authorize — Processes login + issues auth code
 *
 * Flow:
 * 1. Claude.ai redirects user here with client_id, redirect_uri, etc.
 * 2. User sees login form (email + PIN)
 * 3. User authenticates → auth code generated
 * 4. Redirect back to Claude.ai with code
 */

import { NextRequest, NextResponse } from "next/server"
import { validateClient, authenticateUser, createAuthCode } from "@/lib/oauth"

// ─── GET: Show authorization page ──────────────────────

export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams
  const clientId = params.get("client_id")
  const redirectUri = params.get("redirect_uri")
  const responseType = params.get("response_type")
  const state = params.get("state") || ""
  const scope = params.get("scope") || ""
  const codeChallenge = params.get("code_challenge") || ""
  const codeChallengeMethod = params.get("code_challenge_method") || "S256"

  // Validate params
  if (!clientId || !redirectUri || responseType !== "code") {
    return new Response(renderError("Missing or invalid parameters"), {
      status: 400,
      headers: { "Content-Type": "text/html" },
    })
  }

  // Validate client
  const client = await validateClient(clientId)
  if (!client) {
    return new Response(renderError("Unknown client application"), {
      status: 400,
      headers: { "Content-Type": "text/html" },
    })
  }

  // Validate redirect_uri
  if (!client.redirect_uris.includes(redirectUri)) {
    return new Response(renderError("Invalid redirect URI"), {
      status: 400,
      headers: { "Content-Type": "text/html" },
    })
  }

  // Render login form
  return new Response(
    renderLoginPage({
      clientName: client.client_name || "Unknown",
      clientId,
      redirectUri,
      state,
      scope,
      codeChallenge,
      codeChallengeMethod,
    }),
    { status: 200, headers: { "Content-Type": "text/html" } }
  )
}

// ─── POST: Process login ────────────────────────────────

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData()
    const email = formData.get("email") as string
    const pin = formData.get("pin") as string
    const clientId = formData.get("client_id") as string
    const redirectUri = formData.get("redirect_uri") as string
    const state = formData.get("state") as string
    const scope = formData.get("scope") as string
    const codeChallenge = formData.get("code_challenge") as string
    const codeChallengeMethod = formData.get("code_challenge_method") as string

    if (!email || !pin || !clientId || !redirectUri) {
      return new Response(renderError("Compila tutti i campi"), {
        status: 400,
        headers: { "Content-Type": "text/html" },
      })
    }

    // Validate client
    const client = await validateClient(clientId)
    if (!client || !client.redirect_uris.includes(redirectUri)) {
      return new Response(renderError("Client non valido"), {
        status: 400,
        headers: { "Content-Type": "text/html" },
      })
    }

    // Authenticate user
    const auth = await authenticateUser(email, pin)
    if (!auth.authenticated || !auth.userId) {
      return new Response(
        renderLoginPage({
          clientName: client.client_name || "Unknown",
          clientId,
          redirectUri,
          state,
          scope,
          codeChallenge,
          codeChallengeMethod,
          error: "Email o PIN non validi",
        }),
        { status: 401, headers: { "Content-Type": "text/html" } }
      )
    }

    // Create authorization code
    const code = await createAuthCode({
      clientId,
      redirectUri,
      userId: auth.userId,
      scope,
      codeChallenge: codeChallenge || undefined,
      codeChallengeMethod: codeChallengeMethod || undefined,
    })

    // Redirect back to Claude.ai with auth code
    const url = new URL(redirectUri)
    url.searchParams.set("code", code)
    if (state) url.searchParams.set("state", state)

    return NextResponse.redirect(url.toString(), 302)
  } catch (err) {
    console.error("[OAuth Authorize]", err)
    return new Response(renderError("Errore interno del server"), {
      status: 500,
      headers: { "Content-Type": "text/html" },
    })
  }
}

// ─── HTML Templates ─────────────────────────────────────

function renderLoginPage(params: {
  clientName: string
  clientId: string
  redirectUri: string
  state: string
  scope: string
  codeChallenge: string
  codeChallengeMethod: string
  error?: string
}): string {
  return `<!DOCTYPE html>
<html lang="it">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>TD Operations — Autorizzazione</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: #0a0a0a; color: #fafafa; min-height: 100vh;
      display: flex; align-items: center; justify-content: center;
    }
    .card {
      background: #171717; border: 1px solid #262626; border-radius: 12px;
      padding: 40px; width: 100%; max-width: 400px; box-shadow: 0 4px 24px rgba(0,0,0,0.4);
    }
    .logo { font-size: 24px; font-weight: 700; margin-bottom: 8px; }
    .subtitle { color: #a1a1aa; font-size: 14px; margin-bottom: 24px; }
    .client-badge {
      background: #1e3a5f; color: #60a5fa; padding: 6px 12px; border-radius: 6px;
      font-size: 13px; display: inline-block; margin-bottom: 24px;
    }
    label { display: block; font-size: 14px; color: #a1a1aa; margin-bottom: 6px; }
    input {
      width: 100%; padding: 10px 14px; background: #0a0a0a; border: 1px solid #333;
      border-radius: 8px; color: #fafafa; font-size: 15px; margin-bottom: 16px;
      outline: none; transition: border-color 0.2s;
    }
    input:focus { border-color: #3b82f6; }
    button {
      width: 100%; padding: 12px; background: #3b82f6; color: white; border: none;
      border-radius: 8px; font-size: 15px; font-weight: 600; cursor: pointer;
      transition: background 0.2s;
    }
    button:hover { background: #2563eb; }
    .error { background: #371520; color: #f87171; padding: 10px 14px; border-radius: 8px;
      font-size: 13px; margin-bottom: 16px; }
    .footer { color: #525252; font-size: 12px; text-align: center; margin-top: 20px; }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">TD Operations</div>
    <div class="subtitle">Autorizza accesso al sistema operativo</div>
    <div class="client-badge">📎 ${escapeHtml(params.clientName)}</div>
    ${params.error ? `<div class="error">⚠️ ${escapeHtml(params.error)}</div>` : ""}
    <form method="POST" action="/oauth/authorize">
      <input type="hidden" name="client_id" value="${escapeHtml(params.clientId)}">
      <input type="hidden" name="redirect_uri" value="${escapeHtml(params.redirectUri)}">
      <input type="hidden" name="state" value="${escapeHtml(params.state)}">
      <input type="hidden" name="scope" value="${escapeHtml(params.scope)}">
      <input type="hidden" name="code_challenge" value="${escapeHtml(params.codeChallenge)}">
      <input type="hidden" name="code_challenge_method" value="${escapeHtml(params.codeChallengeMethod)}">
      <label for="email">Email</label>
      <input type="email" id="email" name="email" placeholder="antonio@tonydurante.us" required autofocus>
      <label for="pin">PIN</label>
      <input type="password" id="pin" name="pin" placeholder="••••••" required>
      <button type="submit">Autorizza Accesso</button>
    </form>
    <div class="footer">Tony Durante LLC — Accesso riservato</div>
  </div>
</body>
</html>`
}

function renderError(message: string): string {
  return `<!DOCTYPE html>
<html lang="it">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>TD Operations — Errore</title>
  <style>
    body { font-family: sans-serif; background: #0a0a0a; color: #fafafa;
      min-height: 100vh; display: flex; align-items: center; justify-content: center; }
    .card { background: #171717; border: 1px solid #262626; border-radius: 12px;
      padding: 40px; max-width: 400px; text-align: center; }
    .error { color: #f87171; font-size: 18px; margin-bottom: 12px; }
    .detail { color: #a1a1aa; font-size: 14px; }
  </style>
</head>
<body>
  <div class="card">
    <div class="error">⚠️ Errore</div>
    <div class="detail">${escapeHtml(message)}</div>
  </div>
</body>
</html>`
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;")
}
