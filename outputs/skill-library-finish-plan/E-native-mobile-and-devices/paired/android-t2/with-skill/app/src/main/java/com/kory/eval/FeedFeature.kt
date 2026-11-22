package com.kory.eval

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.text.KeyboardActions
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
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import kotlinx.coroutines.CancellationException

// Identity and ownership rules for the feed:
//
// * rows are keyed by their stable message id, so a prepended page re-anchors
//   the list on the item that is actually on screen instead of re-labelling
//   every row by its new position;
// * avatar work is launched from a LaunchedEffect inside the row, so it is
//   owned by that row's composition: the work is relaunched when the stable
//   id or the retry generation changes and is cancelled when the row leaves
//   composition because it scrolled away or the screen navigated away. No
//   scope outlives the row that started it;
// * the LazyListState is hoisted above the navigation branch and is saveable,
//   so the scroll anchor survives prepending and coming back from details.
@Composable
fun FeedScreen() {
    // Lifecycle-aware collection: the subscription is tied to the composition's
    // lifecycle rather than living for as long as FeedSource does.
    val messages by FeedSource.messages.collectAsStateWithLifecycle()
    var search by rememberSaveable { mutableStateOf("") }
    var showingFeed by rememberSaveable { mutableStateOf(true) }
    // Retry generation is an explicit input to every row's effect, so a retry
    // cancels the in-flight load for that row and starts exactly one new one.
    var retryGeneration by remember { mutableIntStateOf(0) }
    val focusManager = LocalFocusManager.current

    // Hoisted so both the prepend and the details round-trip keep this anchor.
    val listState = rememberLazyListState()
    SideEffect { FeedProbe.listState = listState }

    Column(modifier = Modifier.fillMaxSize()) {
        if (showingFeed) {
            OutlinedTextField(
                value = search,
                onValueChange = { search = it },
                label = { Text("Search messages") },
                singleLine = true,
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
                keyboardActions = KeyboardActions(onSearch = { focusManager.clearFocus() }),
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 16.dp)
                    .testTag("search")
                    .semantics { contentDescription = "Search messages" },
            )
            Column(
                verticalArrangement = Arrangement.spacedBy(8.dp),
                modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
            ) {
                Button(
                    onClick = { FeedSource.prepend() },
                    modifier = Modifier.fillMaxWidth().testTag("prepend"),
                ) { Text("Prepend older") }
                Button(
                    onClick = { retryGeneration++ },
                    modifier = Modifier.fillMaxWidth()
                        .testTag("retry-avatars")
                        .semantics { contentDescription = "Retry avatars" },
                ) { Text("Retry avatars") }
                Button(
                    onClick = { showingFeed = false },
                    modifier = Modifier.fillMaxWidth().testTag("details"),
                ) { Text("Open details") }
            }
            LazyColumn(
                state = listState,
                modifier = Modifier
                    .weight(1f)
                    .fillMaxWidth()
                    .testTag("messages"),
                contentPadding = PaddingValues(horizontal = 16.dp, vertical = 8.dp),
            ) {
                // Stable domain identity, never list position.
                items(items = messages, key = { it.id }) { message ->
                    MessageRow(message = message, retryGeneration = retryGeneration)
                }
            }
        } else {
            Text("Message details", modifier = Modifier.testTag("detail-screen"))
        }
    }
}

// One row. Its avatar load, its retry generation and its cancellation all
// belong to the row's own composition lifetime.
@Composable
private fun MessageRow(
    message: Message,
    retryGeneration: Int,
    modifier: Modifier = Modifier,
) {
    var failure by remember(message.id, retryGeneration) { mutableStateOf<String?>(null) }
    var rowRetry by remember(message.id) { mutableIntStateOf(0) }

    LaunchedEffect(message.id, retryGeneration, rowRetry) {
        failure = null
        try {
            AvatarAudit.load(message.id)
        } catch (cancelled: CancellationException) {
            // Leaving the composition is the normal end of this load: it is not
            // an error, and it must not be swallowed as a retryable failure.
            throw cancelled
        } catch (error: Throwable) {
            // Expected transient failure: keep the row alive and let the user
            // retry instead of crashing the composition.
            failure = error.message ?: "Avatar unavailable"
        }
    }

    Column(modifier = modifier.fillMaxWidth().padding(vertical = 12.dp)) {
        Text(
            text = message.preview,
            modifier = Modifier
                .fillMaxWidth()
                .testTag("row-" + message.id)
                .semantics { contentDescription = "Message " + message.id },
        )
        val error = failure
        if (error != null) {
            Text(
                text = error,
                modifier = Modifier
                    .fillMaxWidth()
                    .semantics { contentDescription = "Avatar failed for " + message.id },
            )
            Button(
                onClick = { rowRetry++ },
                modifier = Modifier
                    .testTag("retry-avatar-" + message.id)
                    .semantics { contentDescription = "Retry avatar for " + message.id },
            ) { Text("Retry avatar") }
        }
    }
}
