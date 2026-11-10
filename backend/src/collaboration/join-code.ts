import { KoryphaiosError } from '../errors/types';
import type { SharedTeamFolder } from '@koryphaios/shared';

export class RelayJoinError extends KoryphaiosError {}

export interface ResolvedTeamInvite {
  ok: true;
  inviteUrl: string;
  sessionId: string;
  sessionName: string;
  tierId: string;
  hostName?: string;
  sharedFolders?: SharedTeamFolder[];
}

const invalidCode = () =>
  new RelayJoinError(
    'Not a valid code. Check the code with your host and try again.',
    'INVALID_JOIN_CODE',
    400,
  );

/** Validate the format locally, then exchange the code against the live relay. */
export async function resolveTeamJoinCode(
  input: string,
  relayUrl: string | null,
): Promise<ResolvedTeamInvite> {
  const code = input.trim().toUpperCase();
  // Keep in sync with the relay's unambiguous eight-character alphabet.
  if (!/^[A-HJ-NP-Z2-9]{8}$/.test(code)) throw invalidCode();
  if (!relayUrl)
    throw new RelayJoinError(
      'Team joining is unavailable: the collaboration relay is not configured.',
      'RELAY_NOT_CONFIGURED',
      503,
    );

  let response: Response;
  try {
    response = await fetch(`${relayUrl.replace(/\/$/, '')}/code/${encodeURIComponent(code)}`, {
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new RelayJoinError(
      'Cannot reach the team relay. Try again in a moment.',
      'RELAY_UNAVAILABLE',
      503,
    );
  }
  if (response.status === 404 || response.status === 410) throw invalidCode();
  if (response.status === 429)
    throw new RelayJoinError(
      'Too many code attempts. Try again in a minute.',
      'JOIN_CODE_RATE_LIMITED',
      429,
    );
  if (!response.ok)
    throw new RelayJoinError(
      'The team relay could not check this code. Try again in a moment.',
      'RELAY_UNAVAILABLE',
      503,
    );

  const data = await response.json().catch(() => null);
  let invite: URL | null = null;
  try {
    invite = new URL(data?.inviteUrl);
  } catch {
    // An invalid relay payload is not an accepted code.
  }
  if (
    data?.ok !== true ||
    typeof data.sessionId !== 'string' ||
    !data.sessionId ||
    typeof data.sessionName !== 'string' ||
    typeof data.tierId !== 'string' ||
    !data.tierId ||
    !invite ||
    !['http:', 'https:'].includes(invite.protocol) ||
    !invite.searchParams.get('token')
  )
    throw new RelayJoinError(
      'The team relay returned an invalid invitation. Try again in a moment.',
      'RELAY_INVALID_RESPONSE',
      502,
    );
  // Project only the invitation contract; never pass arbitrary relay fields on.
  return {
    ok: true,
    inviteUrl: data.inviteUrl,
    sessionId: data.sessionId,
    sessionName: data.sessionName,
    tierId: data.tierId,
    hostName: typeof data.hostName === 'string' ? data.hostName.slice(0, 80) : 'Host',
    sharedFolders: Array.isArray(data.sharedFolders)
      ? data.sharedFolders
          .slice(0, 24)
          .flatMap((folder: any) =>
            typeof folder?.id === 'string' &&
            typeof folder?.name === 'string' &&
            folder.name.trim() &&
            !/[\\/]/.test(folder.name)
              ? [{ id: folder.id.slice(0, 64), name: folder.name.slice(0, 160) }]
              : [],
          )
      : [],
  };
}
