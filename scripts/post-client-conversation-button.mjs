#!/usr/bin/env node
/**
 * One-off: post + pin the "➕ New client conversation" button in #td-support.
 *
 * The button MUST be posted by the Claude bot (app A0B9LUJRLMB) so its click
 * routes to that app's interactivity endpoint (/api/webhooks/slack-interactions).
 * Posting it from any other app/token would send clicks somewhere else.
 *
 * action_id MUST equal OPEN_CLIENT_CONVERSATION_ACTION_ID in lib/ai-agent/slack-claude.ts.
 *
 * Usage:
 *   SLACK_BOT_TOKEN_CLAUDE=xoxb-... node scripts/post-client-conversation-button.mjs [channelId]
 *   (channelId defaults to SLACK_SUPPORT_CHANNEL_ID, else C0BA802S9LH = #td-support)
 */

const TOKEN = process.env.SLACK_BOT_TOKEN_CLAUDE
const CHANNEL = process.argv[2] || process.env.SLACK_SUPPORT_CHANNEL_ID || "C0BA802S9LH"
const OPEN_ACTION_ID = "open_client_conversation"

if (!TOKEN) {
  console.error("❌ SLACK_BOT_TOKEN_CLAUDE not set (must be the Claude bot token, xoxb-…).")
  process.exit(1)
}

const blocks = [
  {
    type: "section",
    text: {
      type: "mrkdwn",
      text: "*Client conversations* — start one tagged by client + topic so it's saved in the CRM.",
    },
  },
  {
    type: "actions",
    elements: [
      {
        type: "button",
        text: { type: "plain_text", text: "➕ New client conversation", emoji: true },
        action_id: OPEN_ACTION_ID,
        style: "primary",
        value: OPEN_ACTION_ID,
      },
    ],
  },
]

async function slack(method, body) {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  return res.json()
}

const post = await slack("chat.postMessage", {
  channel: CHANNEL,
  text: "Start a new client conversation",
  blocks,
})
if (!post.ok) {
  console.error(`❌ chat.postMessage failed: ${post.error}`)
  process.exit(1)
}
console.log(`✅ Posted button to ${CHANNEL} (ts=${post.ts})`)

const pin = await slack("pins.add", { channel: CHANNEL, timestamp: post.ts })
if (!pin.ok) {
  console.warn(`⚠️  Posted but pin failed: ${pin.error} (you can pin it manually).`)
} else {
  console.log("📌 Pinned.")
}
