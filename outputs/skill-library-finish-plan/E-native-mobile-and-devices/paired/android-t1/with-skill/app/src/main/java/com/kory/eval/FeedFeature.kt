package com.kory.eval

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
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
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import kotlinx.coroutines.CancellationException

/**
 * Feed screen.
 *
 * Ownership decisions:
 *
 *  - **row identity** — LazyColumn items are keyed by the stable domain message
 *    id, never by list position, so a prepended older page keeps the currently
 *    visible row anchored instead of re-binding it to a different message.
 *  - **row work** — the avatar request for a visible row belongs to that row's
 *    composition. A `LaunchedEffect` keyed on `(message.id, retryGeneration,
 *    rowRetry)` is cancelled when the row scrolls away, when its identity
 *    changes, when the retry generation changes, and when the feed navigates
 *    away. Nothing survives disposal, so outstanding work reaches zero.
 *  - **retry** — a per-row retry affordance plus a feed-wide retry re-key the
 *    same effect. An observed transient failure is caught (with
 *    `CancellationException` rethrown) so the row stays composed and retryable
 *    instead of crashing the composition.
 *  - **navigation** — back from the detail destination is routed through the
 *    platform `OnBackPressedDispatcher` via `BackHandler`, so the system back
 *    gesture pops the in-screen destination and otherwise finishes the
 *    activity normally.
 *  - **state class** — `search` and the detail destination are view values, so
 *    `rememberSaveable` (configuration change *and* the state the system keeps
 *    for process death) is the right owner; `FeedSource` remains the single
 *    observable source of truth for the messages themselves.
 */
@Composable
fun FeedScreen() {
    val messages by FeedSource.messages.collectAsStateWithLifecycle()
    var search by rememberSaveable { mutableStateOf("") }
    var showingFeed by rememberSaveable { mutableStateOf(true) }
    var retryGeneration by rememberSaveable { mutableIntStateOf(0) }

    BackHandler(enabled = !showingFeed) { showingFeed = true }

    Column {
        if (showingFeed) {
            OutlinedTextField(
                value = search, onValueChange = { search = it },
                label = { Text("Search messages") },
                singleLine = true,
                keyboardOptions = KeyboardOptions(
                    keyboardType = KeyboardType.Text,
                    imeAction = ImeAction.Search,
                ),
                modifier = Modifier.testTag("search")
                    .semantics { contentDescription = "Search messages" },
            )
            Button(
                onClick = { FeedSource.prepend() },
                modifier = Modifier.testTag("prepend")
                    .semantics { contentDescription = "Prepend older messages" },
            ) { Text("Prepend older") }
            Button(
                onClick = { retryGeneration++ },
                modifier = Modifier.testTag("retry-avatars")
                    .semantics { contentDescription = "Retry avatars" },
            ) { Text("Retry avatars") }
            Button(
                onClick = { showingFeed = false },
                modifier = Modifier.testTag("details")
                    .semantics { contentDescription = "Open details" },
            ) { Text("Open details") }
            val state = rememberLazyListState()
            SideEffect { FeedProbe.listState = state }
            LazyColumn(state = state, modifier = Modifier.testTag("messages")) {
                items(messages, key = { it.id }) { message ->
                    FeedRow(message = message, retryGeneration = retryGeneration)
                }
            }
        } else {
            Text(
                "Message details",
                modifier = Modifier.testTag("detail-screen")
                    .semantics { contentDescription = "Message details" },
            )
        }
    }
}

@Composable
private fun FeedRow(message: Message, retryGeneration: Int) {
    // Row-local retry counter: re-keying the effect below is the only way this
    // row's avatar request restarts, and the counter is owned by the row.
    var rowRetry by rememberSaveable { mutableIntStateOf(0) }
    var rowFailed by remember { mutableStateOf(false) }

    LaunchedEffect(message.id, retryGeneration, rowRetry) {
        rowFailed = false
        try {
            AvatarAudit.load(message.id)
        } catch (cancellation: CancellationException) {
            // The owner really did cancel this request (scroll away, identity
            // change, navigation away); let cancellation propagate.
            throw cancellation
        } catch (failure: Exception) {
            // Observed transient failure: keep the row composed and offer a
            // retry instead of leaving orphaned work running.
            rowFailed = true
        }
    }

    Row {
        Text(
            message.preview,
            modifier = Modifier.testTag("row-" + message.id)
                .semantics { contentDescription = "Message " + message.id },
        )
        if (rowFailed) {
            Button(
                onClick = { rowRetry++ },
                modifier = Modifier.testTag("avatar-retry-" + message.id)
                    .semantics {
                        contentDescription = "Retry avatar for message " + message.id
                    },
            ) { Text("Retry avatar") }
        }
    }
}
