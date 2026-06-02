/**
 * Koryphaios Collaboration Relay Server
 *
 * Brokers WebSocket connections between a Koryphaios host and remote guests.
 * The host makes an outbound WS connection here — no local port exposed.
 * Guests connect via signed invite tokens. Nothing touches the host filesystem.
 */

import { randomBytes, createHmac, timingSafeEqual } from 'crypto';

// ─── Config ─────────────────────────────────────────────────────────────────

const HOST_SECRET = process.env.HOST_SECRET;
const JWT_SECRET = process.env.JWT_SECRET;
const PORT = Number(process.env.PORT || 8080);

if (!HOST_SECRET || !JWT_SECRET) {
  console.error('FATAL: HOST_SECRET and JWT_SECRET env vars are required');
  process.exit(1);
}

// ─── Types ──────────────────────────────────────────────────────────────────

interface WsData {
  sessionId: string;
  role: 'host' | 'guest';
  guestId: string;
  name: string;
}

interface Session {
  id: string;
  hostWs: ReturnType<typeof Bun.serve> extends { upgrade: (...a: any[]) => any } ? any : any;
  guests: Map<string, { ws: any; name: string; role: string }>;
  history: object[];
  createdAt: number;
}

const sessions = new Map<string, Session>();

// ─── JWT (simple HMAC-based, no deps) ───────────────────────────────────────

function sign(payload: object): string {
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = createHmac('sha256', JWT_SECRET!).update(data).digest('base64url');
  return `${data}.${sig}`;
}

function verify(token: string): Record<string, any> | null {
  const dot = token.lastIndexOf('.');
  if (dot < 0) return null;
  const data = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = createHmac('sha256', JWT_SECRET!).update(data).digest('base64url');
  try {
    const a = Buffer.from(sig, 'base64url');
    const b = Buffer.from(expected, 'base64url');
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    const parsed = JSON.parse(Buffer.from(data, 'base64url').toString());
    if (parsed.exp && parsed.exp < Date.now()) return null;
    return parsed;
  } catch {
    return null;
  }
}

function checkHostSecret(req: Request): boolean {
  const header = req.headers.get('x-host-secret') ?? '';
  try {
    return timingSafeEqual(Buffer.from(header), Buffer.from(HOST_SECRET!));
  } catch {
    return false;
  }
}

// ─── Guest HTML ─────────────────────────────────────────────────────────────

