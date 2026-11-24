# Vue async state and editable form contracts

Read this when the task changes a Vue watcher that fetches data, changes client navigation, or edits a child form that drafts a parent prop. Adapt these patterns to the installed Vue and router versions and the actual component contracts. These examples illustrate ownership and cleanup; they are not verification results for the target application.

## Resource watcher with late responses

An abort signal is useful but insufficient. Some services complete after cancellation. The watcher must invalidate local writes too. The callback form of `onCleanup` works across Vue 3 releases; `onWatcherCleanup` requires Vue 3.5+ and must be registered before any `await`.

```ts
// Created synchronously in setup, so the watcher stops on unmount.
watch(
  [() => route.params.id, retryEpoch],
  async ([id], _previous, onCleanup) => {
    const controller = new AbortController();
    let active = true;
    onCleanup(() => {
      active = false;
      controller.abort();
    });

    item.value = null;
    error.value = null;
    loading.value = true;
    try {
      const response = await fetch(makeDetailUrl(String(id)), {
        signal: controller.signal,
      });
      if (!active) return;
      if (!response.ok) throw new Error(`Request failed: ${response.status}`);
      const result = await response.json();
      if (!active) return;
      item.value = result;
      await nextTick();
      if (active) headingRef.value?.focus();
    } catch (cause) {
      if (active) error.value = describeError(cause);
    } finally {
      if (active) loading.value = false;
    }
  },
  { immediate: true },
);
```

Use an explicit source array for route identity and retry signals; reads made after the first `await` in `watchEffect` do not become tracked dependencies. If the application uses Vue Router, navigate through the router. If it uses native history, update the reactive route state on `pushState` and handle subsequent `popstate` events with listener cleanup.

**Verify:** Begin a slow request, navigate to a fast one, then let the slow response complete despite abort. The current record, error, loading state, and focus must remain correct. Repeat navigation and retry; count pending requests, listeners, and watchers after unmount. Exercise an error, an empty response, and a retry.

## Child draft that respects parent ownership

Copy the fields that the child may edit. Watch stable identity plus an explicit reset signal. Avoid watching every parent object update because an unrelated refresh can erase a dirty draft.

```ts
type RecordInput = { id: string; title: string };
const props = defineProps<{ record: RecordInput; resetEpoch: number }>();
const emit = defineEmits<{ save: [value: RecordInput] }>();
const draft = reactive({ title: '' });
const error = ref('');
const titleInput = ref<HTMLInputElement | null>(null);
let revision = 0;

function restoreDraft() {
  revision++;
  draft.title = props.record.title;
  error.value = '';
}

watch([() => props.record.id, () => props.resetEpoch], restoreDraft, { immediate: true });

function cancel() {
  restoreDraft(); // Uses the latest parent fields.
}

async function save() {
  const started = revision;
  const value = draft.title.trim();
  if (!value) {
    error.value = 'A title is required';
    await nextTick();
    if (revision === started) titleInput.value?.focus();
    return;
  }
  if (revision !== started) return;
  emit('save', { id: props.record.id, title: value });
}
```

For asynchronous validation or saves, also invalidate the pending operation on new input, identity change, reset, cancel, and unmount. Compare both the form revision and the submitted value before committing results. Keep a separate revision and reset signal for each sibling form so resetting one does not affect the other.

**Verify:** Edit a draft, refresh the same record, switch identity, return to an old identity, reset, cancel, and submit valid and invalid values. Check that there are no emits from typing or invalid saves, exactly one copied commit payload on valid save, focus remains on the current form, and sibling drafts survive unrelated resets.

## Evidence boundary

A successful type check or build proves syntax and integration at that layer. Browser claims require actual focus, keyboard, loading, navigation, and unmount observations. When the browser is unavailable, record the specific tool error and leave those claims unverified.
