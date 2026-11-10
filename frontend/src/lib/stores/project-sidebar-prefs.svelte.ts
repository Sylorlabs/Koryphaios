// Project organization preferences — pinned projects.
//
// This is presentation state, not project state: the folder is untouched and a
// pin only controls where its sidebar group sorts. Kept in localStorage so it
// survives restarts without a schema migration for one boolean per project.

const STORAGE_KEY = 'koryphaios.pinned-projects';

function load(): Set<string> {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return new Set(
      Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : [],
    );
  } catch {
    return new Set();
  }
}

let pinnedProjects = $state<Set<string>>(load());

function persist(next: Set<string>) {
  pinnedProjects = next;
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify([...next]));
  } catch {
    // A blocked or full storage backend must not break the sidebar.
  }
}

const PINNED_CHATS_KEY = 'koryphaios.pinned-chats';

function loadChats(): Set<string> {
  try {
    const raw = globalThis.localStorage?.getItem(PINNED_CHATS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return new Set(
      Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : [],
    );
  } catch {
    return new Set();
  }
}

let pinnedChats = $state<Set<string>>(loadChats());

export const chatSidebarPrefs = {
  isPinned(sessionId: string): boolean {
    return pinnedChats.has(sessionId);
  },
  togglePin(sessionId: string): boolean {
    const next = new Set(pinnedChats);
    const nowPinned = !next.has(sessionId);
    if (nowPinned) next.add(sessionId);
    else next.delete(sessionId);
    pinnedChats = next;
    try {
      globalThis.localStorage?.setItem(PINNED_CHATS_KEY, JSON.stringify([...next]));
    } catch {
      // A blocked storage backend must not break the sidebar.
    }
    return nowPinned;
  },
};

export const projectSidebarPrefs = {
  get pinned() {
    return pinnedProjects;
  },
  isPinned(path: string): boolean {
    return pinnedProjects.has(path);
  },
  togglePin(path: string): boolean {
    const next = new Set(pinnedProjects);
    const nowPinned = !next.has(path);
    if (nowPinned) next.add(path);
    else next.delete(path);
    persist(next);
    return nowPinned;
  },
};

// Custom ordering for projects and chats (drag-and-drop reordering).
const PROJECT_ORDER_KEY = 'koryphaios.project-order';
const CHAT_ORDER_KEY = 'koryphaios.chat-order';

function loadOrder(key: string): string[] {
  try {
    const raw = globalThis.localStorage?.getItem(key);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === 'string')
      : [];
  } catch {
    return [];
  }
}

function saveOrder(key: string, order: string[]) {
  try {
    globalThis.localStorage?.setItem(key, JSON.stringify(order));
  } catch {
    // ignore
  }
}

let projectOrder = $state<string[]>(loadOrder(PROJECT_ORDER_KEY));
let chatOrder = $state<Record<string, string[]>>({});

function loadChatOrder() {
  try {
    const raw = globalThis.localStorage?.getItem(CHAT_ORDER_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const out: Record<string, string[]> = {};
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (Array.isArray(v)) {
          out[k] = v.filter((x): x is string => typeof x === 'string');
        }
      }
      chatOrder = out;
    }
  } catch {
    chatOrder = {};
  }
}
loadChatOrder();

function persistChatOrder(next: Record<string, string[]>) {
  chatOrder = next;
  try {
    globalThis.localStorage?.setItem(CHAT_ORDER_KEY, JSON.stringify(next));
  } catch {
    // ignore
  }
}

// Extend projectSidebarPrefs with ordering helpers.
const _origProjectSidebarPrefs = projectSidebarPrefs;
export const projectOrderPrefs = {
  getOrder(): string[] {
    return projectOrder;
  },
  setOrder(order: string[]) {
    projectOrder = order;
    saveOrder(PROJECT_ORDER_KEY, order);
  },
  move(path: string, toIndex: number) {
    const current = [...projectOrder];
    // Seed with all known? Just operate on current order; if empty, seed from provided? We'll handle in sidebar.
    const fromIndex = current.indexOf(path);
    if (fromIndex !== -1) current.splice(fromIndex, 1);
    const clamped = Math.max(0, Math.min(toIndex, current.length));
    current.splice(clamped, 0, path);
    this.setOrder(current);
  },
};

export const chatOrderPrefs = {
  getOrder(projectPath: string): string[] {
    return chatOrder[projectPath] ?? [];
  },
  setOrder(projectPath: string, order: string[]) {
    const next = { ...chatOrder, [projectPath]: order };
    persistChatOrder(next);
  },
  move(projectPath: string, sessionId: string, toIndex: number) {
    const current = [...(chatOrder[projectPath] ?? [])];
    const fromIndex = current.indexOf(sessionId);
    if (fromIndex !== -1) current.splice(fromIndex, 1);
    const clamped = Math.max(0, Math.min(toIndex, current.length));
    current.splice(clamped, 0, sessionId);
    this.setOrder(projectPath, current);
  },
};
