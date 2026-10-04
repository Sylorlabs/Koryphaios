import { nanoid } from 'nanoid';
import { DEFAULT_COLLABORATION_POLICY, DEFAULT_COLLABORATION_TIERS } from '@koryphaios/shared';
import { ConfigurationError, ValidationError } from '../errors/types';
import { RelayClient } from './relay-client';
import { modelSharingRelayUrl } from './relay-url';
import { buildSharedCatalog, refreshSharedCatalogs, startProviderHost } from './remote-provider-host';

let modelRelay: RelayClient | null = null;
let unregister: (() => void) | null = null;
let modelJoinCode: string | null = null;
let operationTail: Promise<unknown> = Promise.resolve();

function serializeSharingOperation<T>(operation: () => Promise<T>): Promise<T> {
  const result = operationTail.then(operation);
  // A failed operation must not prevent a later stop or configuration retry.
  operationTail = result.catch(() => undefined);
  return result;
}

export function modelSharingStatus() {
  return {
    active: modelRelay?.isConnected === true,
    hostName: modelRelay?.policy?.hostName ?? null,
    joinCode: modelRelay?.isConnected ? modelJoinCode : null,
    providerCount: buildSharedCatalog('Host', true).providers.length,
  };
}

/** A distinct relay session with only model permissions and no host folders,
 * session history, login state, provider configs or auth material. */
export async function startModelSharing(hostName = 'Host') {
  return serializeSharingOperation(async () => {
    const displayName = hostName.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 80);
    if (!displayName) throw new ValidationError('Enter a host name for your shared models.');
    if (!buildSharedCatalog(displayName, true).providers.length)
      throw new ValidationError('Choose at least one connected provider and model to share.');
    const relayUrl = process.env.RELAY_URL;
    const hostSecret = process.env.RELAY_HOST_SECRET;
    if (!relayUrl || !hostSecret)
      throw new ConfigurationError('Model sharing requires a configured collaboration relay.');
    modelSharingRelayUrl(relayUrl);
    if (!modelRelay?.isConnected) {
      await revokeModelSharing();
      modelRelay = new RelayClient({ relayUrl: relayUrl.replace(/\/$/, ''), hostSecret });
      try {
        const session = await modelRelay.startSession(`models-${nanoid()}`);
        modelJoinCode = session.joinCode;
        await modelRelay.updatePolicy({
          ...structuredClone(DEFAULT_COLLABORATION_POLICY),
          hostName: displayName,
          sessionName: 'Shared models',
          workspacePaths: [],
          modelCatalog: [],
          joinMode: 'auto',
          defaultTierId: 'models',
          accessTiers: [structuredClone(DEFAULT_COLLABORATION_TIERS.find((tier) => tier.id === 'models')!)],
          allowPrompts: false,
          showDiffs: false,
          showAgentStatus: false,
          showParticipants: false,
        });
        unregister = startProviderHost(modelRelay, displayName);
      } catch (error) {
        await revokeModelSharing();
        throw error;
      }
    } else if (modelRelay.policy && modelRelay.policy.hostName !== displayName) {
      await modelRelay.updatePolicy({ ...modelRelay.policy, hostName: displayName });
      refreshSharedCatalogs();
    }
    try {
      if (!modelJoinCode) throw new Error('Model-sharing relay did not return a code');
      return { inviteUrl: await modelRelay.createInvite('models'), joinCode: modelJoinCode, hostName: displayName };
    } catch (error) {
      await revokeModelSharing();
      throw error;
    }
  });
}

export async function stopModelSharing() {
  return serializeSharingOperation(revokeModelSharing);
}

async function revokeModelSharing() {
  // Revoke first. A failed revoke keeps the host available for an honest retry.
  if (modelRelay) await modelRelay.endSession();
  unregister?.();
  unregister = null;
  modelRelay = null;
  modelJoinCode = null;
}
