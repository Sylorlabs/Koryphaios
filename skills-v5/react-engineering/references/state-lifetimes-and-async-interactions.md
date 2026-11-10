# React state lifetimes and async interaction recipes

Use these recipes for React interactions on the client where navigation, network work, and view identity overlap. Check the installed React version, router, state/cache library, and the contract for editable files in the task first. If a framework owns navigation, fetching, or persistence, use its supported primitives; these examples illustrate the React ownership decisions rather than replacing those contracts.

## 1. Search tied to a URL

**Four owners:** the URL or router owns the committed query; the input owns an editable draft; the remote source owns returned records; React owns the current request's loading, success, empty, or error presentation. A preference that survives navigation or remount belongs in durable application or browser storage. Do not turn all five into copies that synchronize through Effects.

**Navigation:** seed the query from the URL on the client. Subscribe to the router, or to `popstate` for a small application that uses browser history, and remove the listener in cleanup. When browser history changes, update the committed query and deliberately decide whether to replace the input draft. A form submission should update the URL and the committed query in one event path. `history.pushState()` does _not_ emit `popstate`; do not rely on a listener to observe your own push. A router with subscription hooks takes precedence over this manual example:

```jsx
// Client-only browser history pattern; use router APIs when supplied.
const readQuery = () => new URLSearchParams(location.search).get('q') ?? '';
const [query, setQuery] = useState(readQuery);
const [draft, setDraft] = useState(readQuery);
const [retryNumber, retry] = useReducer((number) => number + 1, 0);

useEffect(() => {
  const onBackForward = () => {
    const next = readQuery();
    setQuery(next);
    setDraft(next);
  };
  addEventListener('popstate', onBackForward);
  return () => removeEventListener('popstate', onBackForward);
}, []);

function submit(event) {
  event.preventDefault();
  const next = draft.trim();
  if (next === query) {
    retry(); // A failed request can be repeated without changing the URL.
    return;
  }
  const url = new URL(location.href);
  url.searchParams.set('q', next);
  history.pushState({}, '', url);
  setQuery(next);
}
```

**Network lifetime:** changes to the committed query _or_ the retry counter start new work. Treat a pending response as belonging to that specific Effect instance. Abort when possible and invalidate its completion whether or not the network operation honors the abort. The same guard applies to success, rejection, and an unmounted owner. A separate retry trigger also avoids forcing a fake navigation just to retry.

```jsx
useEffect(() => {
  const controller = new AbortController();
  let current = true;
  setRequest({ forQuery: query, attempt: retryNumber, status: 'loading', items: [] });

  search(query, { signal: controller.signal })
    .then((items) => {
      if (current) setRequest({ forQuery: query, attempt: retryNumber, status: 'success', items });
    })
    .catch((error) => {
      if (current && !controller.signal.aborted) {
        setRequest({
          forQuery: query,
          attempt: retryNumber,
          status: 'error',
          message: String(error.message ?? error),
          items: [],
        });
      }
    });

  return () => {
    current = false; // Protect React state even if the request settles after abort.
    controller.abort();
  };
}, [query, retryNumber]);
```

Use the actual service's request API and accepted result shape. During render, accept a stored response only when `request.forQuery === query && request.attempt === retryNumber`; otherwise render loading with no previous results. This masks an obsolete response during the render _before_ the next Effect has set the loading state. Render error, successful empty, and populated results distinctly. With a data/cache library, use the identity of its request key and its cancellation semantics instead of duplicating a fetch Effect.

**Durable preference:** a remount destroys component state. Read a persistent favorite, display setting, or similar preference from its durable owner and write intentional changes back to that owner in the event handler. For plain `localStorage`, handle unavailable storage and SSR/hydration explicitly; a lazy initializer that runs only on the client does not automatically make markup rendered on the server safe.

```jsx
// Client-only example. Use the app's preference store when one exists.
const [favorite, setFavorite] = useState(() => {
  try {
    return localStorage.getItem('search.favorite') === 'yes';
  } catch {
    return false;
  }
});
function toggleFavorite() {
  const next = !favorite;
  setFavorite(next);
  try {
    localStorage.setItem('search.favorite', next ? 'yes' : 'no');
  } catch {
    /* In-memory state still works; persistence is unavailable. */
  }
}
// Perform storage writes in the user event, not inside a state updater.
```

**Keyboard and focus:** keep a labeled input and native form submit so Enter works. Use a status announcement for loading and a distinguishable error alert. Provide an enabled retry action on error; after an explicit failed submission, it may take focus when rendered. After deliberate recovery, focus the meaningful result heading (a programmatically focusable heading can use `tabIndex={-1}`). Track whether focus movement was requested so async results do not steal focus while the user is typing. Keep controls usable at narrow widths.

## 2. Editable records that can move or disappear from view

**Identity:** the canonical `items` prop or server cache owns saved titles; an edit overlay keyed by ID owns user changes that are not yet committed. An input row is a view of those sources, not the only owner of its draft. Index keys bind a row's identity to a _position_, which can silently put an old draft, focused input, or request result on the wrong record after sorting, filtering, or insertion.

```jsx
// Inside the list owner that remains mounted while rows change.
const [draftsById, setDraftsById] = useState({});
const titleFor = (item) =>
  Object.prototype.hasOwnProperty.call(draftsById, item.id)
    ? draftsById[item.id] // Includes an intentional empty string.
    : item.title; // Fresh canonical data for unedited rows.

const visible = items
  .filter((item) => matchesFilter(item, filter)) // New array; do not sort props in place.
  .sort(compareRows)
  .slice(offset, offset + windowSize);

const changeDraft = (id, value) => setDraftsById((previous) => ({ ...previous, [id]: value }));
// In JSX: visible.map(item => <Row key={item.id} item={item}
//   value={titleFor(item)} onChange={value => changeDraft(item.id, value)} />)
```

