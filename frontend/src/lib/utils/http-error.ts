/**
 * HTTP error message utilities
 * Extracted to a separate non-runes file to avoid circular dependency issues
 */

/** Map HTTP status codes to user-friendly messages */
export function friendlyHttpError(status: number, action: string): string {
  switch (status) {
    case 401: return `Please sign in to ${action}`;
    case 403: return `You don't have permission to ${action}`;
    case 404: return `Could not find the requested resource`;
    case 429: return `Too many requests — please wait a moment`;
    case 500: case 502: case 503:
      return `Server error — please try again shortly`;
    default: return `Something went wrong (${status})`;
  }
}
