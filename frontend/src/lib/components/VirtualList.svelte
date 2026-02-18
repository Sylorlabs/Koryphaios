<script lang="ts" generics="T extends { id: string }">
    // Variable-height Virtual List Component
    // Handles items with dynamic heights (markdown, code blocks, tool results)

    import { onMount } from 'svelte';

    interface Props {
        items: T[];
        estimateHeight: (item: T) => number;
        overscan?: number;
        onScrollNearBottom?: () => void;
    }

    let { items, estimateHeight, overscan = 5, onScrollNearBottom }: Props = $props();

    // DOM refs
    let containerEl = $state<HTMLDivElement>();

    // Measured heights cache
    let heightCache = $state<Map<string, number>>(new Map());

    // Scroll state
    let scrollTop = $state(0);
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
            if (pos && pos.top + pos.height < scrollTop) {
                low = mid + 1;
            } else {
                high = mid - 1;
            }
        }
        start = Math.max(0, low - overscan);

        // Find end
        for (let i = start; i < items.length; i++) {
            const pos = positions[i];
            if (pos && pos.top > scrollTop + clientHeight + overscan * 100) {
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
        if (dist < 200 && onScrollNearBottom) {
            onScrollNearBottom();
        }
    }

    // Measure item heights after render
    function measureItem(id: string, element: HTMLDivElement) {
        const height = element.offsetHeight;
        if (height > 0 && heightCache.get(id) !== height) {
            heightCache.set(id, height);
            heightCache = new Map(heightCache); // Trigger reactivity
        }
    }

    // Resize observer for client height
    onMount(() => {
        if (!containerEl) return;

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
    export function scrollToBottom() {
        if (containerEl) {
            containerEl.scrollTo({ top: containerEl.scrollHeight, behavior: 'smooth' });
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
    class="virtual-list"
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
                <slot name="item" {item} {index} />
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