/**
 * Client-conversation form (Phase 2, dev_task 54f89912) — pure pieces.
 *
 * Pins the richer interactivity parser (the three modal payload shapes) and the
 * Block Kit builders, without touching Slack or the DB. The Stop-button parser
 * (parseSlackInteraction) is covered separately and must stay independent.
 */

import { describe, it, expect, vi } from "vitest"

// slack-claude.ts imports supabaseAdmin at module load — stub it so the import is clean.
vi.mock("@/lib/supabase-admin", () => ({ supabaseAdmin: { from: () => ({}) } }))

import {
  parseSlackInteractionFull,
  buildClientConversationModalView,
  buildClientConversationButtonBlocks,
  slugifyTopic,
  OPEN_CLIENT_CONVERSATION_ACTION_ID,
  CLIENT_CONVERSATION_MODAL_CALLBACK,
  CLIENT_SELECT_ACTION_ID,
  TOPIC_SELECT_ACTION_ID,
  NEW_TOPIC_BLOCK_ID,
  NEW_TOPIC_ACTION_ID,
} from "@/lib/ai-agent/slack-claude"

function body(payload: unknown): string {
  return new URLSearchParams({ payload: JSON.stringify(payload) }).toString()
}

describe("parseSlackInteractionFull", () => {
  it("returns null when there is no payload field", () => {
    expect(parseSlackInteractionFull("")).toBeNull()
  })

  it("parses a block_actions button click (trigger_id + channel)", () => {
    const r = parseSlackInteractionFull(
      body({
        type: "block_actions",
        trigger_id: "trg-1",
        channel: { id: "C123" },
        user: { id: "U999" },
        actions: [{ action_id: OPEN_CLIENT_CONVERSATION_ACTION_ID }],
      }),
    )
    expect(r?.type).toBe("block_actions")
    expect(r?.actionId).toBe(OPEN_CLIENT_CONVERSATION_ACTION_ID)
    expect(r?.triggerId).toBe("trg-1")
    expect(r?.channelId).toBe("C123")
    expect(r?.userId).toBe("U999")
  })

  it("parses a block_suggestion (external_select typing) with top-level action_id + value", () => {
    const r = parseSlackInteractionFull(
      body({ type: "block_suggestion", action_id: CLIENT_SELECT_ACTION_ID, value: "moj" }),
    )
    expect(r?.type).toBe("block_suggestion")
    expect(r?.actionId).toBe(CLIENT_SELECT_ACTION_ID)
    expect(r?.suggestionValue).toBe("moj")
  })

  it("parses a view_submission (callback, state, private_metadata=channel)", () => {
    const r = parseSlackInteractionFull(
      body({
        type: "view_submission",
        user: { id: "U999" },
        view: {
          callback_id: CLIENT_CONVERSATION_MODAL_CALLBACK,
          private_metadata: "C123",
          state: {
            values: {
              client_block: { [CLIENT_SELECT_ACTION_ID]: { selected_option: { value: "account:acc-1" } } },
              topic_block: { [TOPIC_SELECT_ACTION_ID]: { selected_option: { value: "banking" } } },
            },
          },
        },
      }),
    )
    expect(r?.type).toBe("view_submission")
    expect(r?.viewCallbackId).toBe(CLIENT_CONVERSATION_MODAL_CALLBACK)
    expect(r?.viewPrivateMetadata).toBe("C123")
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const vals = (r?.viewState as any)?.values
    expect(vals.client_block[CLIENT_SELECT_ACTION_ID].selected_option.value).toBe("account:acc-1")
    expect(vals.topic_block[TOPIC_SELECT_ACTION_ID].selected_option.value).toBe("banking")
  })
})

describe("buildClientConversationModalView", () => {
  it("builds a modal with the client external_select + topic static_select and channel in private_metadata", () => {
    const view = buildClientConversationModalView({
      channelId: "C123",
      topicOptions: [
        { slug: "banking", label: "Banking" },
        { slug: "tax", label: "Tax" },
      ],
    })
    expect(view.callback_id).toBe(CLIENT_CONVERSATION_MODAL_CALLBACK)
    expect(view.private_metadata).toBe("C123")
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const blocks = view.blocks as any[]
    const client = blocks.find((b) => b.block_id === "client_block")
    const topic = blocks.find((b) => b.block_id === "topic_block")
    expect(client.element.type).toBe("external_select")
    expect(client.element.action_id).toBe(CLIENT_SELECT_ACTION_ID)
    expect(topic.element.type).toBe("static_select")
    expect(topic.element.options.map((o: { value: string }) => o.value)).toEqual(["banking", "tax"])
    // Topic is optional because a new topic can be typed instead.
    expect(topic.optional).toBe(true)
    // The "or type a new topic" free-text field exists.
    const newTopic = blocks.find((b) => b.block_id === NEW_TOPIC_BLOCK_ID)
    expect(newTopic.optional).toBe(true)
    expect(newTopic.element.type).toBe("plain_text_input")
    expect(newTopic.element.action_id).toBe(NEW_TOPIC_ACTION_ID)
  })
})

describe("slugifyTopic", () => {
  it("lowercases and underscores free text into a catalog-safe slug", () => {
    expect(slugifyTopic("Wire Transfer")).toBe("wire_transfer")
    expect(slugifyTopic("  EIN / SS-4 ")).toBe("ein_ss_4")
    expect(slugifyTopic("Banking")).toBe("banking")
  })
  it("returns empty string for non-alphanumeric junk", () => {
    expect(slugifyTopic("!!!")).toBe("")
    expect(slugifyTopic("")).toBe("")
  })
})

describe("buildClientConversationButtonBlocks", () => {
  it("exposes a button carrying the open action_id", () => {
    const blocks = buildClientConversationButtonBlocks()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const actions = blocks.find((b: any) => b.type === "actions") as any
    expect(actions.elements[0].action_id).toBe(OPEN_CLIENT_CONVERSATION_ACTION_ID)
  })
})
