<script lang="ts" generics="T extends { id: string }">
    // Variable-height Virtual List Component
    // Handles items with dynamic heights (markdown, code blocks, tool results)

    import { onDestroy, onMount, untrack } from 'svelte';
    import type { Snippet } from 'svelte';
    import { EXPAND_ANCHOR_EVENT } from '$lib/utils/expand-anchor';

    // Pixels of rendered rows kept beyond each edge of the viewport. Row-count
    // overscan alone scales with row height, so it is either wasteful for short
    // rows or far too little for tall ones.
    const OVERSCAN_PX = 600;
    // Ceiling on the rows walked back to build up pixel overscan, so a
    // transcript of very short rows cannot render the whole thing.
    const MAX_HEADROOM_ROWS = 60;

    interface Props {
        items: T[];
        estimateHeight: (item: T) => number;
        overscan?: number;
        class?: string;
        onScroll?: (distFromBottom: number) => void;
        onScrollNearBottom?: () => void;
        onLandingChange?: (landing: boolean) => void;
        onReady?: (el: HTMLDivElement) => void;
        row?: Snippet<[T, number]>;
        /** When true, keep the view pinned to the bottom authoritatively —
         *  using totalHeight (which accounts for un-rendered rows), not DOM
         *  scrollHeight. The parent flips this off when the user scrolls up. */
        follow?: boolean;
        /** Identity of the currently open chat/thread. When it changes this is
         *  a different transcript: row measurements are looked up per transcript
         *  (row ids are not guaranteed unique across chats) and, when following,
         *  the view restarts at the bottom rather than inheriting the previous
         *  chat's offset. */
        resetKey?: string | number;
    }

    let { items, estimateHeight, overscan = 5, class: className = '', onScroll, onScrollNearBottom, onLandingChange, onReady, row, follow = false, resetKey }: Props = $props();
    
    // DOM refs
    let containerEl = $state<HTMLDivElement>();
    
    // Measured heights for the transcript currently open.
    //
    // A plain Map, mutated in place, rather than a reactive one that is cloned
    // per change: a measurement batch arrives on every frame of a scroll, and
    // cloning meant copying one entry per row in the transcript — thousands of
    // them, tens of times a second, for a value that never leaves the
    // component. `heightsVersion` is the reactive signal instead.
    const heightCache = new Map<string, number>();
    let heightsVersion = $state(0);
    let transcriptId = transcriptKey(untrack(() => resetKey));
    seedHeights(transcriptId);

    /** Load a transcript's remembered measurements into the live cache. */
    function seedHeights(id: string) {
        heightCache.clear();
        for (const [key, height] of measuredHeights.get(id) ?? []) heightCache.set(key, height);
        heightsVersion++;
    }

    // Scroll state
    let scrollTop = $state(0);
    let clientHeight = $state(800);
    // Offset the rendered window is drawn at while `follow` is on. Set from the
    // offset a pin actually reached, and mirrored from real scroll events so
    // the window and the scrollbar can never disagree.
    let followBottom = $state<number | null>(null);
    // Rows whose reader-initiated expansion is still absorbing its own growth
    // into the scroll offset, so the messages below it keep their screen
    // position instead of being pushed down and out of view.
    const expandAnchors = new Set<string>();
    // Offset the last expansion compensation landed on. Any scroll to
    // somewhere else is the reader reclaiming the viewport, which ends the
    // compensation — otherwise we would keep dragging the view along behind
    // their scroll.
    let anchoredTop: number | null = null;
    // Pixels a single expansion may still move the view by. One viewport: a
    // reasoning panel is a few hundred pixels and must be absorbed in full,
    // while a multi-thousand-pixel tool output must not fling the reader away
    // from where they were reading.
    let anchorBudget = 0;
    // True while a freshly opened transcript is still finding its real bottom
    // — the window is drawn from row estimates and the true offsets only
    // arrive as rows measure. The parent uses this to hold the transcript back
    // until it is showing the last message for real, rather than letting the
    // reader watch it crawl there.
    let landing = $state(false);
    // Frames the landing may still spend re-pinning. Bounded so a transcript
    // that never fully converges (a row whose height keeps changing) is
    // revealed rather than hidden forever.
    const LANDING_FRAMES = 40;
    let landingFrames = 0;

    // Initialize scrollTop based on follow prop
    $effect(() => {
        if (follow) {
            scrollTop = Number.MAX_SAFE_INTEGER;
            // A fresh follow starts from the real bottom, not from whatever the
            // previous transcript's offset was. The pin effect below fills the
            // real value in; until then the window is derived from the estimated
            // total so it never blanks.
            followBottom = null;
        } else {
            followBottom = null;
            // The reader scrolled away mid-landing: they are reading, so stop
            // holding the transcript back and let them read it.
            if (landing) finishLanding();
        }
    });

    // Opening a different chat is a different transcript, not a content change.
    // Row ids can collide across chats, so measurements are filed per
    // transcript and only the new one's are loaded — which is also what makes
    // a chat the reader has already opened land on its real bottom instead of
    // being re-derived from estimates and walked there.
    let lastResetKey: string | number | undefined = untrack(() => resetKey);
    $effect(() => {
        const key = resetKey;
        if (key === lastResetKey) return;
        lastResetKey = key;
        const nextId = transcriptKey(key);
        if (nextId !== transcriptId) {
            rememberTranscript(transcriptId, heightCache);
            transcriptId = nextId;
            seedHeights(nextId);
        }
        untrack(() => {
            followBottom = null;
            scrollTop = 0;
            expandAnchors.clear();
            anchoredTop = null;
            beginLanding();
        });
    });

    // Mounting *is* an open: a freshly mounted transcript starts at the top of
    // its content, because the scroll container's scrollTop is still 0. The
    // bottom pin normally runs inside a rAF, which the browser executes after
    // it has already painted that frame — so the reader saw the start of their
    // own conversation flash past before the pin dragged the view down to the
    // end. Landing the offset here, in the same tick the rows are written,
    // puts the last message in the very first painted frame.
    let mounted = false;
    $effect(() => {
        if (mounted) return;
        mounted = true;
        untrack(() => {
            followBottom = null;
            // Read the real viewport height before pinning: the window drawn
            // for this frame is derived from it, and the 800px placeholder
            // would put the wrong rows on screen for the first paint.
            if (containerEl) clientHeight = containerEl.clientHeight;
            beginLanding();
            pinToBottomNow();
        });
    });
    
    // Keep what this transcript taught us about its rows when the view goes
    // away — switching chats unmounts the list, and coming back to a chat is
    // the common case, not the rare one.
    onDestroy(() => {
        rowObserver?.disconnect();
        rowObserver = null;
        rowResizeHandlers.clear();
        rememberTranscript(transcriptId, heightCache);
    });

    // Computed layout: where every row sits and how tall the transcript is.
    // Rebuilt when the items change or a row is measured. The id→index maps
    // exist so the measurement pass can answer "which row is this, and is it
    // above the viewport?" without scanning the transcript — the scan ran once
    // per changed row, on every frame of a scroll.
    let layout = $derived.by(() => {
        void heightsVersion;
        const rows: { id: string; top: number; height: number }[] = [];
        const indexById = new Map<string, number>();
        const itemById = new Map<string, T>();
        let top = 0;

        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            const height = heightCache.get(item.id) ?? estimateHeight(item);
            indexById.set(item.id, i);
            itemById.set(item.id, item);
            rows.push({ id: item.id, top, height });
            top += height;
        }

        return { rows, indexById, itemById, totalHeight: top };
    });

    let positions = $derived(layout.rows);
    let indexById = $derived(layout.indexById);
    let itemById = $derived(layout.itemById);
    let totalHeight = $derived(layout.totalHeight);

    // Height of the element that holds the rendered rows.
    //
    // This *is* the scrollable extent, and it has to be the transcript's own
    // height. Deriving it from padding above and below the rendered window —
    // the obvious way to build a virtual scroll — makes the extent depend on
    // which rows happen to be rendered, and rows are rendered from estimates,
    // so the extent moves while the reader scrolls. Measured on an 800px
    // viewport, that put the bottom 1760px of a chat permanently out of reach
    // and swung the extent through 48 different values totalling 4525px over a
    // two-second flick upward: the scrollbar resized under the reader and the
    // browser kept re-clamping their scroll offset. Stating the extent
    // outright leaves it changing only when the content's real height changes.
    let contentHeight = $derived(Math.max(totalHeight, clientHeight));
    
    // While following, the window is drawn at the offset the last pin reached.
    // Deriving it from `totalHeight` instead made the window and the scroll
    // offset disagree while rows were still unmeasured, and the transcript
    // visibly slid around during streaming.
    let effectiveScrollTop = $derived(
        follow ? (followBottom ?? Math.max(0, totalHeight - clientHeight)) : scrollTop
    );
    
    // Find visible range using binary search
    let visibleRange = $derived.by(() => {
        if (items.length === 0) return { start: 0, end: -1 };
        
        let start = 0;
        let end = items.length - 1;
        
        // Binary search for start
        let low = 0, high = items.length - 1;
        while (low <= high) {
            const mid = Math.floor((low + high) / 2);
            const pos = positions[mid];
            if (pos && pos.top + pos.height < effectiveScrollTop) {
                low = mid + 1;
            } else {
                high = mid - 1;
            }
        }
        start = Math.max(0, low - overscan);

        // `overscan` rows of headroom is not headroom at all in a transcript of
        // tall messages: five short rows are nothing, and a flick scrolls past
        // them in a frame or two. Keep a viewport's worth of rendered rows
        // above the reader whatever the row heights turn out to be, so moving
        // upward can never outrun the window and expose blank space.
        const headroom = effectiveScrollTop - OVERSCAN_PX;
        while (
            start > 0 &&
            start > low - MAX_HEADROOM_ROWS &&
            positions[start - 1].top + positions[start].height > headroom
        ) {
            start--;
        }
        
        // Find end
        for (let i = start; i < items.length; i++) {
            const pos = positions[i];
            if (pos && pos.top > effectiveScrollTop + clientHeight + OVERSCAN_PX) {
                end = i - 1;
                break;
            }
        }
        end = Math.min(items.length - 1, end + overscan);
        
        return { start, end };
    });
    
    let visibleItems = $derived.by(() => {
        if (visibleRange.end < visibleRange.start) return [];
        
        return items.slice(visibleRange.start, visibleRange.end + 1).map((item, i) => ({
            item,
            index: visibleRange.start + i,
            position: positions[visibleRange.start + i]
        }));
    });
    
    // Handle scroll
    function handleScroll(e: Event) {
        if (!containerEl) return;
        scrollTop = containerEl.scrollTop;
        // While following, the rendered window must track the offset the
        // container is actually at — including a reader drag that has not
        // disengaged follow yet — otherwise the window and the scrollbar
        // disagree and the transcript visibly jumps.
        if (follow) followBottom = scrollTop;

        // A pending expansion only keeps absorbing growth while the reader
        // stays where they were. Landing anywhere else is their own scroll.
        if (expandAnchors.size > 0 && anchoredTop !== null && scrollTop !== anchoredTop) {
            expandAnchors.clear();
            anchoredTop = null;
        }

        // Check if near bottom
        const { scrollHeight } = containerEl;
        const dist = scrollHeight - scrollTop - clientHeight;
        onScroll?.(dist);
        if (dist < 200 && onScrollNearBottom) {
            onScrollNearBottom();
        }
    }

    // ─── Landing on the bottom of a freshly opened transcript ──────────────

    /** Move the container to the bottom and remember the offset we reached.
     *  Synchronous: the caller decides when the write has to land, because
     *  a write inside a rAF is applied after the browser has already painted
     *  the frame it was scheduled from.
     *
     *  `totalHeight` is the real maximum scrollTop, because the element holding
     *  the rendered rows is sized to it. Nothing here has to consult the DOM's
     *  scrollHeight as a second opinion. */
    function pinToBottomNow() {
        if (!containerEl) return;
        if (Math.abs(containerEl.scrollTop + containerEl.clientHeight - totalHeight) > 1) {
            containerEl.scrollTop = totalHeight;
        }
        // Read the offset back rather than assuming it: the browser clamps to
        // the real max scrollTop, and the rendered window is derived from this
        // value so the two can never disagree.
        followBottom = containerEl.scrollTop;
    }

    function isAtBottom(): boolean {
        if (!containerEl) return true;
        return containerEl.scrollHeight - containerEl.scrollTop - containerEl.clientHeight <= 1;
    }

    /** A transcript just opened: hold the view back until its real bottom is
     *  known, so the reader never watches it walk there. */
    function beginLanding() {
        if (!follow) return;
        landing = true;
        landingFrames = LANDING_FRAMES;
    }

    function finishLanding() {
        landing = false;
        landingFrames = 0;
    }
    
    // Authoritative bottom-pin for virtualization. `totalHeight` is the
    // transcript's real height and updates as real heights are measured, and
    // the rendered rows live in an element sized to exactly that, so it is also
    // the real scroll extent — there is no gap between "where the transcript
    // ends" and "where the container stops scrolling". Only pins while `follow`
    // is on (the reader has not scrolled up), so it can never fight them.
    $effect(() => {
        // Track the signals that move the bottom.
        void totalHeight;
        void items.length;
        void clientHeight;
        if (!follow || !containerEl) return;
        // rAF: let padding/layout settle this frame, then pin.
        requestAnimationFrame(landingLoop);

        // While a landing is in progress, keep re-pinning on consecutive
        // frames. Every frame measures another screenful of rows, which moves
        // the true bottom further down, so a single pin leaves the reader
        // short of it and the view walks the rest of the way. The loop stops
        // as soon as a pin actually reaches the bottom, or when its frame
        // budget runs out.
        function landingLoop() {
            if (!follow || !containerEl) {
                if (landing) finishLanding();
                return;
            }
            pinToBottomNow();
            if (!landing) return;
            if (isAtBottom() || --landingFrames <= 0) finishLanding();
            else requestAnimationFrame(landingLoop);
        }
    });

    // A gesture on the transcript during a landing means the reader got there
    // first and is already scrolling it. Reveal it rather than holding back a
    // viewport they are trying to move through.
    onMount(() => {
        if (!containerEl) return;
        const endLanding = () => {
            if (landing) finishLanding();
        };
        containerEl.addEventListener('wheel', endLanding, { passive: true });
        containerEl.addEventListener('pointerdown', endLanding, { passive: true });
        containerEl.addEventListener('touchstart', endLanding, { passive: true });
        return () => {
            containerEl?.removeEventListener('wheel', endLanding);
            containerEl?.removeEventListener('pointerdown', endLanding);
            containerEl?.removeEventListener('touchstart', endLanding);
        };
    });

    // Tell the parent when the transcript is being held back, so it can keep
    // it out of sight until it is showing the last message for real.
    $effect(() => {
        onLandingChange?.(landing);
    });

    // One ResizeObserver for the whole list's rows, rather than one per row.
    // Rows mount and unmount continuously while a transcript is scrolled, and
    // allocating, observing and disconnecting an observer per row was work on
    // exactly the path a reader complains about. Entries are routed back to the
    // row that produced them.
    let rowObserver: ResizeObserver | null = null;
    const rowResizeHandlers = new Map<Element, (entries: ResizeObserverEntry[]) => void>();

    function observeRowSize(element: Element, handler: (entries: ResizeObserverEntry[]) => void) {
        rowResizeHandlers.set(element, handler);
        if (!rowObserver) {
            rowObserver = new ResizeObserver((entries) => {
                for (const entry of entries) rowResizeHandlers.get(entry.target)?.([entry]);
            });
        }
        rowObserver.observe(element);
    }

    function unobserveRowSize(element: Element) {
        rowResizeHandlers.delete(element);
        rowObserver?.unobserve(element);
    }

    // Height changes measured since the compensation pass last ran. Filled by the
    // per-row observers, drained by the effect below.
    let pendingDeltas: { id: string; amount: number }[] = [];

    // Measure item heights after render.
    //
    // The observer only records what changed. Deciding what to do about it —
    // moving the scroll offset to keep the reader's content where it is — is
    // the effect below, and the split is load-bearing: a `scrollTop` write
    // lands in the same frame as the height change it is compensating for, and
    // writing it here, before the new height had been committed to the DOM,
    // let the browser clamp the correction against a scroll extent that had
    // not caught up yet. The reader then saw the shift we meant to cancel, and
    // saw it as a lurch rather than as stillness.
    function measureItem(element: HTMLElement, id: string) {
        let currentId = id;
        const onResize = (entries: ResizeObserverEntry[]) => {
            for (const entry of entries) {
                const height = entry.borderBoxSize[0]?.blockSize ?? entry.contentRect.height;
                if (height <= 0) continue;
                const item = itemById.get(currentId);
                const previous = heightCache.get(currentId) ?? (item ? estimateHeight(item) : height);
                if (previous === height) continue;
                heightCache.set(currentId, height);
                pendingDeltas.push({ id: currentId, amount: height - previous });
            }
            if (pendingDeltas.length > 0) heightsVersion++;
        };
        observeRowSize(element, onResize);
        // The reader expanding a control inside this row: remember it so the
        // growth it causes is absorbed into the scroll offset below.
        const onExpandRequest = () => {
            expandAnchors.add(currentId);
            anchorBudget = clientHeight;
            anchoredTop = containerEl?.scrollTop ?? null;
        };
        element.addEventListener(EXPAND_ANCHOR_EVENT, onExpandRequest);
        return {
            update(nextId: string) {
                currentId = nextId;
            },
            destroy() {
                unobserveRowSize(element);
                element.removeEventListener(EXPAND_ANCHOR_EVENT, onExpandRequest);
            },
        };
    }

    // Scroll compensation for measured height changes.
    //
    // Rows are initially estimated, then measured after they mount. If a tall
    // rich response above the reader settles from its estimate, the whole
    // transcript below it shifts. When the reader is parked mid-transcript we
    // correct scrollTop by the height change of the rows *above* the viewport
    // so their content stays put. Growth the reader asked for (see
    // EXPAND_ANCHOR_EVENT) is corrected even when its row is on screen, so
    // expanding a reasoning panel or a tool's output cannot push the messages
    // below it out of view.
    //
    // Corrections are applied once per batch, after every delta in the batch is
    // known: applying them inside the loop compared each row against a
    // scrollTop that an earlier row in the same batch had already moved, which
    // both mis-attributed the shifts and let the view slide up towards the
    // start of the chat. Native scroll anchoring is disabled in the stylesheet
    // to avoid applying the same correction twice.
    $effect(() => {
        // The trigger: the measured heights this correction is derived from.
        void heightsVersion;
        if (pendingDeltas.length === 0) return;
        const deltas = pendingDeltas;
        pendingDeltas = [];

        if (follow || !containerEl) {
            // The bottom pin already keeps the content below a growth in place,
            // so there is nothing to compensate for here.
            expandAnchors.clear();
            anchoredTop = null;
            return;
        }

        const viewportTop = containerEl.scrollTop;
        const viewportBottom = viewportTop + clientHeight;
        let shift = 0;
        for (const delta of deltas) {
            const index = indexById.get(delta.id);
            const position = index === undefined ? undefined : positions[index];
            if (!position) continue;
            if (position.top < viewportTop) {
                shift += delta.amount;
            } else if (expandAnchors.has(delta.id) && position.top < viewportBottom) {
                // Growth the reader asked for — an expanded reasoning panel or
                // tool output — in a row they can see. Scrolling by the growth
                // keeps everything *below* the expansion exactly where it was
                // and slides the transcript up into the new space, instead of
                // dropping the messages below the viewport. Rows scrolled out of
                // view are left alone: the reader is reading something else.
                const amount = delta.amount > 0 ? Math.min(delta.amount, anchorBudget) : delta.amount;
                shift += amount;
                if (amount > 0) {
                    anchorBudget -= amount;
                    if (anchorBudget <= 0) expandAnchors.delete(delta.id);
                }
            }
        }
        if (shift === 0) return;
        containerEl.scrollTop = viewportTop + shift;
        // Read back: the browser clamps to the real max scrollTop, and that
        // clamped value is what the resulting scroll event will report.
        anchoredTop = containerEl.scrollTop;
    });
    
    // Resize observer for client height
    onMount(() => {
        if (!containerEl) return;
        
        onReady?.(containerEl);
        clientHeight = containerEl.clientHeight;
        
        const ro = new ResizeObserver((entries) => {
            for (const entry of entries) {
                clientHeight = entry.contentRect.height;
            }
        });
        ro.observe(containerEl);
        
        return () => ro.disconnect();
    });
    
    // Expose methods
    export function getScrollElement(): HTMLDivElement | undefined {
        return containerEl;
    }

    export function scrollToBottom(behavior: ScrollBehavior = 'smooth') {
        if (containerEl) {
            containerEl.scrollTo({ top: containerEl.scrollHeight, behavior });
        }
    }
    
    export function scrollToItem(id: string) {
        const idx = indexById.get(id);
        if (idx !== undefined && containerEl) {
            const pos = positions[idx];
            if (pos) {
                containerEl.scrollTo({ top: pos.top, behavior: 'smooth' });
            }
        }
    }
