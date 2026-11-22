<script lang="ts" generics="T extends { id: string }">
    // Variable-height Virtual List Component
    // Handles items with dynamic heights (markdown, code blocks, tool results)

    import { onDestroy, onMount, untrack } from 'svelte';
    import type { Snippet } from 'svelte';
    import { EXPAND_ANCHOR_EVENT } from '$lib/utils/expand-anchor';
    import {
        getTranscriptScrollState,
        saveTranscriptScrollState,
    } from '$lib/utils/transcript-scroll';

    // Pixels of rendered rows kept beyond each edge of the viewport. Row-count
    // overscan alone scales with row height, so it is either wasteful for short
    // rows or far too little for tall ones.
    const OVERSCAN_PX = 600;
    // Ceiling on the rows walked back to build up pixel overscan, so a
    // transcript of very short rows cannot render the whole thing.
    const MAX_HEADROOM_ROWS = 60;
    // Consecutive quiet frames before an opened transcript counts as landed.
    const LANDING_STABLE_FRAMES = 2;
    // Hard ceiling so continuous streaming or a wedged measurement can never
    // hold the caller's loading surface up indefinitely.
    const LANDING_MAX_FRAMES = 24;
    const LANDING_FALLBACK_MS = 600;

    interface Props {
        items: T[];
        estimateHeight: (item: T) => number;
        overscan?: number;
        class?: string;
        onScroll?: (distFromBottom: number) => void;
        onScrollNearTop?: () => void;
        onScrollNearBottom?: () => void;
        onReady?: (el: HTMLDivElement) => void;
        /** Fired once an opened transcript has landed at its initial position
         *  and its first measurement batches have stopped moving the bottom.
         *  Callers keep an opaque loading surface over the list until then, so
         *  the reader sees a spinner and then the finished chat, never the
         *  estimated rows converging underneath. */
        onLanded?: () => void;
        /** Restore the reader's last position when reopening a transcript. */
        onRestoreState?: (state: { follow: boolean }) => void;
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
        /** False while the caller is still replacing a cached snapshot with
         *  authoritative history. The list waits for authoritative rows before
         *  placing the transcript, so a deep saved anchor cannot be clamped
         *  against a page that is about to be replaced. */
        ready?: boolean;
    }

    let { items, estimateHeight, overscan = 5, class: className = '', onScroll, onScrollNearTop, onScrollNearBottom, onReady, onLanded, onRestoreState, row, follow = false, resetKey, ready = true }: Props = $props();
    
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
    // True while the transcript is showing a restored reader position. The
    // `follow` prop arrives one flush after `onRestoreState()` reports the
    // restore, so without this the bottom-pin effect below would fire once
    // with the stale `follow: true` and undo the restore.
    let openingRestore = $state(false);
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

    // ─── Landing ──────────────────────────────────────────────────────────
    // Rows mount from estimates and are measured over the next few frames.
    // While following, every batch that changes the transcript height re-pins
    // the bottom. The caller keeps an opaque cover over the list until this
    // loop reports that the landing has stopped moving, so that convergence is
    // never visible as a fast scroll down the transcript.
    let landingComplete = false;
    let landingRaf: number | null = null;
    let landingTimer: ReturnType<typeof setTimeout> | undefined;
    let landingFrames = 0;
    let stableFrames = 0;
    let layoutRevision = 0;
    let lastLayoutRevision = 0;

    function fireLanded() {
        if (landingComplete) return;
        landingComplete = true;
        if (landingRaf !== null) {
            cancelAnimationFrame(landingRaf);
            landingRaf = null;
        }
        if (landingTimer !== undefined) {
            clearTimeout(landingTimer);
            landingTimer = undefined;
        }
        onLanded?.();
    }

    function checkLandingSettled() {
        landingRaf = null;
        if (landingComplete || !onLanded) return;
        landingFrames++;
        const el = containerEl;
        const quiet =
            measurementFrame === null &&
            pendingRowSizes.size === 0 &&
            pendingDeltas.length === 0;
        // The list owns the transcript's extent, so the landing reports against
        // that extent — not the DOM's `scrollHeight`. The scroll element's
        // padding and a rendered window that briefly overflows `contentHeight`
        // both make `scrollHeight` disagree with `totalHeight`, and a
        // frame-by-frame comparison against the DOM reset the stable-frame
        // counter until the 24-frame cap. `scrollTop` is clamped by the browser
        // to the real bottom, so a genuinely pinned view satisfies this even
        // when the two extents differ.
        const pinned = !follow || !el || el.scrollTop + el.clientHeight >= totalHeight - 2;
        if (quiet && pinned && layoutRevision === lastLayoutRevision) stableFrames++;
        else stableFrames = 0;
        lastLayoutRevision = layoutRevision;
        if (stableFrames >= LANDING_STABLE_FRAMES || landingFrames >= LANDING_MAX_FRAMES) {
            fireLanded();
            return;
        }
        landingRaf = requestAnimationFrame(checkLandingSettled);
    }

    function armLanding() {
        if (!onLanded || landingComplete) return;
        landingComplete = false;
        landingFrames = 0;
        stableFrames = 0;
        lastLayoutRevision = layoutRevision;
        if (landingRaf === null && typeof requestAnimationFrame === 'function') {
            landingRaf = requestAnimationFrame(checkLandingSettled);
        }
        // A backgrounded tab stops delivering frames. The fallback must not
        // reveal a half-measured transcript while rAF is paused; wait until
        // the reader can actually see it again.
        if (landingTimer === undefined) {
            landingTimer = setTimeout(onLandingFallback, LANDING_FALLBACK_MS);
        }
    }

    function onLandingFallback() {
        landingTimer = undefined;
        if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
            landingTimer = setTimeout(onLandingFallback, LANDING_FALLBACK_MS);
            return;
        }
        fireLanded();
    }

    // ─── Prepend / viewport anchoring ─────────────────────────────────────
    // An older page is prepended while the reader is near the top. The DOM
    // keeps scrollTop, so the rows they were reading move down by the height
    // of the new page. Remember the row at the viewport top and put it back
    // after the layout changes; without this, scroll-up paging feels like a
    // jump and the next scroll event immediately loads another page.
    let viewportAnchor: { id: string; offset: number } | null = null;

    function anchorAtOffset(offset: number): { id: string; offset: number; index: number } | null {
        if (positions.length === 0) return null;
        let low = 0;
        let high = positions.length - 1;
        let found = 0;
        while (low <= high) {
            const mid = (low + high) >> 1;
            if (positions[mid].top <= offset) {
                found = mid;
                low = mid + 1;
            } else {
                high = mid - 1;
            }
        }
        const position = positions[found];
        return position
            ? { id: position.id, offset: offset - position.top, index: found }
            : null;
    }

    function rememberViewportAnchor() {
        if (!containerEl || follow) {
            viewportAnchor = null;
            return;
        }
        viewportAnchor = anchorAtOffset(containerEl.scrollTop);
    }

    function rememberScrollState(id: string, top: number, shouldFollow: boolean) {
        if (!id) return;
        const anchor = shouldFollow ? null : anchorAtOffset(top);
        saveTranscriptScrollState(id, {
            scrollTop: top,
            follow: shouldFollow,
            ...(anchor
                ? {
                      anchorId: anchor.id,
                      anchorOffset: anchor.offset,
                      rowsAfterAnchor: positions.length - anchor.index - 1,
                  }
                : {}),
        });
    }

    // Initialize scrollTop based on follow prop
    $effect(() => {
        if (follow) {
            scrollTop = Number.MAX_SAFE_INTEGER;
            // A fresh follow starts from the real bottom, not from whatever the
            // previous transcript's offset was. The mount pass fills the real
            // value in before the transcript is shown.
            followBottom = null;
            // Following is the reader asking for the bottom again, which ends
            // any restored position they had been parked on.
            openingRestore = false;
        } else {
            followBottom = null;
        }
    });

    /**
     * Position a transcript that has just opened.
     *
     * Opening a chat is a fresh read, not a resumption: the reader should see
     * the newest messages. The one exception is a reader who had deliberately
     * scrolled up out of auto-scroll when they left — that position is theirs,
     * so it is restored instead of being pulled to the bottom.
     *
     * The write is unconditional and instant (no `scrollTo` animation): the
     * landing must be part of the first paint, not a visible scroll downwards.
     */
    function landOnOpen(id: string): void {
        const restored = getTranscriptScrollState(id);
        const anchorIndex = restored?.anchorId ? indexById.get(restored.anchorId) : undefined;
        const anchorPosition = anchorIndex === undefined ? undefined : positions[anchorIndex];
        // A saved row is authoritative over the pixel offset: the row may have
        // changed height since it was measured, and the resume page may start
        // dozens of messages later than the page that was open when it was
        // saved. Put that row back at the same screen position.
        const restoredTop = anchorPosition
            ? anchorPosition.top + (restored?.anchorOffset ?? 0)
            : (restored?.scrollTop ?? 0);
        // A parked position is only worth restoring when it is genuinely above
        // the bottom. A saved offset sitting at the bottom with follow off left
        // the chat looking anchored while nothing followed the agent, so the
        // first thing that grew (the reader's own next message) arrived to a
        // frozen view and then moved it by hand. Treat that state as following.
        const bottomOffset = Math.max(0, totalHeight - clientHeight);
        const parked = !!restored && !restored.follow && restoredTop < bottomOffset - 8;
        onRestoreState?.({ follow: !parked });
        // Arm even when the container has not bound yet: the fallback still
        // releases the caller's cover instead of stranding the spinner.
        armLanding();
        if (!containerEl) return;
        openingRestore = parked;
        if (parked) {
            // The browser clamps this to the transcript's real extent.
            containerEl.scrollTop = restoredTop;
        } else {
            pinToBottomNow();
        }
        scrollTop = containerEl.scrollTop;
        rememberViewportAnchor();
    }

    // The caller may mount the list over a cached snapshot while the
    // authoritative first page is still in flight. Positioning against that
    // snapshot and then replacing it is what clamped a deep saved position to
    // the bottom of the newest page. Wait for `ready` instead.
    let pendingOpenLanding = false;

    function landOpenWhenReady(id: string): void {
        if (!ready) {
            pendingOpenLanding = true;
            return;
        }
        pendingOpenLanding = false;
        landOnOpen(id);
    }

    $effect(() => {
        if (!ready || !pendingOpenLanding) return;
        untrack(() => {
            pendingOpenLanding = false;
            landOnOpen(transcriptId);
        });
    });

    // Opening a different chat is a different transcript, not a content change.
    // Row ids can collide across chats, so measurements are filed per
    // transcript and only the new one's are loaded.
    let lastResetKey: string | number | undefined = untrack(() => resetKey);
    $effect(() => {
        const key = resetKey;
        if (key === lastResetKey) return;
        if (containerEl) rememberScrollState(transcriptId, containerEl.scrollTop, follow);
        lastResetKey = key;
        const nextId = transcriptKey(key);
        if (nextId !== transcriptId) {
            pendingRowSizes.clear();
            rememberTranscript(transcriptId, heightCache);
            transcriptId = nextId;
            seedHeights(nextId);
        }
        untrack(() => {
            followBottom = null;
            expandAnchors.clear();
            anchoredTop = null;
            // A new transcript needs a new landing report; the old anchor id
            // belongs to rows that may not exist here.
            landingComplete = false;
            viewportAnchor = null;
            landOpenWhenReady(nextId);
        });
    });

    // Mounting is an open. Set the initial position once before the transcript
    // is revealed; later row measurements must not move the reader through the
    // restored chat.
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
            landOpenWhenReady(transcriptId);
        });
    });

    // While the reader is following, the bottom is the invariant.
    //
    // Rows are laid out from estimates first and measured afterwards, so an
    // opened chat grows under the viewport across several measurement batches.
    // Correcting the offset in the same flush that publishes the new layout —
    // instead of waiting for the resulting scroll event — is what turns the
    // landing into a single instant position rather than a crawl of jumps
    // downwards as each batch of rows settles.
    //
    // This stays inert when the reader is parked mid-transcript (follow off),
    // where the compensation effect below owns the offset instead.
    //
    // It also stays inert while the transcript is still landing. During an open
    // the viewport height is not stable: sibling chrome above and below the feed
    // (the context bar moving from "awaiting report" to "used / max", the
    // composer growing) resizes this container, and re-pinning on each of those
    // resizes is what made an opening chat look like it was scrolling itself
    // into place. The landing loop owns the position until it reports.
    //
    // The two triggers are deliberately separate. Content growth (`totalHeight`)
    // must be absorbed even mid-landing — that is what keeps a measured row from
    // shifting the transcript — while a viewport resize (`clientHeight`) must
    // not move the reader until the open has landed.
    $effect(() => {
        void totalHeight;
        if (!ready) return;
        if (openingRestore || !follow || !containerEl) return;
        untrack(() => pinToBottomNow());
    });

    $effect(() => {
        void clientHeight;
        if (!ready) return;
        // Only a caller that asked for a landing report gets the deferred
        // viewport handling. Without `onLanded` there is no landing loop to own
        // the position, so a resize must be absorbed immediately as before.
        if (onLanded && !landingComplete) return;
        if (openingRestore || !follow || !containerEl) return;
        untrack(() => pinToBottomNow());
    });
    
    // Keep what this transcript taught us about its rows when the view goes
    // away — switching chats unmounts the list, and coming back to a chat is
    // the common case, not the rare one.
    onDestroy(() => {
        rowObserver?.disconnect();
        rowObserver = null;
        rowResizeHandlers.clear();
        pendingRowSizes.clear();
        pendingClientHeight = null;
        if (measurementFrame !== null) cancelAnimationFrame(measurementFrame);
        measurementFrame = null;
        if (landingRaf !== null) cancelAnimationFrame(landingRaf);
        landingRaf = null;
        if (landingTimer !== undefined) clearTimeout(landingTimer);
        landingTimer = undefined;
        rememberTranscript(transcriptId, heightCache);
        if (containerEl) rememberScrollState(transcriptId, containerEl.scrollTop, follow);
    });

    // Computed layout: where every row sits and how tall the transcript is.
    // Rebuilt when the items change or a row is measured. The id→index maps
    // exist so the measurement pass can answer "which row is this, and is it
    // above the viewport?" without scanning the transcript — the scan ran once
    // per changed row, on every frame of a scroll.
    let layout = $derived.by(() => {
        void heightsVersion;
        const rows: { id: string; item: T; index: number; top: number; height: number }[] = [];
        const indexById = new Map<string, number>();
        const itemById = new Map<string, T>();
        let top = 0;

        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            const height = heightCache.get(item.id) ?? estimateHeight(item);
            indexById.set(item.id, i);
            itemById.set(item.id, item);
            rows.push({ id: item.id, item, index: i, top, height });
            top += height;
        }

        return { rows, indexById, itemById, totalHeight: top };
    });

    let positions = $derived(layout.rows);
    let indexById = $derived(layout.indexById);
    let itemById = $derived(layout.itemById);
    let totalHeight = $derived(layout.totalHeight);

    // A new `items` array is a new layout: an older page prepended, a reload
    // merging tool rows, or a live entry arriving. Put the row the reader was
    // looking at back at the same screen position when they are parked, and
    // tell the landing loop the layout moved so it waits for the new rows to
    // measure before reporting the open as complete.
    $effect(() => {
        const list = items;
        void list;
        layoutRevision++;
        untrack(() => {
            if (!viewportAnchor || !containerEl || follow || openingRestore) return;
            const index = indexById.get(viewportAnchor.id);
            const position = index === undefined ? undefined : positions[index];
            if (!position) return;
            const target = position.top + viewportAnchor.offset;
            if (Math.abs(target - containerEl.scrollTop) <= 1) return;
            containerEl.scrollTop = target;
            scrollTop = containerEl.scrollTop;
        });
    });

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
        
        // Reuse the layout records while scrolling over measured rows. Fresh
        // wrappers here invalidate every retained keyed row on every scroll,
        // even though its item, transcript index and position are unchanged.
        return positions.slice(visibleRange.start, visibleRange.end + 1);
    });
    
    // Handle scroll
    function handleScroll(e: Event) {
        if (!containerEl) return;
        scrollTop = containerEl.scrollTop;
        // Save positions at transcript switches and on unmount; avoid mutating
        // the shared position cache on every synthetic scroll event.
        // While following, the rendered window must track the offset the
        // container is actually at — including a reader drag that has not
        // disengaged follow yet — otherwise the window and the scrollbar
        // disagree and the transcript visibly jumps.
        if (follow) followBottom = scrollTop;
        rememberViewportAnchor();

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
        if (scrollTop < 200) onScrollNearTop?.();
        if (dist < 200 && onScrollNearBottom) {
            onScrollNearBottom();
        }
    }

    /** Move the container to the bottom and remember the offset we reached. */
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

    // One ResizeObserver for the whole list's rows, rather than one per row.
    // Rows mount and unmount continuously while a transcript is scrolled, and
    // allocating, observing and disconnecting an observer per row was work on
    // exactly the path a reader complains about. Entries are routed back to the
    // row that produced them.
    let rowObserver: ResizeObserver | null = null;
    const rowResizeHandlers = new Map<Element, (entries: ResizeObserverEntry[]) => void>();
    const pendingRowSizes = new Map<Element, ResizeObserverEntry>();
    let pendingClientHeight: number | null = null;
    let measurementFrame: number | null = null;

    // Resize delivery must only collect measurements. Publishing a reactive
    // height here re-renders the row window (and adjusts scrollTop) before the
    // browser finishes delivering sizes, producing an undelivered-notifications
    // loop in WebKit and Chromium. Commit the latest sizes together next frame;
    // the compensation effect still runs after the new extent is in the DOM.
    function scheduleMeasurements() {
        if (measurementFrame !== null) return;
        measurementFrame = requestAnimationFrame(() => {
            measurementFrame = null;
            const entries = [...pendingRowSizes.values()];
            pendingRowSizes.clear();
            const viewportHeight = pendingClientHeight;
            pendingClientHeight = null;
            for (const entry of entries) rowResizeHandlers.get(entry.target)?.([entry]);
            if (viewportHeight !== null) clientHeight = viewportHeight;
            if (pendingDeltas.length > 0) heightsVersion++;
        });
    }

    function observeRowSize(element: Element, handler: (entries: ResizeObserverEntry[]) => void) {
        rowResizeHandlers.set(element, handler);
        if (!rowObserver) {
            rowObserver = new ResizeObserver((entries) => {
                for (const entry of entries) pendingRowSizes.set(entry.target, entry);
                scheduleMeasurements();
            });
        }
        rowObserver.observe(element);
    }

    function unobserveRowSize(element: Element) {
        rowResizeHandlers.delete(element);
        pendingRowSizes.delete(element);
        rowObserver?.unobserve(element);
    }

    // Height changes measured since the compensation pass last ran. Filled by the
    // per-row observers, drained by the effect below.
    let pendingDeltas: { id: string; amount: number }[] = [];

    // Measure item heights after render.
    //
    // The measurement frame records what changed. Deciding what to do about it —
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
                const height = entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height;
                if (height <= 0) continue;
                const item = itemById.get(currentId);
                const previous = heightCache.get(currentId) ?? (item ? estimateHeight(item) : height);
                if (previous === height && heightCache.has(currentId)) continue;
                heightCache.set(currentId, height);
                pendingDeltas.push({ id: currentId, amount: height - previous });
            }
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
                pendingClientHeight = entry.contentRect.height;
            }
            scheduleMeasurements();
        });
        ro.observe(containerEl);

        // Svelte's destroy path does not run reliably when the app is closed
        // or the page is killed; the last position must already be stored or
        // the next open cannot restore it. `pagehide` fires on every unload.
        const persistPosition = () => {
            if (containerEl) {
                rememberScrollState(transcriptId, containerEl.scrollTop, follow);
            }
        };
        window.addEventListener('pagehide', persistPosition);

        return () => {
            ro.disconnect();
            pendingClientHeight = null;
            window.removeEventListener('pagehide', persistPosition);
        };
    });
    
    // Expose methods
    export function getScrollElement(): HTMLDivElement | undefined {
        return containerEl;
    }

    export function scrollToBottom(behavior: ScrollBehavior = 'instant') {
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
    // of the list. Reusing measurements lets a reopened chat render its saved
    // position without repeatedly moving the scroll offset as rows settle.
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
        measuredHeights.set(id, new Map(heights));
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
        <!-- Only the rendered window is positioned. Its rows stay in normal
             flow, so an animated row's neighbors move with it in the same
             layout pass, rather than overlapping until ResizeObserver's next
             measurement frame updates a separate absolute top for each row. -->
        <div class="virtual-list-window" style="top: {visibleItems[0]?.top ?? 0}px;">
            {#each visibleItems as { item, index } (item.id)}
                <div class="virtual-list-item" use:measureItem={item.id}>
                    {@render row?.(item, index)}
                </div>
            {/each}
        </div>
    </div>
</div>

<style>
    .virtual-list {
        height: 100%;
        overflow-x: hidden;
        overflow-y: auto;
        position: relative;
        /* Native overlay scrollbars must stay in the transcript's base layer,
           including while scrolling/hovering promotes them in the compositor. */
        z-index: 0;
        isolation: isolate;
        contain: paint;
        overflow-anchor: none;
    }
    
    .virtual-list-content {
        position: relative;
        min-height: 100%;
    }
    
    .virtual-list-window {
        position: absolute;
        left: 0;
        right: 0;
    }
    .virtual-list-item {
        display: flow-root;
        min-width: 0;
    }
</style>
