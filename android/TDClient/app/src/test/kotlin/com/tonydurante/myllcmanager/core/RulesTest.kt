package com.tonydurante.myllcmanager.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

// A port of ios/TDClient/Tests/TDClientCoreTests/RulesTests.swift and BugHuntRulesTests.swift: the two apps follow the same rules.
class RulesTest {
    private val portal = "portal.tonydurante.us"
    private val sandbox = "td-operations-sandbox.vercel.app"

    @Test fun browserNameTokenMatchesTheServer() {
        // lib/app-mode/app-mode.ts CLIENT_APP_UA_TOKEN = 'TDClient/' (exact, case-sensitive)
        assertEquals("TDClient/", ServerRules.USER_AGENT_TOKEN)
        assertEquals("TDClient/2.0.0 TDAndroid", ServerRules.userAgentSuffix("2.0.0"))
        assertTrue(ServerRules.userAgentSuffix("2.0.0").contains(ServerRules.USER_AGENT_TOKEN))
    }

    @Test fun ourServerStaysInTheApp() {
        assertTrue(LinkRules.staysInApp(portal, portal))
        assertTrue(LinkRules.staysInApp("PORTAL.tonydurante.us", portal))
        assertTrue(LinkRules.staysInApp(sandbox, sandbox))
    }

    @Test fun theAppSiblingStaysOnlyOnTheLivePortal() {
        assertTrue(LinkRules.staysInApp("app.tonydurante.us", portal))
        assertFalse(LinkRules.staysInApp("app.tonydurante.us", sandbox))
    }

    @Test fun stripeCardPageStaysButNotLookAlikes() {
        assertTrue(LinkRules.staysInApp("checkout.stripe.com", portal))
        assertTrue(LinkRules.staysInApp("stripe.com", portal))
        assertFalse(LinkRules.staysInApp("stripe.com.evil.example", portal))
        assertFalse(LinkRules.staysInApp("notstripe.com", portal))
        assertFalse(LinkRules.staysInApp("evilstripe.com", portal))
    }

    @Test fun otherSitesAndEmptyHostsOpenOutsideTheApp() {
        assertFalse(LinkRules.staysInApp("example.com", portal))
        assertFalse(LinkRules.staysInApp("portal.tonydurante.us.evil.example", portal))
        assertFalse(LinkRules.staysInApp(null, portal))
        assertFalse(LinkRules.staysInApp("", portal))
        assertFalse(LinkRules.staysInApp("crm.tonydurante.us", portal))
    }

    @Test fun onlyOurSiteMayUseTheMicrophone() {
        assertTrue(LinkRules.mayUseMedia(portal, portal))
        assertFalse(LinkRules.mayUseMedia("checkout.stripe.com", portal))
        assertFalse(LinkRules.mayUseMedia("example.com", portal))
    }

    @Test fun theDoorFromThePageToTheAppIsOpenOnlyToOurOrigins() {
        assertEquals(setOf("https://portal.tonydurante.us", "https://app.tonydurante.us"), LinkRules.ownOrigins("https://$portal"))
        assertEquals(setOf("https://td-operations-sandbox.vercel.app"), LinkRules.ownOrigins("https://$sandbox"))
        assertEquals(setOf("http://10.0.2.2:3031"), LinkRules.ownOrigins("http://10.0.2.2:3031"))
        assertFalse(LinkRules.ownOrigins("https://$portal").contains("https://checkout.stripe.com"))
    }

    @Test fun menuLinksMustBeSameSiteRelativePaths() {
        assertEquals("/portal/chat", AlertRouting.safeRelativePath("/portal/chat"))
        assertEquals("/portal/invoices?tab=billing", AlertRouting.safeRelativePath("/portal/invoices?tab=billing"))
        assertNull(AlertRouting.safeRelativePath(null))
        assertNull(AlertRouting.safeRelativePath(""))
        assertNull(AlertRouting.safeRelativePath("https://example.com/x"))
        assertNull(AlertRouting.safeRelativePath("//example.com/x"))
        assertNull(AlertRouting.safeRelativePath("/\\example.com"))
        assertNull(AlertRouting.safeRelativePath("/a b"))
        assertNull(AlertRouting.safeRelativePath("/a\nb"))
        assertNull(AlertRouting.safeRelativePath("javascript:alert(1)"))
        assertNull(AlertRouting.safeRelativePath("/" + "a".repeat(600)))
    }

