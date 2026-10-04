import { afterEach, expect, test } from 'bun:test';
import {
  getKoryBridgeGrant,
  revokeKoryBridgeGrantsForSession,
  signedBridgeHeadersFromFile,
  verifySignedBridgeRequest,
  withBridgeWorkspace,
} from '../bridge-grant';

afterEach(() => revokeKoryBridgeGrantsForSession('scope-test'));

test('concurrent CLI turns bind workspace grants to their own async execution, not caller cwd', async () => {
  async function* turn() {
    await Promise.resolve();
    yield getKoryBridgeGrant('scope-test', 'worker', ['mcp:execute']);
  }
  const a = withBridgeWorkspace('/chat-a/worker', turn());
  const b = withBridgeWorkspace('/chat-b/worker', turn());
  const [one, two] = await Promise.all([a.next(), b.next()]);
  const endpoint = '/api/v1/mcp-bridge/execute';
  const body = { sessionId: 'scope-test', role: 'worker', workingDirectory: '/untrusted-override' };
  const verify = (path: string) =>
    verifySignedBridgeRequest(
      new Headers(signedBridgeHeadersFromFile(path, 'mcp', 'POST', endpoint, body)),
      'mcp',
      'POST',
      endpoint,
      body,
    );
  expect(verify(one.value!.path)?.workspaceRoot).toBe('/chat-a/worker');
  expect(verify(two.value!.path)?.workspaceRoot).toBe('/chat-b/worker');
  await a.return(undefined as never);
  await b.return(undefined as never);
});
