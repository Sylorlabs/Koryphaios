package com.kory.eval

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material3.Button
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import kotlinx.coroutines.CancellationException

// Positive control only: evaluator test must pass on this corrected real app.
@Composable
fun FeedScreen() {
    val messages by FeedSource.messages.collectAsStateWithLifecycle()
    var search by remember { mutableStateOf("") }
    var showingFeed by remember { mutableStateOf(true) }
    var retry by remember { mutableIntStateOf(0) }
    Column {
        if (showingFeed) {
            OutlinedTextField(
                value = search, onValueChange = { search = it },
                label = { Text("Search messages") },
                modifier = Modifier.testTag("search").semantics { contentDescription = "Search messages" },
            )
            Button(onClick = { FeedSource.prepend() }, modifier = Modifier.testTag("prepend")) {
                Text("Prepend older")
            }
            Button(onClick = { retry++ }, modifier = Modifier.testTag("retry-avatars")) {
                Text("Retry avatars")
            }
            Button(onClick = { showingFeed = false }, modifier = Modifier.testTag("details")) {
                Text("Open details")
            }
            val state = rememberLazyListState()
            FeedProbe.listState = state
            LazyColumn(state = state, modifier = Modifier.testTag("messages")) {
                items(messages, key = { it.id }) { message ->
                    LaunchedEffect(message.id, retry) {
                        try {
                            AvatarAudit.load(message.id)
                        } catch (cancelled: CancellationException) {
                            throw cancelled
                        } catch (_: IllegalStateException) {
                            // A transient avatar error may be retried from the UI.
                        }
                    }
                    Text(message.preview, modifier = Modifier.testTag("row-" + message.id)
                        .semantics { contentDescription = "Message " + message.id })
                }
            }
        } else {
            Text("Message details", modifier = Modifier.testTag("detail-screen"))
        }
    }
}