Keep row status and saves in flight keyed by the same stable ID at the list owner. When an item leaves the filter or rendered window, its draft and pending save continue; the row's DOM lifetime does not determine the save's lifetime. If a _canonical item_ is deleted, the list owner unmounts, or a save for the same ID is superseded, cancel the affected work and invalidate any late completion. Do not silently discard a draft when a server refresh updates another item. If the server refreshes the _edited_ item, choose a conflict rule (preserve and flag the local edit, merge using versions, or explicitly discard it) rather than overwriting user input.

**Save lifetime:** use a map of requests in flight, `id -> { requestId, controller }`, in the list owner, with an incrementing request ID for each save. On save, snapshot the submitted text, set that ID's busy status, and call the actual save API with the signal if supported. On resolution or rejection, compare the active request ID and aborted state _before_ updating a draft, status, or parent `onCommit`. Cleanup aborts and invalidates active requests when the list owner unmounts; deletion or supersession invalidates just that ID. This prevents late client commits even when an aborted promise resolves. It does not prove the server rolled back a write: use versioning, idempotency keys, or an authoritative refresh if the server can apply a cancelled request.

```jsx
// Inside the stable list owner. Assumes saveItem, onCommit, and state setters exist.
const pending = useRef(new Map());
const nextRequestId = useRef(0);
useEffect(
  () => () => {
    for (const { controller } of pending.current.values()) controller.abort();
    pending.current.clear(); // A slow, already-aborted promise must fail identity checks.
  },
  [],
);

async function saveOne(id, submitted) {
  pending.current.get(id)?.controller.abort(); // Supersede only this ID.
  const controller = new AbortController();
  const requestId = ++nextRequestId.current;
  pending.current.set(id, { controller, requestId });
  setSaveStatus((old) => ({ ...old, [id]: { state: 'saving' } }));
  try {
    const saved = await saveItem(id, submitted, { signal: controller.signal });
    if (controller.signal.aborted || pending.current.get(id)?.requestId !== requestId) return;
    if (saved.id !== id) throw new Error('Save returned an unexpected item ID');
    onCommit(id, saved.title);
    setDraftsById((old) => {
      if (!Object.prototype.hasOwnProperty.call(old, id) || old[id] !== submitted) return old;
      const next = { ...old };
      delete next[id]; // Preserve a newer draft entered during the request.
      return next;
    });
    setSaveStatus((old) => ({ ...old, [id]: { state: 'saved' } }));
  } catch (error) {
    if (controller.signal.aborted || pending.current.get(id)?.requestId !== requestId) return;
    setSaveStatus((old) => ({
      ...old,
      [id]: { state: 'error', message: String(error.message ?? error) },
    }));
  } finally {
    if (pending.current.get(id)?.requestId === requestId) pending.current.delete(id);
  }
}
```

For a successful save, commit the response's authoritative ID and value, and clear the edit overlay only if the current draft still equals the text submitted. A user may type a newer draft while a save is in flight. For a failed save, keep the draft, expose an error for that ID, and let retry submit the _current_ draft. Restoring focus to the relevant retry control is useful when that row is visible; when a row leaves the DOM, focus a stable surrounding control or announcement instead of targeting an element that no longer exists.

Keep the displayed row count bounded by the window size. Stable keys preserve focus for elements that remain mounted through reordering, while filtering and window changes require a deliberate focus policy. Measure representative React commits/render cost with a profiler or browser instrumentation; avoid `memo` and `useMemo` until there is a concrete cost or a reference stability contract to satisfy.

## 3. Verify by observable transitions

The build establishes syntax and packaging; behavior needs actual interaction in the supported browser. Run both the ordinary and the deliberately inconvenient sequence, and record the observation that supports each conclusion.

| Boundary               | Interaction to exercise                                                                                  | Evidence to inspect                                                                                              |
| ---------------------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Async search identity  | Start a delayed query, then a faster query, and allow the delayed promise to settle                      | Latest query owns the visible result; aborted/ignored completion cannot replace it.                              |
| Search recovery        | Cause an error, retry the _same_ query, then query for zero matches                                      | Retry starts another request; failure, recovery, and empty UI remain distinct.                                   |
| History and teardown   | Submit with Enter; navigate back and forward; unmount before a response settles                          | URL, input, and results agree; no client update after unmount; listener and request cleanup observed.            |
| Preference lifetime    | Change a setting, navigate, remount, and reload where required                                           | The durable source and rendered preference still agree.                                                          |
| Row identity           | Edit a row; sort, insert, delete, filter away/back, and move the visible window                          | The same ID retains its draft; other IDs never inherit it; focus remains on the intended row when still mounted. |
| Refresh and save       | Refresh another row while a draft exists; fail a save, retry, supersede or unmount during a delayed save | Canonical and draft values follow the conflict rule; retries retain edits; superseded callbacks do not commit.   |
| Accessibility and cost | Use with the keyboard alone, error/focus recovery, narrow viewport, representative list update           | Focus and announcements are usable; DOM window is bounded; measured commits/cost are reported, not assumed.      |

If the task requests a result or verification evidence on disk, inspect the documented schema, execute the interactions, and write the _observed_ version, browser, state ownership, results, failures, and unresolved checks. Verify that files exist, parse, and match the schema. Do not substitute invented browser results, fill unobserved checks with guesses, or modify a fixture, test harness, or evaluator to manufacture a pass. Distinguish a successful build, an inspected DOM state, and independent runtime checks in the final report.
