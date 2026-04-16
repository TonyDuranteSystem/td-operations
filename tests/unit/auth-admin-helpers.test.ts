/**
 * P1.9 — auth-admin-helpers unit tests.
 *
 * findAuthUserByEmail + listAllAuthUsers + findAuthUserById.  Focused
 * on the pagination correctness guarantee: a user on page 2 must still
 * be findable when perPage=1000 is hit.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

interface MockUser {
  id: string
  email: string
  app_metadata?: Record<string, unknown>
}

/**
 * Each test sets `mockPages` to the pages of users the listUsers mock
 * should return. Subsequent listUsers() calls pop from the front.
 */
let mockPages: Array<{ users: MockUser[]; nextPage: number | null }> = []
const listUsersCalls: Array<{ page?: number; perPage?: number }> = []
let getUserByIdFixture: MockUser | null = null
let getUserByIdError: { message: string; status?: number } | null = null

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    auth: {
      admin: {
        listUsers: vi.fn((params?: { page?: number; perPage?: number }) => {
          listUsersCalls.push(params ?? {})
          const page = (params?.page ?? 1) - 1
          const pageData = mockPages[page]
          if (!pageData) {
            return Promise.resolve({
              data: { users: [], nextPage: null },
              error: null,
            })
          }
          return Promise.resolve({
            data: { users: pageData.users, nextPage: pageData.nextPage },
            error: null,
          })
        }),
        getUserById: vi.fn(() => {
          if (getUserByIdError) {
            return Promise.resolve({ data: null, error: getUserByIdError })
          }
          return Promise.resolve({
            data: getUserByIdFixture
              ? { user: getUserByIdFixture }
              : { user: null },
            error: null,
          })
        }),
      },
    },
  },
}))

import {
  findAuthUserByEmail,
  findAuthUserById,
  listAllAuthUsers,
} from "@/lib/auth-admin-helpers"

beforeEach(() => {
  mockPages = []
  listUsersCalls.length = 0
  getUserByIdFixture = null
  getUserByIdError = null
})

// ─── findAuthUserByEmail ───────────────────────────────

describe("findAuthUserByEmail", () => {
  it("finds a user on page 1 without paginating further", async () => {
    mockPages = [
      {
        users: [
          { id: "u1", email: "alice@test.com" },
          { id: "u2", email: "bob@test.com" },
        ],
        nextPage: null,
      },
    ]
    const result = await findAuthUserByEmail("bob@test.com")
    expect(result?.id).toBe("u2")
    expect(listUsersCalls).toHaveLength(1)
    expect(listUsersCalls[0]).toMatchObject({ page: 1, perPage: 1000 })
  })

  it("finds a user on page 2 — the pagination correctness guarantee", async () => {
    // Simulates auth.users with >1000 rows. The user we want is in the
    // second page. The pre-P1.9 pattern would return undefined here.
    const page1Users = Array.from({ length: 1000 }, (_, i) => ({
      id: `u${i}`,
      email: `user${i}@test.com`,
    }))
    const page2Users = [
      { id: "u-target", email: "target@test.com" },
      { id: "u-other", email: "other@test.com" },
    ]
    mockPages = [
      { users: page1Users, nextPage: 2 },
      { users: page2Users, nextPage: null },
    ]

    const result = await findAuthUserByEmail("target@test.com")
    expect(result?.id).toBe("u-target")
    expect(listUsersCalls).toHaveLength(2)
    expect(listUsersCalls[1]).toMatchObject({ page: 2 })
  })

  it("returns null when the email is not found after exhausting pages", async () => {
    mockPages = [
      {
        users: [{ id: "u1", email: "alice@test.com" }],
        nextPage: null,
      },
    ]
    const result = await findAuthUserByEmail("nobody@test.com")
    expect(result).toBeNull()
  })

  it("returns null for empty/falsy email input", async () => {
    expect(await findAuthUserByEmail("")).toBeNull()
    expect(listUsersCalls).toHaveLength(0)
  })

  it("matches case-insensitively", async () => {
    mockPages = [
      {
        users: [{ id: "u1", email: "MixedCase@Test.com" }],
        nextPage: null,
      },
    ]
    const result = await findAuthUserByEmail("mixedcase@test.com")
    expect(result?.id).toBe("u1")
  })

  it("stops paginating when a page returns fewer than perPage items (length heuristic)", async () => {
    // Supabase's nextPage can be unreliable; the helper also stops
    // when a page comes back short.
    mockPages = [
      {
        users: Array.from({ length: 500 }, (_, i) => ({
          id: `u${i}`,
          email: `u${i}@test.com`,
        })),
        nextPage: 2, // misleading — lies about having a next page
      },
    ]
    const result = await findAuthUserByEmail("nobody@test.com")
    expect(result).toBeNull()
    expect(listUsersCalls).toHaveLength(1) // did not paginate further
  })
})

// ─── listAllAuthUsers ──────────────────────────────────

describe("listAllAuthUsers", () => {
  it("concatenates users across pages", async () => {
    mockPages = [
      {
        users: Array.from({ length: 1000 }, (_, i) => ({
          id: `u${i}`,
          email: `u${i}@test.com`,
        })),
        nextPage: 2,
      },
      {
        users: [
          { id: "u-a", email: "a@test.com" },
          { id: "u-b", email: "b@test.com" },
        ],
        nextPage: null,
      },
    ]
    const all = await listAllAuthUsers()
    expect(all).toHaveLength(1002)
    expect(all[1000].id).toBe("u-a")
    expect(all[1001].id).toBe("u-b")
    expect(listUsersCalls).toHaveLength(2)
  })

  it("returns empty array when no users exist", async () => {
    mockPages = [{ users: [], nextPage: null }]
    const all = await listAllAuthUsers()
    expect(all).toEqual([])
  })
})

// ─── findAuthUserById ──────────────────────────────────

describe("findAuthUserById", () => {
  it("returns the user when getUserById succeeds", async () => {
    getUserByIdFixture = { id: "u-123", email: "u@test.com" }
    const result = await findAuthUserById("u-123")
    expect(result?.id).toBe("u-123")
  })

  it("returns null when getUserById returns no user", async () => {
    getUserByIdFixture = null
    const result = await findAuthUserById("missing-id")
    expect(result).toBeNull()
  })

  it("returns null on a 404-shaped error (treats missing user as non-error)", async () => {
    getUserByIdError = { message: "not found", status: 404 }
    const result = await findAuthUserById("missing-id")
    expect(result).toBeNull()
  })

  it("throws on other errors (so callers don't silently swallow real failures)", async () => {
    getUserByIdError = { message: "service unavailable", status: 503 }
    await expect(findAuthUserById("some-id")).rejects.toThrow(
      /getUserById failed.*service unavailable/,
    )
  })

  it("returns null for empty/falsy id input", async () => {
    expect(await findAuthUserById("")).toBeNull()
  })
})
