package com.kory.eval

import android.app.Application
import androidx.activity.compose.LocalOnBackPressedDispatcherOwner
import androidx.compose.foundation.layout.Column
import androidx.compose.material3.Button
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * State ownership for the edit screen.
 *
 * Classification of every value the screen holds:
 *
 *  - **durable** (repository, [NoteJournal]) — the selected account, the user's
 *    draft, and the pending save operation. These must survive both activity
 *    recreation and process death, because a queued write that loses its
 *    snapshot after a cold start writes to whatever account happens to be
 *    selected then. The pending entry is written *before* any delivery
 *    attempt and it carries its own target account/draft/idempotency token.
 *  - **observable** ([StateFlow]) — the ViewModel mirrors the journal so the
 *    UI renders one intentional source of truth. The ViewModel survives
 *    configuration change only, so it never owns a private copy that can
 *    diverge from the durable owner.
 *  - **ephemeral** (composition) — nothing; focus/IME stays with the field.
 */
class EditModel(application: Application) : AndroidViewModel(application) {
    private val journal = NoteJournal(application)

    val accounts: StateFlow<List<String>> = MutableStateFlow(listOf("acct-a", "acct-b"))

    private val _selected = MutableStateFlow(journal.selected())
    val selected: StateFlow<String> = _selected.asStateFlow()

    private val _draft = MutableStateFlow(journal.draft())
    val draft: StateFlow<String> = _draft.asStateFlow()

    // Pending state is derived from the durable queue, not from a ViewModel
    // flag, so relaunching the process cannot hide or invent a pending write.
    private val _pending = MutableStateFlow(journal.pending())
    val pending: StateFlow<NoteJournal.Pending?> = _pending.asStateFlow()

    fun select(account: String) {
        journal.select(account)
        _selected.value = journal.selected()
    }

    fun updateDraft(text: String) {
        journal.edit(text)
        _draft.value = text
    }

    /**
     * Persist the operation first (account, draft and idempotency token are
     * snapshotted by [NoteJournal.enqueue]), then attempt delivery. While
     * offline the write simply stays queued; nothing is lost on rotation or
     * on process death because the queue entry is already durable.
     */
    fun saveNote() {
        journal.enqueue(selected.value, draft.value)
        refreshPending()
    }

    /**
     * Retry the *stored* operation. The target is read back from the queue, so
     * changing the selected account before retrying cannot redirect the write,
     * and a second retry cannot fire a second write (the token is idempotent).
     */
    fun retryPending() {
        journal.pending() ?: return
        journal.commitPending()
        refreshPending()
    }

    private fun refreshPending() {
        _pending.value = journal.pending()
    }
}

@Composable
fun EditScreen() {
    val model: EditModel = viewModel()
    val accounts by model.accounts.collectAsStateWithLifecycle()
    val selected by model.selected.collectAsStateWithLifecycle()
    val draft by model.draft.collectAsStateWithLifecycle()
    val pending by model.pending.collectAsStateWithLifecycle()
    val back = LocalOnBackPressedDispatcherOwner.current

    Column {
        accounts.forEach { account ->
            Button(
                onClick = { model.select(account) },
                modifier = Modifier.testTag("account-$account")
                    .semantics {
                        if (account == selected) stateDescription = "Selected account"
                    },
            ) { Text("Account $account") }
        }
        Text("Selected account: $selected", modifier = Modifier.testTag("selection"))
        OutlinedTextField(
            value = draft,
            onValueChange = { model.updateDraft(it) },
            label = { Text("Note draft") },
            modifier = Modifier.testTag("draft").semantics { contentDescription = "Note draft" },
        )
        Button(
            onClick = { model.saveNote() },
            modifier = Modifier.testTag("save").semantics { contentDescription = "Save note" },
        ) { Text("Save note") }
        Button(
            onClick = { model.retryPending() },
            modifier = Modifier.testTag("retry").semantics { contentDescription = "Retry pending note" },
        ) { Text("Retry pending note") }
        if (pending != null) {
            val pendingNote = pending!!
            Text(
                "Pending save for account ${pendingNote.account}",
                modifier = Modifier.testTag("pending-status").semantics {
                    contentDescription = "Pending save for account ${pendingNote.account}"
                },
            )
        }
        Button(
            onClick = { back?.onBackPressedDispatcher?.onBackPressed() },
            modifier = Modifier.testTag("back").semantics { contentDescription = "Back" },
        ) { Text("Back") }
    }
}
