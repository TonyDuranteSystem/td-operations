/**
 * Calendly MCP Tools
 * List bookings, check availability, get event details.
 * Uses Personal Access Token (PAT) for auth.
 *
 * User: antoniodurante (antonio.durante@tonydurante.us)
 * Organization: 2d681251-a657-4ec8-b3b5-3189992b21ac
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"

// ─── Configuration ──────────────────────────────────────────

const CALENDLY_API = "https://api.calendly.com"
const USER_UUID = "e163f002-89ba-4999-a32c-40aabf1f8173"
const USER_URI = `${CALENDLY_API}/users/${USER_UUID}`
const ORG_URI = `${CALENDLY_API}/organizations/2d681251-a657-4ec8-b3b5-3189992b21ac`

function getToken(): string {
  const token = process.env.CALENDLY_PAT
  if (!token) throw new Error("CALENDLY_PAT not configured")
  return token
}

// ─── API Helper ─────────────────────────────────────────────

async function calendlyGet(endpoint: string, params?: Record<string, string>) {
  const token = getToken()
  const url = new URL(`${CALENDLY_API}${endpoint}`)
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v) url.searchParams.set(k, v)
    }
  }

  const res = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Calendly API ${res.status}: ${err}`)
  }

  return res.json()
}

// ─── Types ──────────────────────────────────────────────────

interface CalendlyEvent {
  uri: string
  name: string
  status: string
  start_time: string
  end_time: string
  event_type: string
  location?: {
    type: string
    location?: string
    join_url?: string
  }
  invitees_counter: {
    total: number
    active: number
    limit: number
  }
  created_at: string
  updated_at: string
  cancellation?: {
    canceled_by: string
    reason?: string
  }
}

interface CalendlyInvitee {
  uri: string
  email: string
  name: string
  status: string
  created_at: string
  questions_and_answers?: Array<{
    question: string
    answer: string
  }>
  timezone?: string
  cancel_url?: string
  reschedule_url?: string
}

interface CalendlyEventType {
  uri: string
  name: string
  active: boolean
  slug: string
  scheduling_url: string
  duration: number
  type: string
  color: string
  description_plain?: string
}

// ─── Tool Registration ──────────────────────────────────────

export function registerCalendlyTools(server: McpServer) {

  // ═══════════════════════════════════════
  // cal_list_bookings
  // ═══════════════════════════════════════
  server.tool(
    "cal_list_bookings",
    "List scheduled Calendly bookings (meetings). Default: upcoming events from now, sorted soonest first. Shows event name, date/time, duration, meeting link, invitee count, and event UUID. Use cal_get_event_details with the UUID for invitee details and booking form responses.",
    {
      status: z.enum(["active", "canceled"]).optional().default("active").describe("Filter by status: 'active' (default) or 'canceled'"),
      count: z.number().optional().default(20).describe("Max results (default 20, max 100)"),
      min_start_time: z.string().optional().describe("ISO 8601 date — show events starting after this time (default: now)"),
      max_start_time: z.string().optional().describe("ISO 8601 date — show events starting before this time"),
      sort: z.enum(["start_time:asc", "start_time:desc"]).optional().default("start_time:asc").describe("Sort order (default: ascending = soonest first)"),
    },
    async ({ status, count, min_start_time, max_start_time, sort }) => {
      try {
        const params: Record<string, string> = {
          user: USER_URI,
          count: String(Math.min(count || 20, 100)),
          status: status || "active",
          sort: sort || "start_time:asc",
        }

        // Default: from now onwards
        if (min_start_time) {
          params.min_start_time = min_start_time
        } else if (!max_start_time) {
          params.min_start_time = new Date().toISOString()
        }
        if (max_start_time) {
          params.max_start_time = max_start_time
        }

        const result = (await calendlyGet("/scheduled_events", params)) as {
          collection: CalendlyEvent[]
          pagination: { count: number; next_page_token?: string }
        }

        if (!result.collection || result.collection.length === 0) {
          return {
            content: [{ type: "text" as const, text: "📭 No bookings found for the specified criteria." }],
          }
        }

        const lines: string[] = [
          `📅 Bookings (${result.collection.length}${result.pagination.next_page_token ? "+" : ""})`,
          "",
        ]

        for (const evt of result.collection) {
          const start = new Date(evt.start_time)
          const end = new Date(evt.end_time)
          const duration = Math.round((end.getTime() - start.getTime()) / 60000)
          const statusIcon = evt.status === "active" ? "✅" : "❌"
          const uuid = evt.uri.split("/").pop()

          lines.push(`${statusIcon} ${evt.name}`)
          lines.push(`   📆 ${start.toLocaleDateString("it-IT", { weekday: "short", day: "numeric", month: "short", year: "numeric" })} ${start.toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" })} - ${end.toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" })} (${duration} min)`)

          if (evt.location?.join_url) {
            lines.push(`   🔗 ${evt.location.join_url}`)
          }

          lines.push(`   👥 Invitees: ${evt.invitees_counter.active}/${evt.invitees_counter.total}`)

          if (evt.cancellation) {
            lines.push(`   ❌ Cancelled: ${evt.cancellation.reason || "no reason"}`)
          }

          lines.push(`   🆔 ${uuid}`)
          lines.push("")
        }

        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
        }
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: `❌ List bookings failed: ${error instanceof Error ? error.message : String(error)}` }],
        }
      }
    }
  )

  // ═══════════════════════════════════════
  // cal_get_event_details
  // ═══════════════════════════════════════
  server.tool(
    "cal_get_event_details",
    "Get full details of a Calendly event by UUID (from cal_list_bookings). Returns date, time, location, join URL, cancellation info, and all invitee details including booking form responses (name, email, reason, source, phone). Use this to see WHO booked and WHY.",
    {
      event_uuid: z.string().describe("Event UUID (from cal_list_bookings output)"),
    },
    async ({ event_uuid }) => {
      try {
        // Get event details
        const eventResult = (await calendlyGet(`/scheduled_events/${event_uuid}`)) as {
          resource: CalendlyEvent
        }
        const evt = eventResult.resource

        // Get invitees
        const inviteesResult = (await calendlyGet(`/scheduled_events/${event_uuid}/invitees`)) as {
          collection: CalendlyInvitee[]
        }

        const start = new Date(evt.start_time)
        const end = new Date(evt.end_time)
        const duration = Math.round((end.getTime() - start.getTime()) / 60000)

        const lines: string[] = [
          `📅 ${evt.name}`,
          "",
          `📆 Date: ${start.toLocaleDateString("it-IT", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}`,
          `⏰ Time: ${start.toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" })} - ${end.toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" })} (${duration} min)`,
          `📋 Status: ${evt.status}`,
        ]

        if (evt.location?.join_url) {
          lines.push(`🔗 Join URL: ${evt.location.join_url}`)
        }
        if (evt.location?.location) {
          lines.push(`📍 Location: ${evt.location.location}`)
        }

        if (evt.cancellation) {
          lines.push(`❌ Cancelled by: ${evt.cancellation.canceled_by}`)
          if (evt.cancellation.reason) {
            lines.push(`   Reason: ${evt.cancellation.reason}`)
          }
        }

        // Invitees
        if (inviteesResult.collection.length > 0) {
          lines.push("")
          lines.push("── Invitees ──")

          for (const inv of inviteesResult.collection) {
            const invStatus = inv.status === "active" ? "✅" : "❌"
            lines.push(`${invStatus} ${inv.name} <${inv.email}>`)
            if (inv.timezone) {
              lines.push(`   🌍 Timezone: ${inv.timezone}`)
            }

            // Booking form responses
            if (inv.questions_and_answers && inv.questions_and_answers.length > 0) {
              for (const qa of inv.questions_and_answers) {
                lines.push(`   💬 ${qa.question}: ${qa.answer}`)
              }
            }

            if (inv.reschedule_url) {
              lines.push(`   🔄 Reschedule: ${inv.reschedule_url}`)
            }
          }
        }

        lines.push("")
        lines.push(`🆔 Event UUID: ${event_uuid}`)
        lines.push(`📅 Created: ${new Date(evt.created_at).toLocaleString("it-IT")}`)

        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
        }
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: `❌ Get event failed: ${error instanceof Error ? error.message : String(error)}` }],
        }
      }
    }
  )

  // ═══════════════════════════════════════
  // cal_get_availability
  // ═══════════════════════════════════════
  server.tool(
    "cal_get_availability",
    "List active Calendly event types (booking pages) for Antonio. Returns scheduling URLs, durations, and descriptions. Use this to find the correct booking link to share with a client or to check which event types are currently active.",
    {},
    async () => {
      try {
        const result = (await calendlyGet("/event_types", {
          user: USER_URI,
          active: "true",
        })) as {
          collection: CalendlyEventType[]
        }

        if (!result.collection || result.collection.length === 0) {
          return {
            content: [{ type: "text" as const, text: "📭 No active event types found." }],
          }
        }

        const lines: string[] = [
          `🗓️ Active Event Types (${result.collection.length})`,
          "",
        ]

        for (const et of result.collection) {
          lines.push(`📌 ${et.name}`)
          lines.push(`   ⏱️ Duration: ${et.duration} min`)
          lines.push(`   🔗 Book: ${et.scheduling_url}`)
          if (et.description_plain) {
            lines.push(`   📝 ${et.description_plain.slice(0, 200)}`)
          }
          lines.push(`   🎨 Color: ${et.color} | Type: ${et.type}`)
          lines.push("")
        }

        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
        }
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: `❌ Get availability failed: ${error instanceof Error ? error.message : String(error)}` }],
        }
      }
    }
  )

}
