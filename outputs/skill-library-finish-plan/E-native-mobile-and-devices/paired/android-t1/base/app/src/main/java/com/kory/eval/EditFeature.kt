package com.kory.eval

import androidx.activity.compose.LocalOnBackPressedDispatcherOwner
import androidx.compose.foundation.layout.Column
import androidx.compose.material3.Button
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import kotlinx.coroutines.flow.MutableStateFlow

class EditModel : ViewModel() {
    val accounts = MutableStateFlow(listOf("acct-a", "acct-b"))
    var queued by mutableStateOf(false)
}

// Deliberate defect: the account is ephemeral and pending save is only in the
// ViewModel. The draft happens to survive rotation, masking the process bug.
@Composable
fun EditScreen() {
    val context = LocalContext.current
    val journal = remember { NoteJournal(context) }
    val model: EditModel = viewModel()
    val accounts by model.accounts.collectAsStateWithLifecycle()
    var selected by remember { mutableStateOf(accounts.first()) }
    var draft by rememberSaveable { mutableStateOf("") }
    val back = LocalOnBackPressedDispatcherOwner.current

    Column {
        accounts.forEach { account ->
            Button(
                modifier = Modifier.testTag("account-$account"),
                onClick = { selected = account },
            ) { Text("Account $account") }
        }
        Text("Selected account: $selected", modifier = Modifier.testTag("selection"))
        OutlinedTextField(
            value = draft, onValueChange = { draft = it },
            label = { Text("Note draft") },
            modifier = Modifier.testTag("draft").semantics { contentDescription = "Note draft" },
        )
        Button(
            onClick = {
                model.queued = true
                if (journal.isOnline()) journal.enqueue(selected, draft)
            },
            modifier = Modifier.testTag("save").semantics { contentDescription = "Save note" },
        ) { Text("Save note") }
        Button(
            onClick = {
                if (model.queued) journal.enqueue(selected, draft)
                model.queued = false
            },
            modifier = Modifier.testTag("retry").semantics { contentDescription = "Retry pending note" },
        ) { Text("Retry pending note") }
        Button(
            onClick = { back?.onBackPressedDispatcher?.onBackPressed() },
            modifier = Modifier.testTag("back").semantics { contentDescription = "Back" },
        ) { Text("Back") }
    }
}