const GUEST_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Koryphaios — Live Session</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{background:#0a0a0f;color:#e2e8f0;font-family:'SF Mono','Fira Code',monospace;min-height:100vh;display:flex;flex-direction:column}
    header{background:#111118;border-bottom:1px solid #1e1e2e;padding:16px 24px;display:flex;align-items:center;gap:12px;flex-shrink:0}
    header h1{font-size:14px;font-weight:700;letter-spacing:.1em;color:#c890ab}
    .badge{background:#1e1e2e;border:1px solid #2d2d3e;padding:3px 10px;border-radius:20px;font-size:11px;color:#64748b}
    .badge.live{border-color:#22c55e40;color:#22c55e;background:#22c55e10}
    .badge.offline{color:#ef444480;border-color:#ef444420;background:#ef444408}
    #status-bar{padding:5px 16px;font-size:11px;border-bottom:1px solid #1e1e2e;background:#0d0d14;color:#64748b;flex-shrink:0}
    #log{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:6px}
    .entry{padding:8px 12px;border-radius:8px;font-size:12px;line-height:1.6;border:1px solid transparent}
    .entry.chat{background:#111118;border-color:#1e1e2e}
    .entry.chat .who{font-size:10px;color:#64748b;margin-bottom:4px;text-transform:uppercase;letter-spacing:.05em}
    .entry.chat .who.human{color:#c890ab}
    .entry.chat .who.agent{color:#60a5fa}
    .entry.log-line{color:#475569;font-size:11px}
    .entry.diff-view{background:#0d1117;border-color:#1e2a1e}
    .entry.diff-view .fname{font-size:11px;color:#22c55e;margin-bottom:8px}
    pre.diff{white-space:pre;font-size:11px;line-height:1.4;overflow-x:auto}
    .da{color:#22c55e}.dr{color:#ef4444}.dc{color:#475569}
    .entry.status-entry{background:#0d0d14;border-color:#1e1e2e;display:flex;align-items:center;gap:8px;font-size:11px;color:#94a3b8}
    .dot{width:6px;height:6px;border-radius:50%;background:#22c55e;flex-shrink:0;animation:pulse 2s infinite}
    @keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
    .entry.pending{background:#1a1208;border-color:#ca8a0430}
    .entry.pending .who{color:#ca8a04}
    footer{padding:12px 24px;border-top:1px solid #1e1e2e;background:#111118;flex-shrink:0}
    .input-row{display:flex;gap:8px}
    #prompt-in{flex:1;background:#0d0d14;border:1px solid #1e1e2e;border-radius:8px;padding:8px 12px;color:#e2e8f0;font-family:inherit;font-size:13px;outline:none;resize:none;height:40px}
    #prompt-in:focus{border-color:#c890ab40}
    #send-btn{background:#c890ab;color:#0a0a0f;border:none;border-radius:8px;padding:0 20px;font-weight:700;font-size:12px;cursor:pointer;white-space:nowrap}
    #send-btn:disabled{opacity:.35;cursor:not-allowed}
    .viewer-note{color:#475569;font-size:11px;text-align:center;padding:8px 0}
    #connect-screen{position:fixed;inset:0;background:#0a0a0f;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px}
    #connect-screen h2{font-size:18px;color:#c890ab}
    #connect-screen p{color:#64748b;font-size:13px;max-width:360px;text-align:center}
    .spinner{width:24px;height:24px;border:2px solid #1e1e2e;border-top-color:#c890ab;border-radius:50%;animation:spin .8s linear infinite}
    @keyframes spin{to{transform:rotate(360deg)}}
    .hidden{display:none!important}
    #participants{display:flex;gap:6px;flex-wrap:wrap;padding:8px 16px;border-bottom:1px solid #1e1e2e;background:#0d0d14;flex-shrink:0}
    .participant{background:#1e1e2e;border-radius:20px;padding:2px 10px;font-size:10px;color:#94a3b8}
  </style>
</head>
<body>
  <div id="connect-screen">
    <div class="spinner" id="spinner"></div>
    <h2>Koryphaios</h2>
    <p id="connect-msg">Connecting to session...</p>
  </div>
  <header class="hidden" id="app-header">
    <h1>KORYPHAIOS</h1>
    <span class="badge live" id="live-badge">● LIVE</span>
    <span class="badge" id="role-badge"></span>
    <span class="badge" id="session-badge">Session</span>
  </header>
  <div id="status-bar" class="hidden"></div>
  <div id="participants" class="hidden"></div>
  <div id="log" class="hidden"></div>
  <footer class="hidden" id="footer">
    <div id="viewer-note" class="viewer-note hidden">You have viewer access — read only</div>
    <div class="input-row" id="input-row" style="display:none">
      <textarea id="prompt-in" placeholder="Send a prompt to the host's agent..."></textarea>
      <button id="send-btn">Send</button>
    </div>
  </footer>

  <script>
  (function(){
    const params = new URLSearchParams(location.search);
    const token = params.get('token');
    const name = params.get('name') || 'Guest';
    if(!token){ setMsg('Invalid link — no token.'); spin(false); return; }

    const logEl = document.getElementById('log');
    const statusBar = document.getElementById('status-bar');
    const participantsEl = document.getElementById('participants');
    let role = 'viewer';
    let participants = {};
    let ws;

    function spin(v){ document.getElementById('spinner').style.display = v?'':'none'; }
    function setMsg(t){ document.getElementById('connect-msg').textContent = t; }
    function setStatus(t){ statusBar.textContent = t; }
    function h(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

    function renderParticipants(){
      participantsEl.innerHTML = '';
      Object.values(participants).forEach(function(p){
        var el = document.createElement('span');
        el.className='participant';
        el.textContent = (p.name||'?') + ' · ' + (p.role||'viewer');
        participantsEl.appendChild(el);
      });
    }

    function addEntry(cls, html){
      var d = document.createElement('div');
      d.className = 'entry ' + cls;
      d.innerHTML = html;
      logEl.appendChild(d);
      logEl.scrollTop = logEl.scrollHeight;
    }

    function handleMsg(msg){
      if(msg.type==='init'){
        role = msg.role;
        document.getElementById('role-badge').textContent = role.toUpperCase();
        document.getElementById('session-badge').textContent = 'Viewing ' + h(msg.hostName||'host') + "'s session";
        participants = msg.participants || {};
        renderParticipants();
        if(role==='viewer'){
          document.getElementById('viewer-note').classList.remove('hidden');
        } else {
          document.getElementById('input-row').style.display='flex';
        }
        (msg.history||[]).forEach(handleMsg);
      } else if(msg.type==='chat'){
        var cls = msg.from==='human'?'human':'agent';
        addEntry('chat','<div class="who '+cls+'">'+h(msg.from==='human'?'👤 User':'🤖 Agent')+'</div><div>'+h(msg.content)+'</div>');
      } else if(msg.type==='log'){
        addEntry('log-line', h(msg.content));
      } else if(msg.type==='diff'){
        var lines = (msg.diff||'').split('\\n').map(function(l){
          if(l.startsWith('+')) return '<span class="da">'+h(l)+'</span>';
          if(l.startsWith('-')) return '<span class="dr">'+h(l)+'</span>';
          return '<span class="dc">'+h(l)+'</span>';
        }).join('\\n');
        addEntry('diff-view','<div class="fname">📄 '+h(msg.path)+'</div><pre class="diff">'+lines+'</pre>');
      } else if(msg.type==='agent-status'){
        setStatus(msg.status||'');
        addEntry('status-entry','<span class="dot"></span>'+h(msg.status));
      } else if(msg.type==='approval-request'){
        addEntry('pending','<div class="who" style="color:#ca8a04">⏳ Pending approval from '+h(msg.name||'guest')+'</div><div>'+h(msg.content)+'</div>');
      } else if(msg.type==='approval-result'){
        addEntry('log-line', msg.approved ? '✅ Prompt approved' : '❌ Prompt rejected');
      } else if(msg.type==='guest-joined'){
        participants[msg.guestId] = {name:msg.name, role:msg.role};
        renderParticipants();
        addEntry('log-line','👤 '+h(msg.name)+' joined as '+h(msg.role));
      } else if(msg.type==='guest-left'){
        delete participants[msg.guestId];
        renderParticipants();
        addEntry('log-line','👤 '+h(msg.name)+' left');
      } else if(msg.type==='host-disconnected'){
        setStatus('Host disconnected');
        document.getElementById('live-badge').textContent='○ OFFLINE';
        document.getElementById('live-badge').className='badge offline';
      } else if(msg.type==='error'){
        setMsg(msg.message||'Error');
        spin(false);
      }
    }

    function connect(){
      var proto = location.protocol==='https:'?'wss://':'ws://';
      ws = new WebSocket(proto + location.host + '/ws?token=' + encodeURIComponent(token) + '&name=' + encodeURIComponent(name));
      ws.onopen = function(){
        document.getElementById('connect-screen').classList.add('hidden');
        ['app-header','status-bar','participants','log','footer'].forEach(function(id){
          document.getElementById(id).classList.remove('hidden');
        });
        setStatus('Connected');
      };
      ws.onmessage = function(e){
        try{ handleMsg(JSON.parse(e.data)); }catch(err){}
      };
      ws.onclose = function(){
        setStatus('Disconnected');
        document.getElementById('live-badge').textContent='○ OFFLINE';
        document.getElementById('live-badge').className='badge offline';
      };
      ws.onerror = function(){
        setMsg('Connection failed — link may be expired or invalid.');
        spin(false);
      };
    }

    document.getElementById('send-btn').onclick = function(){
      var val = document.getElementById('prompt-in').value.trim();
      if(!val || !ws || ws.readyState!==1) return;
      ws.send(JSON.stringify({type:'guest-prompt', content:val, name:name}));
      document.getElementById('prompt-in').value='';
    };
    document.getElementById('prompt-in').addEventListener('keydown', function(e){
      if(e.key==='Enter' && !e.shiftKey){ e.preventDefault(); document.getElementById('send-btn').click(); }
    });

    connect();
  })();
  </script>
</body>
</html>`;

// ─── HTTP + WS Server ────────────────────────────────────────────────────────

const server = Bun.serve<WsData>({
  port: PORT,

  async fetch(req, server) {
    const url = new URL(req.url);

    // CORS for Koryphaios frontend
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'content-type, x-host-secret',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    };
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    const json = (body: object, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

    // Health
    if (url.pathname === '/health') {
      return json({ ok: true, sessions: sessions.size });
    }

    // Host creates / retrieves a session
    if (url.pathname === '/session' && req.method === 'POST') {
      if (!checkHostSecret(req)) return json({ ok: false, error: 'Unauthorized' }, 401);
      const body = await req.json().catch(() => ({})) as any;
      const sessionId: string = body.sessionId || randomBytes(12).toString('hex');

      if (!sessions.has(sessionId)) {
        sessions.set(sessionId, {
          id: sessionId,
          hostWs: null,
          guests: new Map(),
          history: [],
          createdAt: Date.now(),
        });
      }

      const sessionToken = sign({
        sessionId,
        role: 'host',
        exp: Date.now() + 48 * 60 * 60 * 1000,
      });

      return json({ ok: true, sessionId, sessionToken });
    }

    // Host creates an invite link for a session
    if (url.pathname.match(/^\/session\/[^/]+\/invite$/) && req.method === 'POST') {
      if (!checkHostSecret(req)) return json({ ok: false, error: 'Unauthorized' }, 401);
      const sessionId = url.pathname.split('/')[2];
      if (!sessions.has(sessionId)) return json({ ok: false, error: 'Session not found' }, 404);

      const body = await req.json().catch(() => ({})) as any;
      const role: string = ['viewer', 'collaborator', 'copilot'].includes(body.role) ? body.role : 'viewer';
      const ttlMs = Number(body.ttlMs) || 7 * 24 * 60 * 60 * 1000;

      const inviteToken = sign({ sessionId, role, exp: Date.now() + ttlMs });
      const inviteUrl = `${url.protocol}//${url.host}/join?token=${encodeURIComponent(inviteToken)}`;

      return json({ ok: true, inviteUrl, inviteToken, role });
    }

    // Guest join page
    if (url.pathname === '/join') {
      return new Response(GUEST_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }

    // WebSocket upgrade
    if (url.pathname === '/ws') {
      const token = url.searchParams.get('token');
      const name = (url.searchParams.get('name') || 'Guest').slice(0, 40);
      if (!token) return new Response('Missing token', { status: 400 });

      const payload = verify(token);
      if (!payload) return new Response('Invalid or expired token', { status: 401 });

      const session = sessions.get(payload.sessionId);
      if (!session) return new Response('Session not found', { status: 404 });

      const upgraded = server.upgrade(req, {
        data: {
          sessionId: payload.sessionId,
          role: payload.role,
          guestId: randomBytes(6).toString('hex'),
          name,
        } satisfies WsData,
      });
      if (upgraded) return undefined as any;
      return new Response('Upgrade failed', { status: 500 });
    }

    return new Response('Not found', { status: 404 });
  },

  websocket: {
    open(ws) {
      const { sessionId, role, guestId, name } = ws.data;
      const session = sessions.get(sessionId);
      if (!session) { ws.close(4004, 'Session not found'); return; }

      if (role === 'host') {
        session.hostWs = ws;
        console.log(`[${sessionId}] host connected`);
        // Send pending guest list to host
        const guestList = Array.from(session.guests.entries()).map(([id, g]) => ({
          guestId: id, name: g.name, role: g.role,
        }));
        ws.send(JSON.stringify({ type: 'guest-list', guests: guestList }));
      } else {
        session.guests.set(guestId, { ws, name, role });
        console.log(`[${sessionId}] guest "${name}" (${role}) connected`);

        // Send init + history to new guest
        const participantMap: Record<string, { name: string; role: string }> = {};
        session.guests.forEach((g, id) => { participantMap[id] = { name: g.name, role: g.role }; });

        ws.send(JSON.stringify({
          type: 'init',
          role,
          hostName: 'Host',
          participants: participantMap,
          history: session.history,
        }));

        // Notify host and other guests
        const joinMsg = JSON.stringify({ type: 'guest-joined', guestId, name, role });
        session.hostWs?.send(joinMsg);
        session.guests.forEach((g, id) => { if (id !== guestId) g.ws.send(joinMsg); });
      }
    },

    message(ws, message) {
      const { sessionId, role, guestId, name } = ws.data;
      const session = sessions.get(sessionId);
      if (!session) return;

      let msg: any;
      try { msg = JSON.parse(String(message)); } catch { return; }

      if (role === 'host') {
        // Host → broadcast to all guests; also append relevant events to history
        const payload = JSON.stringify(msg);
        session.guests.forEach(g => g.ws.send(payload));

        // Keep a rolling history (last 200 events) for late-joining guests
        if (['chat', 'diff', 'agent-status'].includes(msg.type)) {
          session.history.push(msg);
          if (session.history.length > 200) session.history.shift();
        }

        // Handle approval results directed at specific guests
        if (msg.type === 'approval-result' && msg.guestId) {
          const target = session.guests.get(msg.guestId);
          target?.ws.send(JSON.stringify({ type: 'approval-result', approved: msg.approved }));
        }
      } else {
        // Guest → forward to host only
        if (msg.type === 'guest-prompt') {
          session.hostWs?.send(JSON.stringify({
            type: 'guest-prompt',
            guestId,
            name,
            role,
            content: String(msg.content).slice(0, 4000),
          }));
        }
      }
    },

    close(ws) {
      const { sessionId, role, guestId, name } = ws.data;
      const session = sessions.get(sessionId);
      if (!session) return;

      if (role === 'host') {
        session.hostWs = null;
        console.log(`[${sessionId}] host disconnected`);
        const msg = JSON.stringify({ type: 'host-disconnected' });
        session.guests.forEach(g => g.ws.send(msg));
      } else {
        session.guests.delete(guestId);
        console.log(`[${sessionId}] guest "${name}" disconnected`);
        const msg = JSON.stringify({ type: 'guest-left', guestId, name });
        session.hostWs?.send(msg);
        session.guests.forEach(g => g.ws.send(msg));
      }
    },
  },
});

// Evict sessions older than 48 hours with no host
setInterval(() => {
  const cutoff = Date.now() - 48 * 60 * 60 * 1000;
  for (const [id, s] of sessions) {
    if (s.createdAt < cutoff && !s.hostWs) {
      sessions.delete(id);
      console.log(`[${id}] session evicted`);
    }
  }
}, 60 * 60 * 1000);

console.log(`Koryphaios relay running on :${PORT}`);
