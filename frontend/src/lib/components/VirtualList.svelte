<script lang="ts" generics="T extends { id: string }">
    // Variable-height Virtual List Component
    // Handles items with dynamic heights (markdown, code blocks, tool results)
    
    import { onMount } from 'svelte';
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
    
    // Scroll state
    // Initialize to a large value if follow is true to render bottom items first
    let scrollTop = $state(follow ? Number.MAX_SAFE_INTEGER : 0);
    let clientHeight = $state(800);
    
    // Computed positions
    let positions = $derived.by(() => {
        const result: { id: string; top: number; height: number }[] = [];
        let top = 0;
        
        for (const item of items) {
            const height = heightCache.get(item.id) ?? estimateHeight(item);
            result.push({ id: item.id, top, height });
            top += height;
        }
        
        return result;
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
    
    // Authoritative bottom-pin for virtualization. totalHeight is the TRUE
    // content height (estimated rows included) and updates as real heights are
    // measured — so pinning to it converges to the true bottom even for rows
    // not yet rendered. A DOM ResizeObserver on a fixed-height scroll container
    // never fires on inner growth, which is why scrollHeight-based pinning
    // intermittently fell short. Only pins while `follow` is on (user hasn't
    // scrolled up), so it can never fight the user.
    $effect(() => {
        // Track the signals that move the bottom.
        void totalHeight;
        void items.length;
        if (!follow || !containerEl) return;
        // rAF: let padding/layout settle this frame, then pin.
        requestAnimationFrame(() => {
            if (!follow || !containerEl) return;
            const target = totalHeight; // scroll past rendered content
            if (Math.abs(containerEl.scrollTop + containerEl.clientHeight - target) > 1) {
                containerEl.scrollTop = target;
            }
        });
    });

    // Measure item heights after render
    // FIX: Use ResizeObserver to batch updates instead of one-by-one state triggers
    function measureItem(element: HTMLElement, id: string) {
        let currentId = id;
        const ro = new ResizeObserver((entries) => {
            let changed = false;
            for (const entry of entries) {
                const height = entry.borderBoxSize[0]?.blockSize ?? entry.contentRect.height;
                if (height > 0 && heightCache.get(currentId) !== height) {
                    heightCache.set(currentId, height);
                    changed = true;
                }
            }
            if (changed) {
                heightCache = new Map(heightCache); // Trigger reactivity once per batch
            }
        });
        ro.observe(element);
        return {
            update(nextId: string) {
                currentId = nextId;
            },
            destroy() {
                ro.disconnect();
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
