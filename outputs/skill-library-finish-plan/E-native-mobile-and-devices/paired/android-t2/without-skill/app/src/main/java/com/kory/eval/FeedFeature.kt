package com.kory.eval

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material3.Button
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import kotlinx.coroutines.CancellationException

/**
 * Message feed.
 *
 * Row identity, the scroll anchor and avatar ownership are all tied to the
 * stable [Message.id]:
 * - `LazyColumn` keys rows by message id, so a prepended older page keeps each
 *   slot bound to the message it actually shows and the list keeps its visible
 *   item anchored instead of sliding under the user.
 * - The avatar load of a row is launched from an effect that is keyed by the
 *   same identity, so it is cancelled when that row is scrolled away, when the
 *   row is replaced, and when the feed is navigated away from.
 */
@Composable
fun FeedScreen() {
    // Lifecycle-aware collection: the flow is observed while the screen is at
    // least STARTED, not for the whole activity lifetime.
    val messages by FeedSource.messages.collectAsStateWithLifecycle()
    var search by rememberSaveable { mutableStateOf("") }
    var retryGeneration by remember { mutableIntStateOf(0) }
    var showingFeed by rememberSaveable { mutableStateOf(true) }

    Column(modifier = Modifier.fillMaxSize().imePadding()) {
        if (showingFeed) {
            OutlinedTextField(
                value = search, onValueChange = { search = it },
                label = { Text("Search messages") },
                modifier = Modifier
                    .testTag("search")
                    .semantics { contentDescription = "Search messages" },
            )
            Button(onClick = { FeedSource.prepend() }, modifier = Modifier.testTag("prepend")) {
                Text("Prepend older")
            }
            Button(onClick = { retryGeneration++ }, modifier = Modifier.testTag("retry-avatars")) {
                Text("Retry avatars")
            }
            Button(
                onClick = { showingFeed = false },
                modifier = Modifier.testTag("details"),
            ) { Text("Open details") }

            // rememberLazyListState() is saveable, so the anchor survives
            // composition of a row, reordering and configuration changes.
            val listState = rememberLazyListState()
            // Evaluator-owned hook, see FeedProbe. Assigned while composing so
            // it is current before the first frame after any recomposition.
            FeedProbe.listState = listState
            LazyColumn(
                state = listState,
                modifier = Modifier
                    .weight(1f)
                    .fillMaxWidth()
                    .testTag("messages"),
            ) {
                items(messages, key = { message -> message.id }) { message ->
                    MessageRow(
                        message = message,
                        retryGeneration = retryGeneration,
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
            }
        } else {
            Text("Message details", modifier = Modifier.testTag("detail-screen"))
        }
    }
}

/**
 * A single message row.
 *
 * [retryGeneration] participates in the effect key so the retry control can
 * deliberately restart the load for this message id.
 */
@Composable
private fun MessageRow(
    message: Message,
    retryGeneration: Int,
    modifier: Modifier = Modifier,
) {
    // One avatar job per composition of this row, owned by that composition.
    // Leaving the composition - scrolling the row away, replacing it after a
    // prepend, or navigating the feed away - cancels this coroutine. No
    // standalone CoroutineScope with an empty onDispose is used, so no load
    // can outlive its owner.
    LaunchedEffect(message.id, retryGeneration) {
        try {
            AvatarAudit.load(message.id)
        } catch (cancelled: CancellationException) {
            // The owner left composition; propagate so the job stays cancelled.
            throw cancelled
        } catch (transient: Exception) {
            // Expected transient avatar failure. The row stays on screen and
            // "Retry avatars" re-keys this effect with a fresh generation.
        }
    }
    Text(
        text = message.preview,
        modifier = modifier
            .testTag("row-" + message.id)
            .semantics { contentDescription = "Message " + message.id },
    )
}
