package com.kory.eval

import android.app.Application
import androidx.activity.compose.LocalOnBackPressedDispatcherOwner
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/*
 * State ownership for the note editor.
 *
 * Durable - survives rotation, process death and a cold start: the selected
 * account, the draft text and the queued offline save. They live in
 * NoteJournal's SharedPreferences, which is the single source of truth. Nothing
 * that a note's destination depends on may be derived from a `remember` bucket,
 * because `remember` and `mutableStateOf` are re-created by every activity
 * recreation while the journal is not.
 *
 * Saveable - survives rotation and process recreation only because it travels
 * in the saved instance state: transient editor buffers such as the text
 * field's editing string and the scroll offset. They are a cache of the durable
 * value, never an authority; a restore that disagrees with the journal is
 * re-seeded from the journal instead.
 *
 * Ephemeral - valid until the next recomposition, so it is re-derived from
 * durable state on every recreation: which account row is highlighted, whether
 * a pending save exists, and whether the last commit attempt actually landed.
 */

/** The accounts a note may be filed under. */
private val ACCOUNT_CHOICES = listOf("acct-a", "acct-b")

/**
 * Snapshot of the durable edit state, read out of [NoteJournal] every time a
 * mutating operation finishes.
 */
data class EditUiState(
    val accounts: List<String> = ACCOUNT_CHOICES,
    val selected: String = "acct-a",
    val pending: NoteJournal.Pending? = null,
)

class EditModel(application: Application) : AndroidViewModel(application) {
    private val journal = NoteJournal(application)

    private val _accounts = MutableStateFlow(ACCOUNT_CHOICES)
    val accounts: StateFlow<List<String>> = _accounts.asStateFlow()

    private val _state = MutableStateFlow(readJournal())
    val state: StateFlow<EditUiState> = _state.asStateFlow()

    private fun readJournal(): EditUiState {
        val selected = journal.selected().takeIf { it in _accounts.value } ?: _accounts.value.first()
        return EditUiState(
            accounts = _accounts.value,
            selected = selected,
            pending = journal.pendingOrNull(),
        )
    }

    private fun publish() {
        _state.value = readJournal()
    }

    /** The durable draft text, used to seed the text field on first composition. */
    fun draft(): String = journal.draft()

    fun select(account: String) {
        if (account !in _accounts.value) return
        journal.select(account)
        publish()
    }

    /** Write-through: the draft is durable, so no recreate can lose it. */
    fun edit(text: String) {
        journal.edit(text)
    }

    /**
     * Queue the note for the account that is selected *now*. `enqueue` records
     * the durable pending save first and only then attempts the commit, so an
     * offline tap leaves a record that a later retry can commit to the account
     * the user chose - after any number of rotations or process deaths.
     */
    fun save() {
        journal.enqueue(_state.value.selected, journal.draft())
        publish()
    }

    /**
     * Re-attempt the durable pending record. Nothing is invented when no save is
     * pending: a retry never silently files a note the user never queued.
     */
    fun retry() {
        journal.pendingOrNull() ?: return
        journal.commitPending()
        publish()
    }

    /**
     * A pending record whose account or draft is missing is a corrupt journal
     * entry, not a reason to crash the editor. `enqueue` rewrites all three
     * keys, so returning null here degrades to "no pending save" instead.
     */
    private fun NoteJournal.pendingOrNull(): NoteJournal.Pending? =
        try {
            pending()
        } catch (lost: IllegalStateException) {
            null
        }
}

@Composable
fun EditScreen() {
    val model: EditModel = viewModel()
    val accounts by model.accounts.collectAsStateWithLifecycle()
    val state by model.state.collectAsStateWithLifecycle()
    val pending = state.pending
    // Cache of the durable draft so typing stays responsive; the journal owns it.
    var draft by rememberSaveable { mutableStateOf(model.draft()) }
    // Native back dispatch: the activity's own OnBackPressedDispatcher, not a
    // bespoke navigation model. The system back action stays untouched.
    val back = LocalOnBackPressedDispatcherOwner.current

    Column(modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState()).imePadding()) {
        accounts.forEach { account ->
            Button(
                modifier = Modifier.testTag("account-$account"),
                onClick = { model.select(account) },
            ) { Text("Account $account") }
        }
        Text("Selected account: ${state.selected}", modifier = Modifier.testTag("selection"))
        OutlinedTextField(
            value = draft,
            onValueChange = {
                draft = it
                model.edit(it)
            },
            label = { Text("Note draft") },
            modifier = Modifier.testTag("draft").semantics { contentDescription = "Note draft" },
        )
        Button(
            onClick = { model.save() },
            modifier = Modifier.testTag("save").semantics { contentDescription = "Save note" },
        ) { Text("Save note") }
        Button(
            onClick = { model.retry() },
            modifier = Modifier.testTag("retry").semantics { contentDescription = "Retry pending note" },
        ) { Text("Retry pending note") }
        Button(
            onClick = { back?.onBackPressedDispatcher?.onBackPressed() },
            modifier = Modifier.testTag("back").semantics { contentDescription = "Back" },
        ) { Text("Back") }
        Text(
            text = if (pending == null) "No pending save" else "Pending save: ${pending.account}",
            modifier = Modifier
                .testTag("pending")
                .semantics {
                    contentDescription =
                        if (pending == null) "No pending save" else "Pending save for ${pending.account}"
                    liveRegion = LiveRegionMode.Polite
                },
        )
    }
}
