package com.tonydurante.myllcmanager

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

// The server's answer to "who am I" (GET /api/portal/app/me) is what the bottom bar and the Menu are drawn from.
class MeApiTest {
    private val answer = """
        {"ok":true,"kind":"client","bar":["nav.overview","nav.chat","nav.documents"],"menuBadge":3,
         "company":{"id":"abc","name":"Acme LLC"},
         "items":[
           {"key":"nav.overview","path":"/portal","label":"Overview","badge":0},
           {"key":"nav.chat","path":"/portal/chat","label":"Chat","badge":2},
           {"key":"nav.documents","path":"/portal/documents","label":"Documents","badge":20}
         ]}
    """.trimIndent()

    @Test fun theBarAndTheMenuAreReadFromTheAnswer() {
        val me = parseMe(answer)!!
        assertEquals("client", me.kind)
        assertEquals(listOf("nav.overview", "nav.chat", "nav.documents"), me.bar)
        assertEquals(3, me.menuBadge)
        assertEquals(3, me.items.size)
        assertEquals(NavItem("nav.chat", "/portal/chat", "Chat", 2), me.items[1])
        assertEquals(20, me.items[2].badge)
    }

    @Test fun aMissingNumberCountsAsNothing() {
        val me = parseMe("""{"kind":"client","bar":[],"items":[{"key":"nav.chat","path":"/portal/chat","label":"Chat"}]}""")!!
        assertEquals(0, me.items[0].badge)
        assertEquals(0, me.menuBadge)
    }

    @Test fun anAnswerThatIsNotUsableGivesNothingAndTheBarIsKept() {
        assertNull(parseMe(""))
        assertNull(parseMe("<html>Sign in</html>"))
        assertNull(parseMe("""{"error":"APP_NOT_ENABLED"}"""))
        assertNull(parseMe("""{"kind":"client","bar":[],"items":[{"key":"nav.chat"}]}"""))
    }
}
