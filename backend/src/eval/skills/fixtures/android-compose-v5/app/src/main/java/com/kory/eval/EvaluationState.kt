package com.kory.eval

import android.content.Context
import androidx.compose.foundation.lazy.LazyListState
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.flow.MutableStateFlow
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger

// Test support is immutable input, kept distinct from candidate-owned UI code.
class NoteJournal(context: Context) {
    private val preferences = context.applicationContext.getSharedPreferences("native-eval-journal", Context.MODE_PRIVATE)
    data class Pending(val account: String, val draft: String, val token: String)

    fun clear() { check(preferences.edit().clear().commit()) }
    fun selected(): String = preferences.getString("selected", "acct-a") ?: "acct-a"
    fun draft(): String = preferences.getString("draft", "") ?: ""
    fun select(account: String) {
        require(account in listOf("acct-a", "acct-b"))
        check(preferences.edit().putString("selected", account).commit())
    }
    fun edit(text: String) { check(preferences.edit().putString("draft", text).commit()) }
    fun setOnline(online: Boolean) { check(preferences.edit().putBoolean("online", online).commit()) }
    fun isOnline(): Boolean = preferences.getBoolean("online", true)
    fun pending(): Pending? {
        val token = preferences.getString("pending-token", null) ?: return null
        return Pending(
            preferences.getString("pending-account", null) ?: error("pending account lost"),
            preferences.getString("pending-draft", null) ?: error("pending draft lost"),
            token
        )
    }
    fun enqueue(account: String, text: String) {
        require(account in listOf("acct-a", "acct-b"))
        // Repeated taps use the same operation token for this selected account and draft.
        val token = "$account|$text"
        check(preferences.edit().putString("pending-token", token)
            .putString("pending-account", account).putString("pending-draft", text).commit())
        commitPending()
    }
    fun commitPending(): Boolean {
        val operation = pending() ?: return false
        if (!isOnline()) return false
        val prior = preferences.getStringSet("committed", emptySet())!!.toSet()
        val changes = preferences.edit()
        if (operation.token !in prior) {
            changes.putInt("writes-" + operation.account, writes(operation.account) + 1)
            changes.putStringSet("committed", prior + operation.token)
        }
        check(changes.remove("pending-token").remove("pending-account").remove("pending-draft").commit())
        return true
    }
    fun writes(account: String): Int = preferences.getInt("writes-" + account, 0)
}

data class Message(val id: String, val preview: String)
object FeedSource {
    private val initial = (1..35).map { Message("m$it", "Message $it") }
    val messages = MutableStateFlow(initial)
    fun reset() { messages.value = initial }
    fun prepend() {
        val prior = messages.value
        if (prior.any { it.id == "m-1" }) return
        messages.value = (-8..0).map { Message("m$it", "Older $it") } + prior
    }
}

object FeedProbe {
    // Populated by the actual LazyColumn, inspected by evaluator instrumentation.
    var listState: LazyListState? = null
}

object AvatarAudit {
    private val started = ConcurrentHashMap<String, AtomicInteger>()
    private val cancelled = ConcurrentHashMap<String, AtomicInteger>()
    private val failed = ConcurrentHashMap<String, AtomicInteger>()
    private val failNext = ConcurrentHashMap.newKeySet<String>()
    fun reset() {
        started.clear()
        cancelled.clear()
        failed.clear()
        failNext.clear()
    }
    fun failOnce(id: String) { failNext += id }
    fun launches(id: String): Int = started[id]?.get() ?: 0
    fun cancellations(id: String): Int = cancelled[id]?.get() ?: 0
    fun failures(id: String): Int = failed[id]?.get() ?: 0
    fun totalOutstanding(): Int =
        started.values.sumOf { it.get() } -
        cancelled.values.sumOf { it.get() } -
        failed.values.sumOf { it.get() }

    suspend fun load(id: String) {
        started.computeIfAbsent(id) { AtomicInteger() }.incrementAndGet()
        if (failNext.remove(id)) {
            failed.computeIfAbsent(id) { AtomicInteger() }.incrementAndGet()
            throw IllegalStateException("Transient avatar failure $id")
        }
        try {
            awaitCancellation() // Real pending coroutine until its UI owner leaves composition.
        } finally {
            cancelled.computeIfAbsent(id) { AtomicInteger() }.incrementAndGet()
        }
    }
}
