<script lang="ts">
    // Error Boundary Component - catches and displays errors gracefully
    import { onMount } from 'svelte';

    let error: Error | null = $state(null);
    let errorStack: string | null = $state(null);

    // Global error handler
    function handleError(event: ErrorEvent) {
        error = event.error;
        errorStack = event.error?.stack || null;
        console.error('Error caught by boundary:', event.error);

        // Prevent default error handling
        event.preventDefault();
    }

    // Handle unhandled promise rejections
    function handleRejection(event: PromiseRejectionEvent) {
        const caughtError = event.reason instanceof Error ? event.reason : new Error(String(event.reason));
        error = caughtError;
        errorStack = caughtError.stack || null;
        console.error('Unhandled rejection caught by boundary:', event.reason);

        event.preventDefault();
    }

    onMount(() => {
        window.addEventListener('error', handleError);
        window.addEventListener('unhandledrejection', handleRejection);

        return () => {
            window.removeEventListener('error', handleError);
            window.removeEventListener('unhandledrejection', handleRejection);
        };
    });

    function dismiss() {
        error = null;
        errorStack = null;
    }

    function reload() {
        window.location.reload();
    }

    function copyError() {
        if (error) {
            const errorText = `${error.message}\n\n${errorStack || 'No stack trace available'}`;
            navigator.clipboard.writeText(errorText);
        }
    }
</script>

<slot />

{#if error}
    <div class="error-boundary" role="alert">
        <div class="error-content">
            <div class="error-icon">
                <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <circle cx="12" cy="12" r="10"/>
                    <line x1="12" y1="8" x2="12" y2="12"/>
                    <line x1="12" y1="16" x2="12.01" y2="16"/>
                </svg>
            </div>

            <h2>Something went wrong</h2>
            <p class="error-message">{error.message}</p>

            {#if errorStack}
                <details class="error-details">
                    <summary>Stack Trace</summary>
                    <pre>{errorStack}</pre>
                </details>
            {/if}

            <div class="error-actions">
                <button class="btn btn-primary" onclick={dismiss}>
                    Dismiss
                </button>
                <button class="btn btn-secondary" onclick={copyError}>
                    Copy Error
                </button>
                <button class="btn btn-secondary" onclick={reload}>
                    Reload Page
                </button>
            </div>
        </div>
    </div>
{/if}

<style>
    .error-boundary {
        position: fixed;
        inset: 0;
        z-index: 9999;
        display: flex;
        align-items: center;
        justify-content: center;
        background: rgba(0, 0, 0, 0.8);
        backdrop-filter: blur(8px);
    }

    .error-content {
        max-width: 600px;
        width: 90%;
        padding: 2rem;
        background: var(--color-surface-2, #1a1a2e);
        border-radius: 16px;
        border: 1px solid var(--color-error, #ff4757);
        text-align: center;
    }

    .error-icon {
        color: var(--color-error, #ff4757);
        margin-bottom: 1rem;
    }

    h2 {
        color: var(--color-text-primary, #fff);
        font-size: 1.5rem;
        margin-bottom: 0.5rem;
    }

    .error-message {
        color: var(--color-text-muted, #888);
        margin-bottom: 1.5rem;
    }

    .error-details {
        text-align: left;
        margin-bottom: 1.5rem;
    }

    .error-details summary {
        cursor: pointer;
        color: var(--color-text-muted, #888);
        font-size: 0.875rem;
        margin-bottom: 0.5rem;
    }

    .error-details pre {
        background: var(--color-surface-3, #16213e);
        padding: 1rem;
        border-radius: 8px;
        overflow-x: auto;
        font-size: 0.75rem;
        color: var(--color-error, #ff4757);
        max-height: 200px;
        overflow-y: auto;
    }

    .error-actions {
        display: flex;
        gap: 0.75rem;
        justify-content: center;
        flex-wrap: wrap;
    }

    .btn {
        padding: 0.5rem 1rem;
        border-radius: 8px;
        font-weight: 500;
        cursor: pointer;
        transition: all 0.2s;
    }

    .btn-primary {
        background: var(--color-accent, #6c5ce7);
        color: white;
        border: none;
    }

    .btn-primary:hover {
        filter: brightness(1.1);
    }

    .btn-secondary {
        background: transparent;
        color: var(--color-text-primary, #fff);
        border: 1px solid var(--color-border, #333);
    }

    .btn-secondary:hover {
        background: var(--color-surface-3, #16213e);
    }
</style>