/**
 * Whop Tools — Payment gateway for checkout offers
 * API v1: https://api.whop.com/api/v1
 * Company: biz_rssyD9YyMnXd7P (Tony Durante LLC)
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"

const WHOP_API = "https://api.whop.com/api/v1"
const WHOP_KEY = process.env.WHOP_API_KEY || ""
const COMPANY_ID = "biz_rssyD9YyMnXd7P"

async function whopFetch(path: string) {
  const res = await fetch(`${WHOP_API}${path}`, {
    headers: { Authorization: `Bearer ${WHOP_KEY}`, "Content-Type": "application/json" },
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Whop API ${res.status}: ${body}`)
  }
  return res.json()
}

async function whopPost(path: string, body: Record<string, unknown>) {
  const res = await fetch(`${WHOP_API}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${WHOP_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Whop API ${res.status}: ${text}`)
  }
  return res.json()
}

async function whopPatch(path: string, body: Record<string, unknown>) {
  const res = await fetch(`${WHOP_API}${path}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${WHOP_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Whop API ${res.status}: ${text}`)
  }
  return res.json()
}

async function whopDelete(path: string) {
  const res = await fetch(`${WHOP_API}${path}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${WHOP_KEY}`, "Content-Type": "application/json" },
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Whop API ${res.status}: ${text}`)
  }
  return res.json()
}

function ts(iso: string | null) {
  if (!iso) return ""
  return new Date(iso).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })
}

function money(amount: number, currency: string) {
  return currency === "eur" ? `€${amount.toLocaleString()}` : `$${amount.toLocaleString()}`
}

export function registerWhopTools(server: McpServer) {

  // ═══════════════════════════════════════
  // whop_list_payments
  // ═══════════════════════════════════════
  server.tool(
    "whop_list_payments",
    "List payments received via Whop. Shows amount, status, customer email, card details, billing address, and linked plan/product. Use this to check if a client has paid. Filter by status (paid/refunded/failed). NOTE: Requires payment:basic:read API key permission — if this fails, use whop_list_memberships instead (shows completed purchases with email).",
    {
      status: z.string().optional().describe("Filter by status: paid, refunded, failed"),
      limit: z.number().optional().default(20).describe("Max results (default 20, max 50)"),
    },
    async ({ status, limit }) => {
      try {
        let url = `/payments?company_id=${COMPANY_ID}&first=${Math.min(limit || 20, 50)}`
        if (status) url += `&status=${status}`
        const data = await whopFetch(url)
        const payments = data.data || []

        if (payments.length === 0) {
          return { content: [{ type: "text" as const, text: "No payments found." }] }
        }

        let out = `💰 Found ${payments.length} payment(s)\n\n`
        for (const p of payments) {
          const st = p.status === "paid" ? "✅" : p.status === "refunded" ? "🔄" : "❌"
          out += `${st} ${money(p.total, p.currency)} — ${p.product?.title || p.plan?.id || "?"}\n`
          out += `   📧 ${p.user?.email || "?"} | 💳 ${p.payment_method?.card?.brand || "?"} •••${p.payment_method?.card?.last4 || "?"}\n`
          out += `   📅 Paid: ${ts(p.paid_at)} | ID: ${p.id}\n`
          if (p.billing_address?.name) {
            const ba = p.billing_address
            out += `   📍 ${ba.name}, ${ba.line1}, ${ba.city} ${ba.state} ${ba.postal_code} ${ba.country}\n`
          }
          if (p.amount_after_fees) out += `   💵 Net after fees: ${money(p.amount_after_fees, p.currency)}\n`
          out += "\n"
        }

        return { content: [{ type: "text" as const, text: out }] }
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `❌ Whop error: ${e.message}` }] }
      }
    }
  )

  // ═══════════════════════════════════════
  // whop_list_plans
  // ═══════════════════════════════════════
  server.tool(
    "whop_list_plans",
    "List all Whop checkout plans (pricing links). Shows plan ID, title, price, currency, product, checkout URL, and member count. Use this to find or verify checkout links for client offers.",
    {
      limit: z.number().optional().default(20).describe("Max results (default 20)"),
    },
    async ({ limit }) => {
      try {
        const data = await whopFetch(`/plans?company_id=${COMPANY_ID}&first=${Math.min(limit || 20, 50)}`)
        const plans = data.data || []

        if (plans.length === 0) {
          return { content: [{ type: "text" as const, text: "No plans found." }] }
        }

        let out = `📋 Found ${plans.length} plan(s)\n\n`
        for (const p of plans) {
          out += `${p.title || "Untitled"} — ${money(p.initial_price, p.currency)} (${p.currency.toUpperCase()})\n`
          out += `   🆔 ${p.id} | 📦 ${p.product?.title || "?"}\n`
          out += `   🔗 ${p.purchase_url}\n`
          out += `   👥 Members: ${p.member_count || 0} | Type: ${p.plan_type} | Visibility: ${p.visibility}\n`
          if (p.description) out += `   📝 ${p.description}\n`
          out += "\n"
        }

        return { content: [{ type: "text" as const, text: out }] }
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `❌ Whop error: ${e.message}` }] }
      }
    }
  )

  // ═══════════════════════════════════════
  // whop_list_products
  // ═══════════════════════════════════════
  server.tool(
    "whop_list_products",
    "List all Whop products. Products group plans together (e.g., 'LLC Formation' product has multiple pricing plans for different clients).",
    {},
    async () => {
      try {
        const data = await whopFetch(`/products?company_id=${COMPANY_ID}&first=50`)
        const products = data.data || []

        let out = `📦 Found ${products.length} product(s)\n\n`
        for (const p of products) {
          out += `${p.title} — ${p.id}\n`
          out += `   👥 Members: ${p.member_count || 0} | Visibility: ${p.visibility}\n`
          if (p.headline) out += `   📝 ${p.headline}\n`
          out += "\n"
        }

        return { content: [{ type: "text" as const, text: out }] }
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `❌ Whop error: ${e.message}` }] }
      }
    }
  )

  // ═══════════════════════════════════════
  // whop_create_plan
  // ═══════════════════════════════════════
  server.tool(
    "whop_create_plan",
    "Create a new Whop checkout plan (one-time payment link) for a client. Returns the plan ID and checkout URL. Requires a product_id — use whop_list_products to find the right one. Use this when creating new client offers that need a card payment option.",
    {
      product_id: z.string().describe("Product ID to attach the plan to (e.g., prod_X6mwSZhW9GqPW for LLC Onboarding)"),
      title: z.string().describe("Plan title shown at checkout (e.g., 'LLC Onboarding - ClientName')"),
      price: z.number().describe("Price in the currency's major unit (e.g., 2415 for $2,415)"),
      currency: z.enum(["usd", "eur"]).describe("Currency: usd or eur"),
      description: z.string().optional().describe("Description shown at checkout"),
    },
    async ({ product_id, title, price, currency, description }) => {
      try {
        const body: Record<string, unknown> = {
          company_id: COMPANY_ID,
          product_id,
          title,
          initial_price: price,
          currency,
          plan_type: "one_time",
          release_method: "buy_now",
          visibility: "visible",
          unlimited_stock: true,
        }
        if (description) body.description = description

        const plan = await whopPost("/plans", body)

        let out = `✅ Plan created!\n\n`
        out += `🆔 ${plan.id}\n`
        out += `📋 ${plan.title} — ${money(plan.initial_price, plan.currency)}\n`
        out += `🔗 ${plan.purchase_url}\n`

        return { content: [{ type: "text" as const, text: out }] }
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `❌ Whop error: ${e.message}` }] }
      }
    }
  )

  // ═══════════════════════════════════════
  // whop_list_memberships
  // ═══════════════════════════════════════
  server.tool(
    "whop_list_memberships",
    "List Whop memberships (client purchases). Shows who bought what (email, product, plan), membership status, and join date. PREFERRED way to verify if a client has paid — more reliable than whop_list_payments. Filter by status: completed, active, canceled, expired.",
    {
      status: z.string().optional().describe("Filter: completed, active, canceled, expired"),
      limit: z.number().optional().default(20).describe("Max results (default 20)"),
    },
    async ({ status, limit }) => {
      try {
        let url = `/memberships?company_id=${COMPANY_ID}&first=${Math.min(limit || 20, 50)}`
        if (status) url += `&status=${status}`
        const data = await whopFetch(url)
        const memberships = data.data || []

        if (memberships.length === 0) {
          return { content: [{ type: "text" as const, text: "No memberships found." }] }
        }

        let out = `👥 Found ${memberships.length} membership(s)\n\n`
        for (const m of memberships) {
          const st = m.status === "completed" || m.status === "active" ? "✅" : "⚠️"
          out += `${st} ${m.product?.title || "?"} — ${m.user?.email || "?"}\n`
          out += `   Status: ${m.status} | Plan: ${m.plan?.id || "?"}\n`
          out += `   📅 Joined: ${ts(m.joined_at || m.created_at)} | ID: ${m.id}\n`
          out += "\n"
        }

        return { content: [{ type: "text" as const, text: out }] }
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `❌ Whop error: ${e.message}` }] }
      }
    }
  )

  // ═══════════════════════════════════════
  // whop_update_product
  // ═══════════════════════════════════════
  server.tool(
    "whop_update_product",
    "Update a Whop product's title, description, or visibility. Use whop_list_products first to find the product ID. RULE: Product names must match service names (e.g., 'LLC Formation', 'Client Onboarding', 'Tax Return', 'ITIN Application', 'Banking', 'Shipping').",
    {
      product_id: z.string().describe("Product ID (e.g., prod_X6mwSZhW9GqPW)"),
      title: z.string().max(40).optional().describe("New product title (max 40 chars)"),
      description: z.string().optional().describe("New product description"),
      visibility: z.enum(["visible", "hidden", "archived"]).optional().describe("Product visibility"),
    },
    async ({ product_id, title, description, visibility }) => {
      try {
        const body: Record<string, unknown> = {}
        if (title) body.title = title
        if (description) body.description = description
        if (visibility) body.visibility = visibility

        const result = await whopPatch(`/products/${product_id}`, body)
        const lines = [
          `✅ Product updated: ${result.title || product_id}`,
        ]
        if (title) lines.push(`   Title: ${title}`)
        if (description) lines.push(`   Description: ${description}`)
        if (visibility) lines.push(`   Visibility: ${visibility}`)

        return { content: [{ type: "text" as const, text: lines.join("\n") }] }
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `❌ Whop error: ${e.message}` }] }
      }
    }
  )

  // ═══════════════════════════════════════
  // whop_update_plan
  // ═══════════════════════════════════════
  server.tool(
    "whop_update_plan",
    "Update a Whop plan's title, description, visibility, or product assignment. Use whop_list_plans first to find the plan ID. RULE: Plan names must include the service name and client name (e.g., 'Tax Return - Valenzuela', 'Onboarding - Truocchio').",
    {
      plan_id: z.string().describe("Plan ID (e.g., plan_GI9CkCBonpCRy)"),
      title: z.string().optional().describe("New plan title"),
      description: z.string().optional().describe("New plan description"),
      product_id: z.string().optional().describe("Move plan to a different product"),
      visibility: z.enum(["visible", "hidden", "archived"]).optional().describe("Plan visibility"),
    },
    async ({ plan_id, title, description, product_id, visibility }) => {
      try {
        const body: Record<string, unknown> = {}
        if (title) body.title = title
        if (description) body.description = description
        if (product_id) body.product_id = product_id
        if (visibility) body.visibility = visibility

        const result = await whopPatch(`/plans/${plan_id}`, body)
        const lines = [
          `✅ Plan updated: ${result.title || plan_id}`,
        ]
        if (title) lines.push(`   Title: ${title}`)
        if (product_id) lines.push(`   Moved to product: ${product_id}`)
        if (visibility) lines.push(`   Visibility: ${visibility}`)

        return { content: [{ type: "text" as const, text: lines.join("\n") }] }
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `❌ Whop error: ${e.message}` }] }
      }
    }
  )

  // ═══════════════════════════════════════
  // whop_create_product
  // ═══════════════════════════════════════
  server.tool(
    "whop_create_product",
    "Create a new Whop product. Products group plans together (e.g., 'Tax Return' product contains all tax return pricing plans). RULE: Product names must match service names.",
    {
      title: z.string().max(40).describe("Product title (max 40 chars). Must match a service name."),
      description: z.string().optional().describe("Product description"),
      visibility: z.enum(["visible", "hidden"]).optional().describe("Visibility (default: visible)"),
    },
    async ({ title, description, visibility }) => {
      try {
        const body: Record<string, unknown> = {
          company_id: COMPANY_ID,
          title,
        }
        if (description) body.description = description
        if (visibility) body.visibility = visibility

        const result = await whopPost("/products", body)
        return {
          content: [{
            type: "text" as const,
            text: `✅ Product created: ${result.title}\n   ID: ${result.id}\n   Visibility: ${result.visibility || "visible"}`,
          }],
        }
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `❌ Whop error: ${e.message}` }] }
      }
    }
  )

  // ═══════════════════════════════════════
  // whop_delete_product
  // ═══════════════════════════════════════
  server.tool(
    "whop_delete_product",
    "Delete a Whop product permanently. Only delete products with 0 members. Use whop_list_products first to verify.",
    {
      product_id: z.string().describe("Product ID to delete"),
    },
    async ({ product_id }) => {
      try {
        await whopDelete(`/products/${product_id}`)
        return { content: [{ type: "text" as const, text: `✅ Product deleted: ${product_id}` }] }
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `❌ Whop error: ${e.message}` }] }
      }
    }
  )
}
