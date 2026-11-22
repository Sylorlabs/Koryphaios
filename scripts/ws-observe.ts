// Observe a Koryphaios session over WebSocket: connect, subscribe, log events.
// Usage: bun scripts/ws-observe.ts <sessionId> <bearerToken> [durationSeconds]
const [sessionId, token, durationArg] = process.argv.slice(2);
const duration = Number(durationArg ?? '120') * 1000;
const url = `ws://localhost:3101/ws`;

const ws = new WebSocket(url, { headers: { authorization: token } });
const seen = [];
ws.addEventListener('open', () => {
  console.log(`[ws] connected, subscribing to ${sessionId}`);
  ws.send(JSON.stringify({ type: 'subscribe_session', sessionId }));
});
ws.addEventListener('message', (event) => {
  let msg;
  try {
    msg = JSON.parse(String(event.data));
  } catch {
    return;
  }
  const type = msg.type ?? '?';
  const payload = msg.payload ?? {};
  if (type === 'stream.delta' || type === 'stream.reasoning_delta') return; // too noisy
  const line = `[ws] ${type} ${JSON.stringify(payload).slice(0, 400)}`;
  seen.push(line);
  console.log(line);
});
ws.addEventListener('close', () => console.log('[ws] closed'));
ws.addEventListener('error', (e) => console.log('[ws] error', e.message ?? e));

setTimeout(() => {
  console.log(`[ws] ${seen.length} events captured; exiting`);
  process.exit(0);
}, duration);
