<script lang="ts" generics="T extends { id: string }">
    // Variable-height Virtual List Component
    // Handles items with dynamic heights (markdown, code blocks, tool results)
    
    import { onMount, untrack } from 'svelte';
    import type { Snippet } from 'svelte';
    
    interface Props {
        items: T[];
        estimateHeight: (item: T) => number;
        overscan?: number;
        class?: string;
        onScroll?: (distFromBottom: number) => void;
        onScrollNearBottom?: () => void;
        onReady?: (el: HTMLDivElement) => void;
        row?: Snippet<[T, number]>;
        /** When true, keep the view pinned to the bottom authoritatively —
         *  using totalHeight (which accounts for un-rendered rows), not DOM
         *  scrollHeight. The parent flips this off when the user scrolls up. */
        follow?: boolean;
    }
    
    let { items, estimateHeight, overscan = 5, class: className = '', onScroll, onScrollNearBottom, onReady, row, follow = false }: Props = $props();
    
    // DOM refs
    let containerEl = $state<HTMLDivElement>();
    
    // Measured heights cache
    let heightCache = $state<Map<string, number>>(new Map());
    let heightVersion = $state(0);
    let positionIndex = new Map<string, { top: number; height: number }>();
    let itemIndex = new Map<string, number>();
    let rowObserver: ResizeObserver | null = null;
    let rowResizeFrame: number | null = null;
    const pendingRowResizes = new Map<Element, ResizeObserverEntry>();
    const elementToId = new Map<Element, string>();
    
    // Scroll state
    let scrollTop = $state(0);
    let clientHeight = $state(800);

    $effect(() => {
        void items.length;
        itemIndex = new Map();
        positionIndex = new Map();
        let top = 0;
        untrack(() => {
            for (let i = 0; i < items.length; i++) {
                const item = items[i];
                itemIndex.set(item.id, i);
                const height = heightCache.get(item.id) ?? estimateHeight(item);
                positionIndex.set(item.id, { top, height });
                top += height;
            }
        });
        // This layout effect invalidates derived positions after rebuilding
        // the index. Read the prior version untracked: `heightVersion++`
        // otherwise subscribes the effect to the very state it writes and can
        // recurse forever as soon as the first feed row appears.
        heightVersion = untrack(() => heightVersion + 1);
    });
    
    // Computed positions
    let positions = $derived.by(() => {
        void heightVersion;
        return items.map((item) => positionIndex.get(item.id) ?? { id: item.id, top: 0, height: estimateHeight(item) });
    });
    
    let totalHeight = $derived(
        positions.length > 0 
            ? positions[positions.length - 1].top + positions[positions.length - 1].height 
            : 0
    );
    
    // When following the bottom, compute visible range relative to total height
    // rather than the raw DOM scrollTop, which lags by a frame/tick on load.
    let effectiveScrollTop = $derived(
        follow && totalHeight > clientHeight
            ? totalHeight - clientHeight
            : scrollTop
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
        
        // Find end
        for (let i = start; i < items.length; i++) {
            const pos = positions[i];
            if (pos && pos.top > effectiveScrollTop + clientHeight + overscan * 100) {
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
    
    let paddingTop = $derived(
        visibleRange.start > 0 && positions[visibleRange.start] 
            ? positions[visibleRange.start].top 
            : 0
    );
    
    let paddingBottom = $derived(
        visibleRange.end >= 0 && visibleRange.end < positions.length - 1
            ? totalHeight - (positions[visibleRange.end]?.top ?? 0) - (positions[visibleRange.end]?.height ?? 0)
            : 0
    );
    
    // Handle scroll
    function handleScroll(e: Event) {
        if (!containerEl) return;
        scrollTop = containerEl.scrollTop;
        
        // Check if near bottom
        const { scrollHeight } = containerEl;
        const dist = scrollHeight - scrollTop - clientHeight;
        onScroll?.(dist);
        if (dist < 200 && onScrollNearBottom) {
            onScrollNearBottom();
        }
    }
    
    // Authoritative bottom-pin for virtualization. totalHeight is the
    // estimated content height and updates as real heights are measured — but
    // rows outside the rendered window (e.g. a collapsed tool/agent block
    // whose real height is much taller than its flat estimate) can leave
    // totalHeight *short* of the DOM's actual scrollHeight for the rows that
    // ARE currently rendered near the bottom. Pinning to totalHeight alone in
    // that case stops short of the true bottom (a "partial" scroll) because
    // the browser clamps our assignment to the real (larger) max scrollTop.
    // Taking the max of totalHeight and the live DOM scrollHeight guarantees
    // we always reach the actual bottom, while still reacting to totalHeight
    // changes as heights converge for rows not yet rendered. Only pins while
    // `follow` is on (user hasn't scrolled up), so it can never fight the user.
    $effect.pre(() => {
        // Track the signals that move the bottom.
        void totalHeight;
        void items.length;
        if (!follow || !containerEl) return;
        // Pin synchronously; the autoscroll controller's coalesced rAF
        // (fired by the per-token signal) is the authoritative pin.
        const target = Math.max(totalHeight, containerEl.scrollHeight);
        if (Math.abs(containerEl.scrollTop + containerEl.clientHeight - target) > 1) {
            containerEl.scrollTop = target;
        }
    });

    // Measure item heights after render
    // FIX: Use ResizeObserver to batch updates instead of one-by-one state triggers
    function applyRowResizes(entries: ResizeObserverEntry[]) {
        let changed = false;
        for (const entry of entries) {
            const id = elementToId.get(entry.target);
            if (!id) continue;
            const height = entry.borderBoxSize[0]?.blockSize ?? entry.contentRect.height;
            if (height <= 0) continue;
            const idx = itemIndex.get(id);
            if (idx === undefined) continue;
            const pos = positionIndex.get(id);
            const previousHeight = pos?.height ?? heightCache.get(id) ?? estimateHeight(items[idx]);
            if (previousHeight === height) continue;
            // Rows are initially estimated, then measured after they
            // mount. If a tall rich response above the reader grows
            // from its estimate, compensate by the same delta so the
            // visible message stays put instead of jumping. Native
            // scroll anchoring is disabled below to avoid applying
            // this correction twice.
            if (!follow && containerEl && pos && pos.top < containerEl.scrollTop) {
                containerEl.scrollTop += height - previousHeight;
            }
            const delta = height - previousHeight;
            positionIndex.set(id, { top: pos?.top ?? 0, height });
            for (let i = idx + 1; i < items.length; i++) {
                const p = positionIndex.get(items[i].id);
                if (p) positionIndex.set(items[i].id, { top: p.top + delta, height: p.height });
            }
            heightCache.set(id, height);
            changed = true;
        }
        if (changed) heightVersion++;
    }

    function onRowResize(entries: ResizeObserverEntry[]) {
        // A row-height update changes the virtual spacer and can resize other
        // observed rows. Defer that reactive write until this observer cycle
        // has completed to avoid browser ResizeObserver loop warnings.
        for (const entry of entries) pendingRowResizes.set(entry.target, entry);
        if (rowResizeFrame !== null) return;
        rowResizeFrame = requestAnimationFrame(() => {
            rowResizeFrame = null;
            const pending = [...pendingRowResizes.values()];
            pendingRowResizes.clear();
            applyRowResizes(pending);
        });
    }

    function measureItem(element: HTMLElement, id: string) {
        if (!rowObserver) rowObserver = new ResizeObserver(onRowResize);
        elementToId.set(element, id);
        rowObserver.observe(element);
        return {
            update(nextId: string) {
                elementToId.set(element, nextId);
            },
            destroy() {
                if (rowObserver) rowObserver.unobserve(element);
                elementToId.delete(element);
            },
        };
    }
    
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
        
        return () => {
            ro.disconnect();
            if (rowObserver) {
                rowObserver.disconnect();
                rowObserver = null;
            }
            if (rowResizeFrame !== null) cancelAnimationFrame(rowResizeFrame);
            rowResizeFrame = null;
            pendingRowResizes.clear();
        };
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
        const idx = items.findIndex(item => item.id === id);
        if (idx >= 0 && containerEl) {
            const pos = positions[idx];
            if (pos) {
                containerEl.scrollTo({ top: pos.top, behavior: 'smooth' });
            }
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
        style="padding-top: {paddingTop}px; padding-bottom: {paddingBottom}px;"
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