</script>

<script module lang="ts">
    // Measured row heights, kept per transcript and shared across every mount
    // of the list.
    //
    // Why: a chat opened for the first time can only be laid out from row
    // *estimates*, so where its bottom really is stays unknown until rows have
    // been measured. The window opens at the estimated bottom and walks down
    // the transcript as real heights come back — the "opens at the top and
    // autoscrolls to the bottom" behaviour. Reusing the measurements means the
    // second and later opens of a chat are laid out from what is already known
    // and land on the bottom in the frame they are painted.
    const measuredHeights = new Map<string, Map<string, number>>();
    // Transcripts kept in the cache, so a window that walks through hundreds
    // of chats cannot grow it without limit.
    const MEASURED_TRANSCRIPTS = 12;

    function transcriptKey(key: string | number | undefined): string {
        return key === undefined ? '' : String(key);
    }

    function rememberTranscript(id: string, heights: Map<string, number>) {
        if (id === '' || heights.size === 0) return;
        // Re-inserting moves the transcript to the end, so eviction drops the
        // least recently opened one rather than an arbitrary one.
        measuredHeights.delete(id);
        measuredHeights.set(id, heights);
        while (measuredHeights.size > MEASURED_TRANSCRIPTS) {
            const oldest = measuredHeights.keys().next();
            if (oldest.done) break;
            measuredHeights.delete(oldest.value);
        }
    }
</script>

<div 
    bind:this={containerEl}
    class="virtual-list {className}"
    onscroll={handleScroll}
>
    <div 
        class="virtual-list-content"
        style="height: {contentHeight}px;"
    >
        {#each visibleItems as { item, index, position } (item.id)}
            <div 
                class="virtual-list-item"
                style="position: absolute; top: {position?.top ?? 0}px; left: 0; right: 0;"
                use:measureItem={item.id}
            >
                {@render row?.(item, index)}
            </div>
        {/each}
    </div>
</div>

<style>
    .virtual-list {
        height: 100%;
        overflow-y: auto;
        position: relative;
        overflow-anchor: none;
    }
    
    .virtual-list-content {
        position: relative;
        min-height: 100%;
    }
    
    .virtual-list-item {
        position: absolute;
        left: 0;
        right: 0;
    }
</style>
