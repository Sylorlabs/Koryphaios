package com.kory.eval

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollToIndex
import androidx.compose.ui.test.performTextInput
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class FeedNativeTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()

    @Test fun prependRetryNavigationFocusAndFont() {
        FeedSource.reset()
        // This is the first test in a fresh instrumentation process. Do not
        // reset the audit AFTER Compose effects start: that would erase real
        // launches while their jobs were still running.
        compose.waitForIdle()
        assertTrue(
            "Evaluator must run at a real large system font scale",
            compose.activity.resources.configuration.fontScale >= 1.5f
        )
        compose.onNodeWithTag("search").assertIsDisplayed()
        compose.onNodeWithTag("search").performClick()
        compose.onNodeWithTag("search").assertIsFocused()
        compose.onNodeWithTag("search").performTextInput("query")

        val device = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation())
        assertNotNull("Android accessibility tree must expose search label",
            device.wait(Until.findObject(By.desc("Search messages")), 5000))
        device.pressBack() // Dismiss the native IME before measuring scroll anchoring.
        compose.waitForIdle()

        compose.onNodeWithTag("messages").performScrollToIndex(12)
        compose.waitForIdle()
        val first = FeedProbe.listState?.layoutInfo?.visibleItemsInfo?.firstOrNull()?.key?.toString()
        assertNotNull("LazyColumn must be rendered", first)
        assertTrue("LazyColumn keys must use message ids, observed $first", first!!.startsWith("m"))
        val firstBefore = first
        compose.onNodeWithTag("prepend").performClick()
        compose.waitForIdle()
        val after = FeedProbe.listState?.layoutInfo?.visibleItemsInfo?.firstOrNull()?.key?.toString()
        assertEquals("Prepending rows must preserve the same visible message", firstBefore, after)
        compose.onNodeWithTag("row-$firstBefore").assertIsDisplayed()

        val visible = FeedProbe.listState?.layoutInfo?.visibleItemsInfo
            ?.map { it.key.toString() } ?: emptyList()
        val active = visible.firstOrNull { AvatarAudit.launches(it) > 0 }
        assertNotNull("A visible avatar must have launched in a real effect", active)
        val activeId = active!!
        val beforeRetry = AvatarAudit.launches(activeId)
        AvatarAudit.failOnce(activeId)
        compose.onNodeWithTag("retry-avatars").performClick()
        compose.waitUntil(5000) { AvatarAudit.failures(activeId) == 1 }
        assertTrue("Avatar retry must relaunch the same message identity",
            AvatarAudit.launches(activeId) > beforeRetry)

        compose.onNodeWithTag("details").performClick()
        compose.onNodeWithTag("detail-screen").assertIsDisplayed()
        compose.waitUntil(5000) { AvatarAudit.totalOutstanding() == 0 }
        assertEquals("Leaving the feed must cancel all pending avatar work",
            0, AvatarAudit.totalOutstanding())
        assertTrue("The selected avatar must have been cancelled on navigation",
            AvatarAudit.cancellations(activeId) > 0)
    }
}
