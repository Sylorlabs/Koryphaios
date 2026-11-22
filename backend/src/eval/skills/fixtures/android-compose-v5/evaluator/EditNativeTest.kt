package com.kory.eval

import androidx.compose.ui.test.assertContentDescriptionEquals
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import androidx.lifecycle.Lifecycle
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class EditNativeTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private val draft = "native durable draft b"

    @Test fun primeOfflineAndRotate() {
        val journal = NoteJournal(compose.activity)
        journal.clear()
        journal.setOnline(false)
        compose.onNodeWithTag("account-acct-b").performClick()
        compose.onNodeWithTag("draft").performTextInput(draft)
        compose.onNodeWithTag("save").performClick()
        compose.waitForIdle()

        assertEquals("Selection persisted before recreation", "acct-b", journal.selected())
        assertEquals("Draft persisted before recreation", draft, journal.draft())
        assertEquals("Queued save must belong to original account", "acct-b", journal.pending()?.account)
        assertEquals(draft, journal.pending()?.draft)
        assertEquals(0, journal.writes("acct-a"))
        assertEquals(0, journal.writes("acct-b"))

        compose.activityRule.scenario.recreate() // Real Activity destruction and recreation.
        compose.onNodeWithTag("selection").assertTextContains("acct-b", substring = true)
        compose.onNodeWithTag("draft").assertTextContains(draft)
        assertEquals("acct-b", journal.pending()?.account)
        compose.onNodeWithTag("save").assertContentDescriptionEquals("Save note")
        compose.onNodeWithTag("retry").assertContentDescriptionEquals("Retry pending note")
        val device = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation())
        assertNotNull("Android accessibility tree must expose Save note",
            device.wait(Until.findObject(By.desc("Save note")), 5000))
    }

    // Evaluator force-stops the application after prime, then launches this
    // method through a NEW instrumentation process.
    @Test fun resumeAfterProcessDeathAndRetry() {
        val journal = NoteJournal(compose.activity)
        compose.onNodeWithTag("selection").assertTextContains("acct-b", substring = true)
        compose.onNodeWithTag("draft").assertTextContains(draft)
        assertEquals("acct-b", journal.selected())
        assertEquals(draft, journal.draft())
        assertEquals("acct-b", journal.pending()?.account)
        assertEquals(0, journal.writes("acct-b"))
        journal.setOnline(true)
        compose.onNodeWithTag("retry").performClick()
        assertEquals("Exactly one write to the original account", 1, journal.writes("acct-b"))
        assertEquals("No cross-account write", 0, journal.writes("acct-a"))
        assertNull("Pending queue must be drained", journal.pending())
        compose.onNodeWithTag("retry").performClick()
        assertEquals("Second retry must be idempotent", 1, journal.writes("acct-b"))
        val device = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation())
        device.pressBack()
        // ActivityScenario.activity reads fail once Back actually destroys the Activity.
        // Observe the lifecycle state instead so a successful native Back is testable.
        compose.waitUntil(5000) { compose.activityRule.scenario.state == Lifecycle.State.DESTROYED }
        assertEquals("Native back should destroy the edit Activity",
            Lifecycle.State.DESTROYED, compose.activityRule.scenario.state)
    }

    // Another external force-stop: commits must still be durable.
    @Test fun persistedCommitAcrossSecondProcessDeath() {
        val journal = NoteJournal(compose.activity)
        assertEquals("acct-b", journal.selected())
        assertEquals(draft, journal.draft())
        assertEquals(1, journal.writes("acct-b"))
        assertEquals(0, journal.writes("acct-a"))
        assertNull(journal.pending())
    }
}
