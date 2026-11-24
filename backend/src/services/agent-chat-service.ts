// Chat creation requested by another chat's agent (create_chat). Mirrors the
// user's POST /api/sessions path: the creation lease, the CLI rules and skills
// for the new chat's homes, and the session.updated broadcast. The new chat
// carries createdByAgent provenance and no extra authority.

import type { Session } from '@koryphaios/shared';
import { getContext } from '../context';
import { ConflictError } from '../errors/types';
import { serverLog } from '../logger';
import { writeAllCliRulesAndSkills } from '../providers/cli-rules-skills';
import { setSessionAgentOverrides } from '../stores/session-agent-overrides';
import { MANAGER_AGENT_ID, type CreateAgentChatInput } from '../tools/chat-control';
import { tryAcquireSessionCreationLease } from './session-erasure-service';

export async function createAgentChatSession(input: CreateAgentChatInput): Promise<Session> {
  const { sessions, wsManager } = getContext();
  const lease = tryAcquireSessionCreationLease();
  if (!lease) {
    throw new ConflictError(
      'Session creation is temporarily blocked while delete-all is finishing.',
    );
  }
  let session: Session;
  try {
    const created = await sessions.create(
      'local-user',
      input.title,
      undefined,
      input.workingDirectory,
    );
    session =
      (await sessions.update(created.id, {
        createdByAgent: input.createdByAgent,
        ...(input.model
          ? {
              agentOverrides: {
                managerControls: {
                  [MANAGER_AGENT_ID]: { model: input.model, fallbacks: [] },
                },
              },
            }
          : {}),
      })) ?? created;
  } finally {
    lease.release();
  }
  if (session.agentOverrides) setSessionAgentOverrides(session.id, session.agentOverrides);
  try {
    writeAllCliRulesAndSkills(session.id, '');
  } catch (err: unknown) {
    // Supplementary to the chat itself, as on the user creation path.
    serverLog.warn({ err, sessionId: session.id }, 'Failed to write CLI rules + skills');
  }
  wsManager.broadcastEphemeral({
    type: 'session.updated',
    sessionId: session.id,
    timestamp: Date.now(),
    payload: { session },
  });
  return session;
}
