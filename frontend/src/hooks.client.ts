// Client-side hooks — handle errors so we don't get a white screen
import type { HandleClientError } from '@sveltejs/kit';

export const handleError: HandleClientError = async ({ error, message, status }) => {
	console.error('[SvelteKit client error]', status, message, error);
	// Return so the error page can display something; prevents blank screen
	return {
		message: error instanceof Error ? error.message : message,
		statusCode: status ?? 500,
	};
};
