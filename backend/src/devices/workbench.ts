import { localAuth } from '../auth/local-auth';
import { buildLocalBearerToken } from '../auth/local-route-auth';
import { getContext } from '../context';
import { getProcessById, listProcesses } from '../process-supervisor/database';
import { serializeProcess } from '../process-supervisor/serialize';
import { remoteRouteDescriptor } from '@koryphaios/shared';

let handler: ((request: Request) => Promise<Response> | Response) | undefined;
export function setDeviceWorkbenchHandler(value: typeof handler) {
  handler = value;
}

/** Deliberately excludes authentication, credentials, device linking, instance
 * configuration and global session enumeration. The peer names a shared chat;
 * the receiving host supplies its own canonical project/session headers. */
export async function executeDeviceWorkbench(
  sessionId: string | null,
  input: Record<string, unknown>,
  authorize: () => void,
  scope: 'desktop' | 'mobile' = 'desktop',
) {
  if (!handler) throw new Error('Target workbench is not ready.');
  if (input.target !== undefined) {
    const target = input.target as Record<string, unknown>;
    if (!target || target.kind !== 'linked-device' || target.sessionId !== sessionId)
      throw new Error('Workbench target metadata does not match the target session.');
  }
  if (typeof input.path !== 'string' || input.path.length > 4096 || !input.path.startsWith('/api/'))
    throw new Error('Invalid target workbench route.');
  const url = new URL(input.path, 'http://127.0.0.1');
  if (url.origin !== 'http://127.0.0.1' || /%2f|%5c|\.\.|\\/i.test(url.pathname))
    throw new Error('Invalid target workbench route.');
  const path = decodeURIComponent(url.pathname);
  const method = String(input.method ?? 'GET').toUpperCase();
  if (!['GET', 'POST', 'PATCH', 'PUT', 'DELETE'].includes(method))
    throw new Error('Invalid workbench method.');
  if (input.routeId !== undefined && typeof input.routeId !== 'string')
    throw new Error('Invalid target workbench route metadata.');
  if (input.capability !== undefined && typeof input.capability !== 'string')
    throw new Error('Invalid target workbench capability metadata.');
  const descriptor = remoteRouteDescriptor(path, method);
  if (!descriptor) {
    if (input.routeId !== undefined || input.capability !== undefined)
      throw new Error('This route is not exposed by the target workbench.');
  }
  if (descriptor && input.routeId !== undefined && input.routeId !== descriptor.id)
    throw new Error('Target workbench route metadata does not match the route.');
  if (descriptor && input.capability !== undefined && input.capability !== descriptor.capability)
    throw new Error('Target workbench capability metadata does not match the route.');
  if (input.form !== undefined && (!descriptor || !descriptor.supportsMultipart))
    throw new Error('This target workbench route does not accept multipart input.');
  // The peer may supply only the optimistic revision needed for this one route.
  // Credentials, identity, project and all other request headers are host-owned.
  let noteRevision: number | undefined;
  if (Object.prototype.hasOwnProperty.call(input, 'noteRevision')) {
    if (
      scope !== 'mobile' ||
      method !== 'DELETE' ||
      url.search ||
      !/^\/api\/notes\/[^/]+$/.test(path)
    )
      throw new Error('Linked note revision is only supported for note deletion.');
    if (
      typeof input.noteRevision !== 'number' ||
      !Number.isSafeInteger(input.noteRevision) ||
      input.noteRevision < 1
    )
      throw new Error('Invalid linked note revision.');
    noteRevision = input.noteRevision;
  }
  if (!descriptor) throw new Error('This route is not exposed by the target workbench.');
  const ctx = getContext();
  if (scope === 'desktop' && !sessionId) throw new Error('A target chat is required.');
  const safeId = encodeURIComponent(sessionId ?? '');
  const sessionRoute =
    path === `/api/sessions/${safeId}` || path.startsWith(`/api/sessions/${safeId}/`);
  const messageRoute =
    path === `/api/messages/${safeId}` ||
    path.startsWith(`/api/messages/${safeId}/`) ||
    (path === '/api/messages/regenerate' &&
      method === 'POST' &&
      (input.body as Record<string, unknown> | undefined)?.sessionId === sessionId);
  const threadsRoute = path === `/api/agent/threads/${safeId}`;
  const projectRoute = /^\/api\/(?:git|project)(?:\/|$)/.test(path);
  const settingsRoute =
    /^\/api\/agent\/(?:settings|preferences|context|response-style)(?:\/|$)/.test(path);
  const agentMatch = /^\/api\/agent\/([^/]+)\/(?:thread|message|cancel)$/.exec(path);
  const agentRoute =
    agentMatch &&
    sessionId &&
    ctx.kory
      .getAgentThreadsForSession(sessionId)
      .some((thread) => thread.agent.id === agentMatch[1]);
  let processRoute = false;
  if (path === '/api/processes' && ['GET', 'POST'].includes(method)) processRoute = true;
  const processMatch = /^\/api\/processes\/([^/]+)(?:\/(?:logs|events|input|restart))?$/.exec(path);
  if (processMatch) {
    const process = await getProcessById(processMatch[1]);
    if (scope === 'desktop' && process?.sessionId !== sessionId)
      throw new Error('This terminal belongs to another chat.');
    processRoute = true;
  }
  if (
    scope === 'desktop' &&
    !sessionRoute &&
    !messageRoute &&
    !threadsRoute &&
    !projectRoute &&
    !settingsRoute &&
    !agentRoute &&
    !processRoute
  )
    throw new Error('This control is not exposed by the target workbench.');
  const workingDirectory = sessionId
    ? await ctx.kory.resolveSessionWorkingDirectoryPublic(sessionId)
    : undefined;
  function check(value: unknown, depth = 0) {
    if (depth > 30) throw new Error('Workbench input is too deeply nested.');
    if (!value || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value)) {
      if (key === 'sessionId' && item !== sessionId)
        throw new Error('Workbench command belongs to another chat.');
      if (
        ['workingDirectory', 'projectPath', 'workspacePath', 'cwd'].includes(key) &&
        item &&
        item !== workingDirectory
      )
        throw new Error('Target workspace paths are owned by the target chat.');
      check(item, depth + 1);
    }
  }
  if (scope === 'desktop') check(input.body);
  if (
    scope === 'desktop' &&
    url.searchParams.has('sessionId') &&
    url.searchParams.get('sessionId') !== sessionId
  )
    throw new Error('Workbench query belongs to another chat.');
  authorize();
  if (scope === 'desktop' && path === '/api/processes' && method === 'GET') {
    const processes = (await listProcesses(true, 100)).filter(
      (process) => process.sessionId === sessionId,
    );
    return {
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        processes: await Promise.all(processes.map((process) => serializeProcess(process))),
      }),
    };
  }
  const token = localAuth.createSession(['device:workbench']);
  try {
    const headers: Record<string, string> = {
      Authorization: buildLocalBearerToken(token),
      ...(sessionId ? { 'X-Koryphaios-Session': sessionId } : {}),
      ...(workingDirectory ? { 'X-Koryphaios-Project': workingDirectory } : {}),
      ...(noteRevision !== undefined ? { 'x-kory-note-revision': String(noteRevision) } : {}),
    };
    let requestBody: BodyInit | undefined;
    if (method !== 'GET' && input.form !== undefined) {
      const formInput = input.form as { parts?: unknown };
      if (!Array.isArray(formInput?.parts) || formInput.parts.length > 32)
        throw new Error('Invalid target workbench form.');
      const form = new FormData();
      let decodedBytes = 0;
      for (const rawPart of formInput.parts) {
        if (!rawPart || typeof rawPart !== 'object')
          throw new Error('Invalid target workbench form.');
        const part = rawPart as Record<string, unknown>;
        const name = typeof part.name === 'string' ? part.name : '';
        if (!name || name.length > 128) throw new Error('Invalid target workbench form.');
        if (typeof part.value === 'string') {
          if (part.value.length > 1_000_000)
            throw new Error('Target workbench form field is too large.');
          form.append(name, part.value);
          continue;
        }
        const filename = typeof part.filename === 'string' ? part.filename : '';
        const mimeType =
          typeof part.mimeType === 'string' ? part.mimeType : 'application/octet-stream';
        const base64 = typeof part.base64 === 'string' ? part.base64 : '';
        if (!filename || filename.length > 4096 || !base64)
          throw new Error('Invalid target workbench file upload.');
        const bytes = Buffer.from(base64, 'base64');
        decodedBytes += bytes.byteLength;
        if (decodedBytes > 1_100_000_000) throw new Error('Target workbench upload is too large.');
        form.append(name, new Blob([bytes], { type: mimeType }), filename);
      }
      requestBody = form;
    } else if (method !== 'GET' && input.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      requestBody = JSON.stringify(input.body);
    }
    const response = await handler(
      new Request(url, {
        method,
        headers,
        ...(requestBody !== undefined ? { body: requestBody } : {}),
      }),
    );
    authorize();
    const contentType = response.headers.get('content-type') ?? 'application/json';
    const contentDisposition = response.headers.get('content-disposition') ?? '';
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > 1_100_000_000)
      throw new Error('Target workbench response is too large.');
    const isText =
      /^text\//i.test(contentType) ||
      /^application\/(?:json|[^;]+\+json|xml|javascript)(?:;|$)/i.test(contentType);
    if (isText) {
      return {
        status: response.status,
        contentType,
        contentDisposition,
        body: new TextDecoder().decode(bytes),
      };
    }
    return {
      status: response.status,
      contentType,
      contentDisposition,
      body: Buffer.from(bytes).toString('base64'),
      bodyEncoding: 'base64',
    };
  } finally {
    localAuth.revokeSession(token.sessionId);
  }
}