    // finding 1: the app asks about the company the page shows
    @Test fun selectionQueryAcceptsPlainIdsAndNothing() {
        assertEquals("account=0b9a-12ab", SelectionRules.query("selection:account=0b9a-12ab"))
        assertEquals("", SelectionRules.query("selection:"))
        assertEquals("account=abc&mode=partner", SelectionRules.query("selection:account=abc&mode=partner"))
    }

    @Test fun selectionQueryRefusesAnythingElse() {
        assertNull(SelectionRules.query("menu"))
        assertNull(SelectionRules.query("selection:account=a b"))
        assertNull(SelectionRules.query("selection:account=a/../b"))
        assertNull(SelectionRules.query("selection:account=<script>"))
        assertNull(SelectionRules.query("selection:" + "a".repeat(201)))
    }

    @Test fun meAddressCarriesTheSelection() {
        assertEquals("/api/portal/app/me", SelectionRules.meAddress(""))
        assertEquals("/api/portal/app/me?account=x1", SelectionRules.meAddress("account=x1"))
    }

    // finding 3: only "nobody is signed in" or "switched off" removes the bar; a hiccup keeps it
    @Test fun meOutcomeKeepsTheBarOnAHiccup() {
        assertEquals(MeOutcome.SIGNED_IN, MeRules.outcome(200))
        assertEquals(MeOutcome.SIGNED_OUT, MeRules.outcome(401))
        assertEquals(MeOutcome.SIGNED_OUT, MeRules.outcome(403))
        assertEquals(MeOutcome.OFF, MeRules.outcome(503))
        assertEquals(MeOutcome.UNAVAILABLE, MeRules.outcome(500))
        assertEquals(MeOutcome.UNAVAILABLE, MeRules.outcome(502))
        assertEquals(MeOutcome.UNAVAILABLE, MeRules.outcome(429))
        assertEquals(MeOutcome.UNAVAILABLE, MeRules.outcome(null))
        assertTrue(MeOutcome.SIGNED_OUT.clearsBar)
        assertTrue(MeOutcome.OFF.clearsBar)
        assertFalse(MeOutcome.UNAVAILABLE.clearsBar)
        assertFalse(MeOutcome.SIGNED_IN.clearsBar)
    }

    // finding 11: TD Billing is the invoices page with ?tab=billing
    @Test fun barLightsTheRightButton() {
        assertTrue(BarRules.isActive("/portal/billing", "/portal/invoices", "billing"))
        assertFalse(BarRules.isActive("/portal/invoices", "/portal/invoices", "billing"))
        assertTrue(BarRules.isActive("/portal/invoices", "/portal/invoices", null))
        assertTrue(BarRules.isActive("/portal/invoices", "/portal/invoices/new", null))
        assertFalse(BarRules.isActive("/portal/billing", "/portal/invoices", null))
        assertTrue(BarRules.isActive("/portal", "/portal", null))
        assertFalse(BarRules.isActive("/portal", "/portal/chat", null))
        assertTrue(BarRules.isActive("/portal/chat?topic=x", "/portal/chat", null))
    }

    // finding 13: the app's own questions run only on our own server page
    @Test fun requestsRunOnlyOnOurServer() {
        assertTrue(PageRules.mayRunRequest("portal.tonydurante.us", "portal.tonydurante.us"))
        assertTrue(PageRules.mayRunRequest("Portal.TonyDurante.us", "portal.tonydurante.us"))
        assertFalse(PageRules.mayRunRequest("app.tonydurante.us", "portal.tonydurante.us"))
        assertFalse(PageRules.mayRunRequest("checkout.stripe.com", "portal.tonydurante.us"))
        assertFalse(PageRules.mayRunRequest(null, "portal.tonydurante.us"))
    }

    // finding 9: the sign-in page
    @Test fun loginPath() {
        assertTrue(PageRules.isLoginPath("/portal/login"))
        assertTrue(PageRules.isLoginPath("/portal/login/"))
        assertFalse(PageRules.isLoginPath("/portal"))
        assertFalse(PageRules.isLoginPath("/portal/loginx"))
    }

    // finding 7: sign-out waits for the server unless there is nothing to tell
    @Test fun signOutWaitsForTheServer() {
        assertTrue(SignOutRules.mayEndSession(200))
        assertTrue(SignOutRules.mayEndSession(401)) // the session is already gone
        assertTrue(SignOutRules.mayEndSession(404))
        assertTrue(SignOutRules.mayEndSession(503)) // the app is switched off: no alerts are sent anyway
        assertFalse(SignOutRules.mayEndSession(null)) // offline
        assertFalse(SignOutRules.mayEndSession(500))
        assertFalse(SignOutRules.mayEndSession(502))
        assertFalse(SignOutRules.mayEndSession(429))
    }
}
