<script lang="ts">
  import { onMount, onDestroy, tick } from 'svelte';
  import Search from 'lucide-svelte/icons/search';
  import Plus from 'lucide-svelte/icons/plus';
  import StickyNote from 'lucide-svelte/icons/sticky-note';
  import Share2 from 'lucide-svelte/icons/share-2';
  import Folder from 'lucide-svelte/icons/folder';
  import FolderOpen from 'lucide-svelte/icons/folder-open';
  import Pin from 'lucide-svelte/icons/pin';
  import PinOff from 'lucide-svelte/icons/pin-off';
  import BookOpen from 'lucide-svelte/icons/book-open';
  import Paperclip from 'lucide-svelte/icons/paperclip';
  import Trash2 from 'lucide-svelte/icons/trash-2';
  import X from 'lucide-svelte/icons/x';
  import ChevronRight from 'lucide-svelte/icons/chevron-right';
  import ChevronDown from 'lucide-svelte/icons/chevron-down';
  import Save from 'lucide-svelte/icons/save';
  import FileText from 'lucide-svelte/icons/file-text';
  import Image from 'lucide-svelte/icons/image';
  import Download from 'lucide-svelte/icons/download';
  import Tag from 'lucide-svelte/icons/tag';
  import RefreshCw from 'lucide-svelte/icons/refresh-cw';
  import Eye from 'lucide-svelte/icons/eye';
  import Code2 from 'lucide-svelte/icons/code-2';
  import LayoutGrid from 'lucide-svelte/icons/layout-grid';
  import AlertTriangle from 'lucide-svelte/icons/alert-triangle';
  import Check from 'lucide-svelte/icons/check';
  import LoaderCircle from 'lucide-svelte/icons/loader-circle';
  import Settings from 'lucide-svelte/icons/settings';
  import Upload from 'lucide-svelte/icons/upload';
  import { notesStore } from '$lib/stores/notes.svelte';
  import { toastStore } from '$lib/stores/toast.svelte';
  import { apiUrl } from '$lib/utils/api-url';
  import { apiFetch } from '$lib/api.svelte';
  import { projectDisplayName, projectStore } from '$lib/stores/project.svelte';
  import { selectProjectNavigation } from '$lib/utils/project-navigation';
  import NotesGraph from './NotesGraph.svelte';
  import NotesCanvas from './NotesCanvas.svelte';
  import VirtualList from './VirtualList.svelte';
  import { Marked } from 'marked';
  import markedKatex from 'marked-katex-extension';
  import 'katex/dist/katex.min.css';
  import DOMPurify from 'dompurify';
  import { renderDataviewQuery } from '$lib/utils/dataview';
  import { notePlugins } from '$lib/utils/note-plugins';
  import type { NoteWithLinks, NoteAttachment } from '@koryphaios/shared';
  import SettingsSwitch from './SettingsSwitch.svelte';
  import NumberStepper from './NumberStepper.svelte';
  import KorySelect from './KorySelect.svelte';
  import { AttachmentObjectUrlRegistry } from '$lib/utils/attachment-object-urls';
  import {
    isExactAttachmentFilename,
    NOTE_PREVIEW_URI_PATTERN,
    noteAttachmentReferenceStart,
    renderNoteAttachmentReference,
    tokenizeNoteAttachmentReference,
  } from '$lib/utils/note-attachment-references';
  import {
    autosaveDelayForDraft,
    createDraftRegistry,
    draftExitAction,
    isCurrentDraftVersion,
    utf8DraftBytes,
  } from '$lib/utils/draft-save';

  // Isolated markdown renderer for the notes preview: renders [[wikilinks]] as
  // clickable spans and leaves the global `marked` config (chat) untouched.
  const noteMarked = new Marked({
    extensions: [
      {
        name: 'noteAttachment',
        level: 'inline',
        start(src: string) {
          return noteAttachmentReferenceStart(src);
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        tokenizer(src: string): any {
          const token = tokenizeNoteAttachmentReference(src, attachments);
          if (!token) return;
          return {
            type: 'noteAttachment',
            ...token,
          };
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        renderer(token: any) {
          return renderNoteAttachmentReference(
            token,
            attachmentObjectUrls[String(token.attachmentId)],
          );
        },
      },
      {
        name: 'wikilink',
        level: 'inline',
        start(src: string) {
          return src.indexOf('[[');
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        tokenizer(src: string): any {
          const m = /^!?\[\[([^\]|#]+?)(?:[|#]([^\]]+?))?\]\]/.exec(src);
          if (m)
            return {
              type: 'wikilink',
              raw: m[0],
              text: (m[2] || m[1]).trim(),
              target: m[1].trim(),
            };
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        renderer(token: any) {
          const t = String(token.target).replace(/"/g, '&quot;');
          return `<a class="wikilink" data-note-title="${t}" href="#">${token.text}</a>`;
        },
      },
    ],
  });
  const notesAutosaveOptions = [
    { value: '500', label: '0.5 seconds' },
    { value: '1500', label: '1.5 seconds' },
    { value: '3000', label: '3 seconds' },
    { value: '5000', label: '5 seconds' },
    { value: '10000', label: '10 seconds' },
  ];
  // $…$ / $$…$$ math via KaTeX (nonStandard = Obsidian-style, no space needed).
  noteMarked.use(markedKatex({ throwOnError: false, nonStandard: true }));
  // Fenced ```mermaid → diagram placeholder (rendered post-mount); ```dataview /
  // ```query → live query table; everything else falls back to default code.
  noteMarked.use({
    renderer: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      code(this: any, token: any): string | false {
        const lang = String(token?.lang ?? '')
          .trim()
          .split(/\s+/)[0]
          .toLowerCase();
        const text = String(token?.text ?? '');
        if (lang === 'mermaid') {
          // base64 keeps the source intact through DOMPurify + HTML attributes.
          const enc = btoa(unescape(encodeURIComponent(text)));
          return `<div class="mermaid-block" data-mermaid="${enc}"></div>`;
        }
        if (lang === 'dataview' || lang === 'query') {
          return renderDataviewQuery(text, notesStore.notes);
        }
        return false;
      },
    },
  });

  // ── State ──────────────────────────────────────────────────────────────────
  let activeView = $state<'editor' | 'preview' | 'graph' | 'canvas'>('editor');
  let titleInput = $state('');
  let folderInput = $state('');
  let contentInput = $state('');
  let tagsInput = $state('');
  let tags = $state<string[]>([]);
  let showTagMenu = $state(false);
  let availableTags = $derived(
    [...new Set(notesStore.notes.flatMap((note) => note.tags ?? []))]
      .filter((tag) => !tags.includes(tag))
      .slice(0, 8),
  );
  let pinned = $state(false);
  let includeInContext = $state(false);
  let isDirty = $state(false);
  let saveState = $state<'idle' | 'dirty' | 'saving' | 'saved' | 'error' | 'conflict'>('idle');
  let baseRevision = $state<number | null>(null);
  let editVersion = 0;
  let savePromise: Promise<boolean> | null = null;
  let autosaveTimer: ReturnType<typeof setTimeout> | null = null;
  let searchDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  let searchInput = $state('');
  let searchQuery = $state('');
  let expandedFolders = $state<Set<string>>(new Set(['/']));
  let dragOver = $state(false);
  let editorAreaEl = $state<HTMLDivElement | undefined>(undefined);
  let titleInputEl = $state<HTMLInputElement | undefined>(undefined);
  let contentAreaEl = $state<HTMLTextAreaElement | undefined>(undefined);
  let previewContainer = $state<HTMLDivElement | undefined>(undefined);
  let folderSuggestions = $state<string[]>([]);
  let showFolderSuggestions = $state(false);
  let folderActiveIndex = $state(0);
  let lastOpenedNoteId = $state<string | null>(null);
  // Responsive: below this width the note list collapses to a toggleable overlay
  // so the editor/graph/canvas gets the full width (phone/tablet-friendly).
  let isNarrow = $state(false);
  let showSidebar = $state(true);
  let showEditorSettings = $state(false);
  let settingsTriggerEl = $state<HTMLButtonElement | undefined>(undefined);
  let settingsCloseEl = $state<HTMLButtonElement | undefined>(undefined);
  let importInputEl = $state<HTMLInputElement | undefined>(undefined);
  let attachmentObjectUrls = $state<Record<string, string>>({});
  interface StrandedNoteDraft {
    projectPath: string;
    noteId: string;
    noteTitle: string;
    title: string;
    folderPath: string;
    content: string;
    tags: string[];
    pinned: boolean;
    includeInContext: boolean;
    revision: number | null;
  }
  let loadedProjectPath = $state<string | null | undefined>(undefined);
  const draftRegistry = createDraftRegistry<StrandedNoteDraft>('notes-editor');
  let strandedDrafts = $state<StrandedNoteDraft[]>(draftRegistry.list());
  let strandedDraft = $derived(strandedDrafts[0] ?? null);
  let attachmentLoadErrors = $state<Set<string>>(new Set());
  let attachmentLoadGeneration = 0;
  let wikilinkActiveIndex = $state(0);
  const attachmentUrlRegistry = new AttachmentObjectUrlRegistry((path) => apiFetch(apiUrl(path)));
  function updateNarrow() {
    isNarrow = typeof window !== 'undefined' && window.innerWidth < 700;
    if (!isNarrow) showSidebar = true;
  }

  // ── Derived ───────────────────────────────────────────────────────────────
  let filteredNotes = $derived.by(() => {
    const q = searchQuery.trim().toLowerCase();
    const folder = notesStore.selectedFolder;
    return notesStore.notes.filter((n) => {
      const inFolder =
        folder === '/' ? true : n.folderPath === folder || n.folderPath.startsWith(folder + '/');
      const matchesQuery =
        !q ||
        n.title.toLowerCase().includes(q) ||
        n.content.toLowerCase().includes(q) ||
        n.tags.some((t) => t.toLowerCase().includes(q));
      return inFolder && matchesQuery;
    });
  });

  function estimateNoteHeight(note: { content?: string; tags?: string[] }): number {
    return 44 + (note.content ? 14 : 0) + ((note.tags?.length ?? 0) > 0 ? 18 : 0);
  }

  let currentNote = $derived(notesStore.currentNote);
  let attachments = $derived(currentNote?.attachments ?? []);
  let contentBytes = $derived(utf8DraftBytes(contentInput));
  let noteByteLimit = $derived(
    notesStore.settings.noteSizeLimitEnabled ? notesStore.settings.maxNoteBytes : 5_000_000,
  );
  let overNoteBudget = $derived(contentBytes > noteByteLimit);

  async function loadAttachmentUrls() {
    const generation = ++attachmentLoadGeneration;
    const sources = attachments.map(({ id }) => ({ id }));
    const urls = await attachmentUrlRegistry.replace(sources);
    if (generation !== attachmentLoadGeneration) return;
    attachmentObjectUrls = urls;
    attachmentLoadErrors = new Set(attachmentUrlRegistry.failedIds);
  }

  $effect(() => {
    void currentNote?.id;
    void attachments;
    void loadAttachmentUrls();
  });

  // Live Markdown preview: resolve ![[transclusions]] from loaded notes (depth
  // 1), then render + sanitize. Wikilinks become clickable via noteMarked.
  function renderMarkdownPreview(): string {
    if (!currentNote || currentNote.format === 'html') return '';
    const byTitle = new Map(notesStore.notes.map((n) => [n.title.toLowerCase(), n]));
    const transcluded = contentInput.replace(
      /!\[\[([^\]|#]+?)(?:[|#][^\]]+?)?\]\]/g,
      (raw, title) => {
        const reference = String(title).trim();
        // Exact attachment filenames win over note-title transclusion. This
        // keeps ![[diagram.png]] stable even when a note shares that title.
        if (isExactAttachmentFilename(reference, attachments)) return raw;
        const target = byTitle.get(reference.toLowerCase());
        if (!target || target.id === currentNote.id) return raw;
        return `\n> **${target.title}**\n>\n${String(target.content).replace(/^/gm, '> ')}\n`;
      },
    );
    try {
      // Plugin markdown transforms run before parse; HTML post-processors after.
      const src = notePlugins.transformMarkdown(transcluded);
      const html = notePlugins.postProcessHtml(noteMarked.parse(src, { async: false }) as string);
      return DOMPurify.sanitize(html, {
        ADD_ATTR: ['data-note-title', 'data-mermaid'],
        ADD_TAGS: ['foreignobject'],
        // Attachment URLs are capability-style object URLs created only from
        // authenticated attachment responses by AttachmentObjectUrlRegistry.
        ALLOWED_URI_REGEXP: NOTE_PREVIEW_URI_PATTERN,
      });
    } catch (err: unknown) {
      console.debug(
        'Markdown preview render failed:',
        err instanceof Error ? err.message : String(err),
      );
      return '';
    }
  }

  // Parsing Markdown, running plugins, and sanitizing HTML can be expensive for
  // large notes. Keep typing responsive by coalescing rapid edits into one
  // preview render instead of rebuilding the whole document per keystroke.
  let markdownPreview = $state('');
  let previewRenderTimer: ReturnType<typeof setTimeout> | null = null;
  $effect(() => {
    void currentNote?.id;
    void currentNote?.format;
    void contentInput;
    void notesStore.notes;
    if (previewRenderTimer) clearTimeout(previewRenderTimer);
    previewRenderTimer = setTimeout(() => {
      markdownPreview = renderMarkdownPreview();
      previewRenderTimer = null;
    }, 100);
    return () => {
      if (previewRenderTimer) clearTimeout(previewRenderTimer);
    };
  });

  // [[ wikilink autocomplete for the content textarea.
  let showWikilinkMenu = $state(false);
  let wikilinkQuery = $state('');
  let wikilinkStart = $state(-1);
  let wikilinkSuggestions = $derived.by(() => {
    if (!showWikilinkMenu) return [] as { id: string; title: string }[];
    const q = wikilinkQuery.toLowerCase();
    return notesStore.notes
      .filter((n) => n.id !== currentNote?.id && (!q || n.title.toLowerCase().includes(q)))
      .slice(0, 8)
      .map((n) => ({ id: n.id, title: n.title }));
  });

  function onContentInput() {
    scheduleAutosave();
    const el = contentAreaEl;
    if (!el) return;
    const upto = contentInput.slice(0, el.selectionStart);
    const open = upto.lastIndexOf('[[');
    if (open >= 0 && !upto.slice(open).includes(']]') && !upto.slice(open).includes('\n')) {
      wikilinkStart = open;
      wikilinkQuery = upto.slice(open + 2);
      showWikilinkMenu = true;
      wikilinkActiveIndex = 0;
    } else {
      showWikilinkMenu = false;
    }
  }

  function handleContentKeydown(event: KeyboardEvent) {
    if (!showWikilinkMenu || wikilinkSuggestions.length === 0) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      wikilinkActiveIndex = (wikilinkActiveIndex + 1) % wikilinkSuggestions.length;
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      wikilinkActiveIndex =
        (wikilinkActiveIndex - 1 + wikilinkSuggestions.length) % wikilinkSuggestions.length;
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const suggestion = wikilinkSuggestions[wikilinkActiveIndex];
      if (suggestion) insertWikilink(suggestion.title);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      showWikilinkMenu = false;
    }
  }

  function insertWikilink(title: string) {
    const el = contentAreaEl;
    if (!el || wikilinkStart < 0) return;
    const before = contentInput.slice(0, wikilinkStart);
    const after = contentInput.slice(el.selectionStart);
    contentInput = `${before}[[${title}]]${after}`;
    showWikilinkMenu = false;
    isDirty = true;
    scheduleAutosave();
    void tick().then(() => {
      const pos = (before + `[[${title}]]`).length;
      el.focus();
      el.setSelectionRange(pos, pos);
    });
  }

  // Delegate wikilink clicks inside the rendered preview via an action, so the
  // container needs no click handler (keeps it a11y-clean; the links are <a>).
  function previewLinks(node: HTMLElement) {
    const onClick = (e: MouseEvent) => {
      const a = (e.target as HTMLElement).closest('a.wikilink') as HTMLElement | null;
      if (!a) return;
      e.preventDefault();
      const title = a.getAttribute('data-note-title');
      if (title) void notesStore.openNoteByTitle(title);
    };
    node.addEventListener('click', onClick);
    return { destroy: () => node.removeEventListener('click', onClick) };
  }

  let htmlPreview = $derived.by(() => {
    if (currentNote?.format !== 'html') return '';
    const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; font-src data:; media-src data: blob:; form-action 'none'; base-uri 'none'">`;
    return /<head[\s>]/i.test(contentInput)
      ? contentInput.replace(/<head([^>]*)>/i, `<head$1>${csp}`)
      : `${csp}${contentInput}`;
  });

  // ── Load on mount ─────────────────────────────────────────────────────────
  onMount(() => {
    window.addEventListener('keydown', handleGlobalKeydown);
    window.addEventListener('open-notes-graph', handleOpenGraphEvent);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    updateNarrow();
    window.addEventListener('resize', updateNarrow);
  });

  function handleVisibilityChange() {
    if (document.visibilityState === 'hidden' && isDirty && notesStore.settings.autosaveEnabled) {
      void saveCurrentNote();
    }
  }

  // "Open Graph View" (Settings → Notes) must land ON the graph, not the editor.
  function handleOpenGraphEvent() {
    activeView = 'graph';
    void notesStore.fetchGraph();
  }

  onDestroy(() => {
    window.removeEventListener('keydown', handleGlobalKeydown);
    window.removeEventListener('open-notes-graph', handleOpenGraphEvent);
    document.removeEventListener('visibilitychange', handleVisibilityChange);
    window.removeEventListener('resize', updateNarrow);
    cancelAutosave();
    if (loadedProjectPath === projectStore.currentPath) {
      const action = draftExitAction({
        dirty: isDirty,
        autosaveEnabled: notesStore.settings.autosaveEnabled,
      });
      if (action === 'save') void saveCurrentNote();
      else if (action === 'hold') holdCurrentDraft();
    }
    if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
    if (previewRenderTimer) clearTimeout(previewRenderTimer);
    attachmentLoadGeneration++;
    attachmentUrlRegistry.clear();
    attachmentObjectUrls = {};
  });

  $effect(() => {
    if (!isDirty && strandedDrafts.length === 0) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  });

  $effect(() => {
    const projectPath = projectStore.currentPath;
    if (projectPath === loadedProjectPath) return;

    const previousProjectPath = loadedProjectPath;
    if (
      previousProjectPath !== undefined &&
      previousProjectPath !== null &&
      previousProjectPath !== projectPath &&
      isDirty &&
      currentNote
    ) {
      holdCurrentDraft(previousProjectPath);
    }

    loadedProjectPath = projectPath;
    cancelAutosave();
    notesStore.beginProjectTransition();
    lastOpenedNoteId = null;
    titleInput = '';
    folderInput = '';
    contentInput = '';
    tags = [];
    pinned = false;
    includeInContext = false;
    isDirty = false;
    baseRevision = null;
    saveState = 'idle';
    attachmentLoadGeneration++;
    attachmentUrlRegistry.clear();
    attachmentObjectUrls = {};

    if (projectPath) {
      void (async () => {
        // The first notes read joins the project's single-flight filesystem
        // scan. Build folders/graph only after that authoritative catalog is
        // ready, otherwise a fresh project can render a false empty sidebar.
        const notesLoaded = await notesStore.fetchNotes();
        if (projectStore.currentPath !== projectPath) return;
        if (!notesLoaded) return;
        await Promise.all([notesStore.fetchFolderTree(), notesStore.fetchGraph()]);
      })();
    }
  });

  // ── Mermaid diagrams ──────────────────────────────────────────────────────
  // marked emits <div.mermaid-block data-mermaid="base64src">; after the preview
  // HTML lands in the DOM, lazy-load mermaid and swap each block for its SVG.
  let mermaidMod: typeof import('mermaid').default | null = null;
  let mermaidSeq = 0;
  $effect(() => {
    // Re-run whenever the rendered markdown or the active view changes.
    void markdownPreview;
    if (activeView !== 'preview') return;
    const root = previewContainer;
    if (!root) return;
    const blocks = Array.from(
      root.querySelectorAll<HTMLElement>('.mermaid-block:not([data-rendered])'),
    );
    if (blocks.length === 0) return;
    void (async () => {
      try {
        if (!mermaidMod) {
          mermaidMod = (await import('mermaid')).default;
          mermaidMod.initialize({
            startOnLoad: false,
            theme: 'dark',
            securityLevel: 'strict',
            fontFamily: 'inherit',
          });
        }
        for (const el of blocks) {
          if (el.dataset.rendered) continue;
          el.dataset.rendered = '1';
          const b64 = el.getAttribute('data-mermaid') ?? '';
          let source = '';
          try {
            source = decodeURIComponent(escape(atob(b64)));
          } catch (err: unknown) {
            console.debug(
              'Failed to decode mermaid base64 source:',
              err instanceof Error ? err.message : String(err),
            );
            source = '';
          }
          if (!source.trim()) continue;
          try {
            const { svg } = await mermaidMod.render(`mmd-${mermaidSeq++}`, source);
            el.innerHTML = svg;
          } catch (err) {
            const errorBlock = document.createElement('pre');
            errorBlock.className = 'mermaid-error';
            errorBlock.textContent = String((err as Error)?.message ?? err);
            el.replaceChildren(errorBlock);
          }
        }
      } catch (err: unknown) {
        console.warn('Mermaid failed to load:', err instanceof Error ? err.message : String(err));
        /* mermaid failed to load; leave placeholders empty */
      }
    })();
  });

  // ── Sync editor when current note changes ─────────────────────────────────
  $effect(() => {
    const note = notesStore.currentNote;
    const id = note?.id ?? null;
    // Only hydrate the editor fields when switching to a *different* note.
    // updateNote() reassigns the currentNote object on every autosave, which
    // re-fires this effect. Re-hydrating then would overwrite in-progress edits
    // and yank the caret/scroll to the top/end while you type. Guarding on the
    // note id keeps the editor stable during saves of the note you're editing.
    if (id === lastOpenedNoteId) return;
    lastOpenedNoteId = id;
    if (note) {
      titleInput = note.title;
      folderInput = note.folderPath;
      contentInput = note.content;
      tags = [...(note.tags ?? [])];
      pinned = note.pinned;
      includeInContext = note.includeInContext;
      isDirty = false;
      baseRevision = note.revision;
      saveState = 'idle';
      notesStore.clearConflict();
      activeView = note.format === 'html' ? 'preview' : 'editor';
    } else if (activeView === 'preview') {
      // The Preview tab only exists for an open note. Keep the roving tab stop
      // and tabpanel label valid after deletion or a project transition.
      activeView = 'editor';
    }
  });

  // ── Keyboard shortcuts ────────────────────────────────────────────────────
  function handleGlobalKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape' && showEditorSettings) {
      e.preventDefault();
      showEditorSettings = false;
      void tick().then(() => settingsTriggerEl?.focus());
      return;
    }
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && e.key.toLowerCase() === 's') {
      if (activeView === 'canvas') return;
      e.preventDefault();
      void saveCurrentNote();
    }
  }

  // ── Note CRUD ─────────────────────────────────────────────────────────────
  function noteDraftKey(projectPath: string, noteId: string): string {
    return `${projectPath}\0${noteId}`;
  }

  function refreshDrafts(): void {
    strandedDrafts = draftRegistry.list();
  }

  function holdCurrentDraft(projectPath = loadedProjectPath): void {
    const note = notesStore.currentNote;
    if (!isDirty || !note || !projectPath) return;
    draftRegistry.set(noteDraftKey(projectPath, note.id), {
      projectPath,
      noteId: note.id,
      noteTitle: titleInput.trim() || note.title,
      title: titleInput,
      folderPath: folderInput,
      content: contentInput,
      tags: [...tags],
      pinned,
      includeInContext,
      revision: baseRevision,
    });
    refreshDrafts();
  }

  function restoreHeldDraft(projectPath: string | null, noteId: string): boolean {
    if (!projectPath) return false;
    const draft = draftRegistry.get(noteDraftKey(projectPath, noteId));
    if (!draft) return false;
    titleInput = draft.title;
    folderInput = draft.folderPath;
    contentInput = draft.content;
    tags = [...draft.tags];
    pinned = draft.pinned;
    includeInContext = draft.includeInContext;
    baseRevision = draft.revision;
    editVersion++;
    isDirty = true;
    saveState = 'dirty';
    draftRegistry.delete(noteDraftKey(projectPath, noteId));
    refreshDrafts();
    return true;
  }

  async function canLeaveCurrentNote(): Promise<boolean> {
    cancelAutosave();
    const action = draftExitAction({
      dirty: isDirty,
      autosaveEnabled: notesStore.settings.autosaveEnabled,
    });
    if (action === 'none') return true;
    if (action === 'hold') {
      holdCurrentDraft();
      return true;
    }
    return saveCurrentNote();
  }

  async function openNote(id: string) {
    if (notesStore.currentNote?.id !== id && !(await canLeaveCurrentNote())) return;
    const opened = await notesStore.fetchNote(id);
    if (!opened || notesStore.currentNote?.id !== id) return;
    await tick();
    restoreHeldDraft(projectStore.currentPath, id);
    activeView = notesStore.currentNote?.format === 'html' ? 'preview' : 'editor';
    if (isNarrow) showSidebar = false; // reveal the editor full-width on phones
  }

  async function createNewNote() {
    if (!(await canLeaveCurrentNote())) return;
    const note = await notesStore.createNote({
      title: 'Untitled',
      content: '',
      folderPath:
        notesStore.selectedFolder !== '/'
          ? notesStore.selectedFolder
          : (notesStore.settings.defaultFolderPath ?? '/'),
      tags: [],
      pinned: false,
      includeInContext: false,
    });
    if (note) {
      await notesStore.fetchNote(note.id);
      activeView = 'editor';
      await tick();
      titleInputEl?.focus();
      titleInputEl?.select();
    }
  }

  async function saveCurrentNote(
    expectedRevision = baseRevision ?? undefined,
    restoreDeletedSource = false,
  ): Promise<boolean> {
    cancelAutosave();
    const note = notesStore.currentNote;
    if (!note) return true;
    if (!isDirty && !notesStore.conflict) return true;
    if (overNoteBudget) {
      saveState = 'error';
      return false;
    }
    if (savePromise) {
      const pending = savePromise;
      const success = await pending;
      if (!success) return false;
      return isDirty && !notesStore.conflict ? saveCurrentNote() : true;
    }

    const version = editVersion;
    const draft = {
      title: titleInput.trim() || 'Untitled',
      content: contentInput,
      folderPath: folderInput || '/',
      tags: [...tags],
      pinned,
      includeInContext,
      expectedRevision,
      ...(restoreDeletedSource ? { restoreDeletedSource: true } : {}),
    };
    saveState = 'saving';
    savePromise = notesStore
      .updateNote(note.id, draft)
      .then(async (updated) => {
        if (!updated) {
          saveState = notesStore.conflict ? 'conflict' : 'error';
          return false;
        }
        baseRevision = updated.revision;
        if (isCurrentDraftVersion(version, editVersion)) {
          isDirty = false;
          saveState = 'saved';
          const projectPath = projectStore.currentPath;
          if (projectPath) {
            draftRegistry.delete(noteDraftKey(projectPath, note.id));
            refreshDrafts();
          }
        } else {
          saveState = 'dirty';
        }
        if (activeView === 'graph') await notesStore.fetchGraph();
        return true;
      })
      .finally(() => {
        savePromise = null;
      });
    return savePromise;
  }

  async function deleteCurrentNote() {
    const note = notesStore.currentNote;
    if (!note) return;
    const dirtyWarning = isDirty ? ' Unsaved changes will also be discarded.' : '';
    if (!confirm(`Delete "${note.title}"? This cannot be undone.${dirtyWarning}`)) return;
    cancelAutosave();
    if (savePromise) await savePromise;
    const current = notesStore.currentNote;
    if (!current || current.id !== note.id) return;
    const deleted = await notesStore.deleteNote(current.id, current.revision);
    if (!deleted) return;
    const projectPath = projectStore.currentPath;
    if (projectPath) {
      draftRegistry.delete(noteDraftKey(projectPath, current.id));
      refreshDrafts();
    }
  }

  // ── Autosave ──────────────────────────────────────────────────────────────
  function cancelAutosave() {
    if (autosaveTimer) clearTimeout(autosaveTimer);
    autosaveTimer = null;
  }

  function scheduleAutosave() {
    isDirty = true;
    editVersion++;
    saveState = 'dirty';
    cancelAutosave();
    const delay = autosaveDelayForDraft({
      enabled: notesStore.settings.autosaveEnabled,
      overBudget: overNoteBudget,
      delayMs: notesStore.settings.autosaveDelayMs,
    });
    if (delay === null) return;
    autosaveTimer = setTimeout(() => {
      void saveCurrentNote();
    }, delay);
  }

  // ── Tags ──────────────────────────────────────────────────────────────────
  function handleTagsKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      addTag(tagsInput.replace(/,$/, '').trim());
    } else if (e.key === 'Backspace' && !tagsInput && tags.length > 0) {
      tags = tags.slice(0, -1);
      scheduleAutosave();
    }
  }

  function addTag(t: string) {
    const clean = t.trim().toLowerCase().replace(/\s+/g, '-');
    if (clean && !tags.includes(clean)) {
      tags = [...tags, clean];
      scheduleAutosave();
    }
    tagsInput = '';
  }

  function removeTag(t: string) {
    tags = tags.filter((x) => x !== t);
    scheduleAutosave();
  }

  // ── Folder autocomplete ───────────────────────────────────────────────────
  function collectAllFolderPaths(
    nodes: typeof notesStore.folderTree,
    acc: string[] = [],
  ): string[] {
    for (const n of nodes) {
      acc.push(n.path);
      collectAllFolderPaths(n.children, acc);
    }
    return acc;
  }

  function handleFolderInput() {
    scheduleAutosave();
    const q = folderInput.toLowerCase();
    const allPaths = collectAllFolderPaths(notesStore.folderTree);
    folderSuggestions = q
      ? allPaths.filter((p) => p.toLowerCase().includes(q) && p !== folderInput)
      : [];
    showFolderSuggestions = folderSuggestions.length > 0;
    folderActiveIndex = 0;
  }

  function chooseFolder(path: string): void {
    folderInput = path;
    showFolderSuggestions = false;
    scheduleAutosave();
  }

  function handleFolderKeydown(event: KeyboardEvent): void {
    if (!showFolderSuggestions || folderSuggestions.length === 0) return;
    const visible = folderSuggestions.slice(0, 6);
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      folderActiveIndex = (folderActiveIndex + 1) % visible.length;
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      folderActiveIndex = (folderActiveIndex - 1 + visible.length) % visible.length;
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const suggestion = visible[folderActiveIndex];
      if (suggestion) chooseFolder(suggestion);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      showFolderSuggestions = false;
    }
  }

  // ── File attachment drag-drop ─────────────────────────────────────────────
  function handleDragOver(e: DragEvent) {
    e.preventDefault();
    dragOver = true;
  }

  function handleDragLeave() {
    dragOver = false;
  }

  async function handleDrop(e: DragEvent) {
    e.preventDefault();
    dragOver = false;
    const note = notesStore.currentNote;
    if (!note) {
      toastStore.error('Open a note first to attach files');
      return;
    }
    const files = Array.from(e.dataTransfer?.files ?? []);
    for (const file of files) {
      const attachment = await notesStore.uploadAttachment(note.id, file);
      if (attachment) {
        // Insert embed at cursor in textarea
        const embedText = attachment.mimeType.startsWith('image/')
          ? `![[${attachment.filename}]]`
          : `[[${attachment.filename}]]`;
        insertAtCursor(contentAreaEl, embedText);
        scheduleAutosave();
      }
    }
  }

  function insertAtCursor(el: HTMLTextAreaElement | undefined, text: string) {
    if (!el) return;
    const start = el.selectionStart ?? contentInput.length;
    const end = el.selectionEnd ?? contentInput.length;
    contentInput = contentInput.slice(0, start) + text + contentInput.slice(end);
    tick().then(() => {
      el.selectionStart = el.selectionEnd = start + text.length;
    });
  }

  // ── Folder tree helpers ───────────────────────────────────────────────────
  function toggleFolder(path: string) {
    if (expandedFolders.has(path)) {
      expandedFolders.delete(path);
    } else {
      expandedFolders.add(path);
    }
    expandedFolders = new Set(expandedFolders);
  }

  // ── Graph view ────────────────────────────────────────────────────────────
  async function switchToGraph() {
    activeView = 'graph';
    await notesStore.fetchGraph();
  }

  function handleGraphNodeClick(noteId: string) {
    activeView = 'editor';
    void openNote(noteId);
  }

  function switchToCanvas() {
    activeView = 'canvas';
  }

  const viewOrder = ['editor', 'preview', 'graph', 'canvas'] as const;
  function handleViewTabKeydown(event: KeyboardEvent, current: (typeof viewOrder)[number]) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const available = viewOrder.filter((view) => view !== 'preview' || Boolean(currentNote));
    const currentIndex = Math.max(0, available.indexOf(current));
    const nextIndex =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? available.length - 1
          : (currentIndex + (event.key === 'ArrowRight' ? 1 : -1) + available.length) %
            available.length;
    const next = available[nextIndex];
    activeView = next;
    if (next === 'graph') void notesStore.fetchGraph();
    void tick().then(() => document.getElementById(`notes-tab-${next}`)?.focus());
  }

  function handleCanvasOpenNote(noteId: string) {
    activeView = 'editor';
    void openNote(noteId);
  }

  // ── Attachment helpers ─────────────────────────────────────────────────────
  /** Flip a note between markdown and HTML format (persisted immediately). */
  async function toggleNoteFormat() {
    const note = notesStore.currentNote;
    if (!note) return;
    if (!(await canLeaveCurrentNote())) return;
    const next = note.format === 'html' ? 'markdown' : 'html';
    const updated = await notesStore.updateNote(note.id, {
      format: next,
      expectedRevision: baseRevision ?? note.revision,
    });
    if (updated) {
      baseRevision = updated.revision;
      activeView = next === 'html' ? 'preview' : 'editor';
    }
  }

  function attachmentSrc(a: NoteAttachment): string {
    return attachmentObjectUrls[a.id] ?? '';
  }

  async function deleteNoteAttachment(attachment: NoteAttachment): Promise<void> {
    const note = notesStore.currentNote;
    if (!note) return;
    const deleted = await notesStore.deleteAttachment(note.id, attachment.id);
    if (!deleted) return;
    attachmentLoadErrors.delete(attachment.id);
    attachmentLoadErrors = new Set(attachmentLoadErrors);
  }

  async function handleFileInputChange(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const note = notesStore.currentNote;
    if (!note || !input.files?.length) return;
    for (const file of Array.from(input.files)) {
      const attachment = await notesStore.uploadAttachment(note.id, file);
      if (attachment) {
        const embedText = attachment.mimeType.startsWith('image/')
          ? `![[${attachment.filename}]]`
          : `[[${attachment.filename}]]`;
        insertAtCursor(contentAreaEl, embedText);
        scheduleAutosave();
      }
    }
    input.value = '';
  }

  async function handleImportFile(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file || !(await canLeaveCurrentNote())) return;
    const imported = await notesStore.importNoteFile(file);
    if (imported) await openNote(imported.id);
  }

  function loadRemoteNote() {
    const remote = notesStore.conflict?.remote;
    if (!remote) return;
    notesStore.currentNote = remote;
    titleInput = remote.title;
    folderInput = remote.folderPath;
    contentInput = remote.content;
    tags = [...remote.tags];
    pinned = remote.pinned;
    includeInContext = remote.includeInContext;
    baseRevision = remote.revision;
    isDirty = false;
    editVersion++;
    saveState = 'idle';
    notesStore.clearConflict();
    notesStore.clearError();
  }

  function keepLocalNote() {
    const revision = notesStore.conflict?.remote.revision;
    if (revision === undefined) return;
    const restoreDeletedSource = notesStore.conflict?.sourceDeleted === true;
    notesStore.clearConflict();
    notesStore.clearError();
    void saveCurrentNote(revision, restoreDeletedSource);
  }

  async function retryCurrentAction() {
    if (notesStore.failedOperation?.kind === 'save-note') {
      await saveCurrentNote();
      return;
    }
    await notesStore.retryFailedOperation();
  }

  function retryLabel(): string {
    const kind = notesStore.failedOperation?.kind;
    if (kind === 'save-note') return 'Retry save';
    if (kind === 'delete-note') return 'Retry delete';
    if (kind === 'delete-attachment') return 'Retry attachment delete';
    if (kind === 'load-graph') return 'Retry graph';
    if (kind === 'sync-project') return 'Retry indexing';
    if (kind === 'import-memory') return 'Retry import';
    return 'Retry load';
  }

  async function recoverStrandedDraft() {
    const draft = strandedDraft;
    if (!draft) return;

    const selection = await selectProjectNavigation(draft.projectPath);
    if (!selection.ok) {
      toastStore.error(selection.error);
      return;
    }
    // Let the project-transition effect clear the previous view before asking
    // for the note under the restored project header.
    await tick();
    await notesStore.fetchNote(draft.noteId);
    await tick();
    const remote = notesStore.currentNote;
    if (!remote || remote.id !== draft.noteId) {
      toastStore.error('The original note could not be reopened. The draft is still held here.');
      return;
    }

    titleInput = draft.title;
    folderInput = draft.folderPath;
    contentInput = draft.content;
    tags = [...draft.tags];
    pinned = draft.pinned;
    includeInContext = draft.includeInContext;
    baseRevision = draft.revision ?? remote.revision;
    editVersion++;
    isDirty = true;
    saveState = 'dirty';
    activeView = 'editor';
    draftRegistry.delete(noteDraftKey(draft.projectPath, draft.noteId));
    refreshDrafts();
    toastStore.info(`Recovered the unsaved draft for ${draft.noteTitle}`);
  }

  function discardStrandedDraft() {
    if (!strandedDraft) return;
    if (!confirm(`Discard the unsaved draft for "${strandedDraft.noteTitle}"?`)) return;
    draftRegistry.delete(noteDraftKey(strandedDraft.projectPath, strandedDraft.noteId));
    refreshDrafts();
    toastStore.info('Discarded the held draft');
  }

  function formatBytes(value: number) {
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
    return `${(value / (1024 * 1024)).toFixed(2)} MiB`;
  }
</script>

<div class="relative flex h-full min-h-0 min-w-0" style="background: var(--color-surface-1);">
  {#if isNarrow && showSidebar}
    <!-- Tap-outside backdrop to dismiss the note-list overlay on phones -->
    <button
      type="button"
      class="absolute inset-0 z-20 bg-black/40"
      aria-label="Close note list"
      onclick={() => (showSidebar = false)}
    ></button>
  {/if}
  <!-- ── Left sidebar ──────────────────────────────────────────────────────── -->
  <aside
    class="border-r flex flex-col min-h-0 {isNarrow
      ? 'absolute inset-y-0 left-0 z-30 w-full max-w-xs shadow-2xl'
      : 'shrink-0'} {isNarrow && !showSidebar ? 'hidden' : ''}"
    style="{isNarrow
      ? ''
      : 'width: 280px;'} border-color: var(--color-border); background: var(--color-surface-1);"
  >
    <!-- Header -->
    <div
      class="flex items-center justify-between px-4 py-3 border-b shrink-0"
      style="border-color: var(--color-border);"
    >
      <div class="flex items-center gap-2">
        <StickyNote size={15} style="color: var(--color-accent);" />
        <span class="text-sm font-semibold" style="color: var(--color-text-primary);">Notes</span>
      </div>
      <div class="flex items-center gap-1">
        <input
          bind:this={importInputEl}
          type="file"
          class="hidden"
          accept=".md,.markdown,.html,.htm,text/markdown,text/html"
          onchange={handleImportFile}
        />
        <button
          type="button"
          class="p-1.5 rounded-lg transition-colors hover:bg-[var(--color-surface-3)]"
          style="color: var(--color-text-muted);"
          onclick={() => importInputEl?.click()}
          title="Import Markdown or HTML"
          aria-label="Import note"
        >
          <Upload size={13} />
        </button>
        <button
          type="button"
          class="p-1.5 rounded-lg transition-colors hover:bg-[var(--color-surface-3)]"
          style="color: var(--color-text-muted);"
          onclick={() => void notesStore.syncProjectDocuments()}
          title="Re-index project Markdown and HTML"
          aria-label="Re-index project documents"
        >
          <RefreshCw size={13} />
        </button>
        <button
          bind:this={settingsTriggerEl}
          type="button"
          class="p-1.5 rounded-lg transition-colors hover:bg-[var(--color-surface-3)]"
          style="color: {showEditorSettings ? 'var(--color-accent)' : 'var(--color-text-muted)'};"
          onclick={() => {
            showEditorSettings = !showEditorSettings;
            if (showEditorSettings) void tick().then(() => settingsCloseEl?.focus());
          }}
          title="Notes editor settings"
          aria-label="Notes editor settings"
          aria-expanded={showEditorSettings}
        >
          <Settings size={13} />
        </button>
        <button
          type="button"
          class="p-1.5 rounded-lg transition-colors hover:bg-[var(--color-surface-3)]"
          style="color: var(--color-text-muted);"
          onclick={switchToGraph}
          title="Graph view"
          aria-label="Graph view"
        >
          <Share2 size={13} />
        </button>
        <button
          type="button"
          class="p-1.5 rounded-lg transition-colors hover:bg-[var(--color-surface-3)]"
          style="color: var(--color-text-secondary);"
          onclick={createNewNote}
          title="New note"
          aria-label="New note"
        >
          <Plus size={13} />
        </button>
      </div>
    </div>

    <!-- Search -->
    <div class="px-3 py-2 shrink-0">
      <div class="relative flex items-center">
        <Search
          size={12}
          class="absolute left-2.5 pointer-events-none"
          style="color: var(--color-text-muted);"
        />
        <input
          type="text"
          placeholder="Search notes..."
          class="w-full h-7 rounded-lg border pl-7 pr-3 text-xs"
          style="
            background: var(--color-surface-2);
            border-color: var(--color-border);
            color: var(--color-text-primary);
          "
          bind:value={searchInput}
          oninput={() => {
            if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
            searchDebounceTimer = setTimeout(() => {
              searchQuery = searchInput;
              void notesStore.setSearchQuery(searchInput);
            }, 300);
          }}
        />
      </div>
    </div>

    <!-- Folder tree -->
    {#if notesStore.folderTree.length > 0}
      <div class="shrink-0 px-2 pb-1">
        <div
          class="text-[10px] font-semibold uppercase tracking-widest px-2 mb-1"
          style="color: var(--color-text-muted);"
        >
          Folders
        </div>
        {#snippet folderNode(node: (typeof notesStore.folderTree)[0], depth: number)}
          <div style="padding-left: {depth * 12}px;">
            <button
              type="button"
              class="flex w-full items-center gap-1.5 rounded-lg px-2 py-1 text-xs transition-colors hover:bg-[var(--color-surface-3)]"
              style="color: {notesStore.selectedFolder === node.path
                ? 'var(--color-accent)'
                : 'var(--color-text-secondary)'};"
              onclick={() => {
                void notesStore.selectFolder(node.path);
                if (node.children.length > 0) toggleFolder(node.path);
              }}
            >
              {#if node.children.length > 0}
                {#if expandedFolders.has(node.path)}
                  <ChevronDown size={10} />
                  <FolderOpen size={11} />
                {:else}
                  <ChevronRight size={10} />
                  <Folder size={11} />
                {/if}
              {:else}
                <span class="w-[10px]"></span>
                <Folder size={11} />
              {/if}
              <span class="truncate">{node.name}</span>
              {#if node.noteCount > 0}
                <span class="ml-auto text-[10px] opacity-50">{node.noteCount}</span>
              {/if}
            </button>
            {#if expandedFolders.has(node.path) && node.children.length > 0}
              {#each node.children as child (child.path)}
                {@render folderNode(child, depth + 1)}
              {/each}
            {/if}
          </div>
        {/snippet}

        <!-- Root folder -->
        <button
          type="button"
          class="flex w-full items-center gap-1.5 rounded-lg px-2 py-1 text-xs transition-colors hover:bg-[var(--color-surface-3)]"
          style="color: {notesStore.selectedFolder === '/'
            ? 'var(--color-accent)'
            : 'var(--color-text-secondary)'};"
          onclick={() => void notesStore.selectFolder('/')}
        >
          <Folder size={11} />
          <span>All Notes</span>
          <span class="ml-auto text-[10px] opacity-50">{notesStore.notes.length}</span>
        </button>
        {#each notesStore.folderTree as node (node.path)}
          {@render folderNode(node, 1)}
        {/each}
      </div>
    {/if}

    <!-- Tag filters -->
    {#if notesStore.notes.some((n) => n.tags.length > 0)}
      {@const allTags = [...new Set(notesStore.notes.flatMap((n) => n.tags))].slice(0, 15)}
      <div class="shrink-0 px-3 pb-2">
        <div
          class="text-[10px] font-semibold uppercase tracking-widest mb-1.5"
          style="color: var(--color-text-muted);"
        >
          Tags
        </div>
        <div class="flex flex-wrap gap-1">
          {#each allTags as tag (tag)}
            <button
              type="button"
              class="inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] transition-colors hover:bg-[var(--color-surface-4)]"
              style="background: var(--color-surface-3); color: var(--color-text-secondary);"
              onclick={() => {
                searchInput = tag;
                searchQuery = tag;
                void notesStore.setSearchQuery(tag);
              }}
            >
              <Tag size={8} />
              {tag}
            </button>
          {/each}
        </div>
      </div>
    {/if}

    <!-- Note list (virtualized — stays smooth at thousands of notes) -->
    <div class="flex-1 min-h-0 overflow-hidden">
      {#if notesStore.isLoading}
        <div class="flex items-center justify-center py-8">
          <div class="text-xs" style="color: var(--color-text-muted);">Loading...</div>
        </div>
      {:else if filteredNotes.length === 0}
        <div class="flex flex-col items-center justify-center py-10 text-center px-4">
          <StickyNote size={24} class="opacity-20 mb-2" style="color: var(--color-text-muted);" />
          <div class="text-xs" style="color: var(--color-text-muted);">
            {searchInput ? 'No matching notes' : 'No notes yet'}
          </div>
          <button
            type="button"
            class="mt-3 text-xs px-3 py-1.5 rounded-lg transition-colors hover:bg-[var(--color-surface-3)]"
            style="color: var(--color-accent);"
            onclick={createNewNote}
          >
            + New note
          </button>
        </div>
      {:else}
        <VirtualList
          items={filteredNotes}
          estimateHeight={estimateNoteHeight}
          class="h-full px-2 pb-3"
        >
          {#snippet row(note)}
            <button
              type="button"
              class="w-full text-left rounded-xl px-3 py-2.5 mb-1 transition-colors border border-transparent"
              style="
                background: {notesStore.currentNote?.id === note.id
                ? 'var(--color-surface-3)'
                : 'transparent'};
                border-color: {notesStore.currentNote?.id === note.id
                ? 'var(--color-border)'
                : 'transparent'};
              "
              onclick={() => void openNote(note.id)}
            >
              <div class="flex items-start gap-2 min-w-0">
                {#if note.pinned}
                  <Pin size={10} class="mt-0.5 shrink-0" style="color: var(--color-accent);" />
                {:else}
                  <FileText
                    size={10}
                    class="mt-0.5 shrink-0 opacity-40"
                    style="color: var(--color-text-muted);"
                  />
                {/if}
                <div class="min-w-0 flex-1">
                  <div
                    class="truncate text-xs font-medium"
                    style="color: var(--color-text-primary);"
                  >
                    {note.title}
                  </div>
                  {#if note.content}
                    <div
                      class="truncate text-[10px] mt-0.5"
                      style="color: var(--color-text-muted);"
                    >
                      {note.content.slice(0, 60).replace(/\n/g, ' ')}
                    </div>
                  {/if}
                  {#if note.tags.length > 0}
                    <div class="flex flex-wrap gap-0.5 mt-1">
                      {#each note.tags.slice(0, 3) as tag (tag)}
                        <span
                          class="rounded px-1 py-0 text-[9px]"
                          style="background: var(--color-surface-3); color: var(--color-text-muted);"
                          >{tag}</span
                        >
                      {/each}
                    </div>
                  {/if}
                </div>
              </div>
            </button>
          {/snippet}
        </VirtualList>
      {/if}
    </div>
  </aside>

  <!-- ── Main area ───────────────────────────────────────────────────────────── -->
  <div class="flex-1 min-h-0 min-w-0 flex flex-col">
    <!-- Tab bar -->
    <div
      class="flex items-center gap-1 px-4 py-2 border-b shrink-0"
      style="border-color: var(--color-border); background: var(--color-surface-0);"
    >
      {#if isNarrow}
        <button
          type="button"
          class="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors"
          style="background: var(--color-surface-3); color: var(--color-text-primary);"
          onclick={() => (showSidebar = !showSidebar)}
          aria-label="Toggle note list"
        >
          <StickyNote size={13} />
          Notes
        </button>
      {/if}
      <div class="flex items-center gap-1" role="tablist" aria-label="Notes views">
        <button
          id="notes-tab-editor"
          type="button"
          role="tab"
          aria-selected={activeView === 'editor'}
          aria-controls="notes-view-panel"
          tabindex={activeView === 'editor' ? 0 : -1}
          class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors"
          style="
          background: {activeView === 'editor' ? 'var(--color-surface-3)' : 'transparent'};
          color: {activeView === 'editor'
            ? 'var(--color-text-primary)'
            : 'var(--color-text-muted)'};
        "
          onclick={() => {
            activeView = 'editor';
          }}
          onkeydown={(event) => handleViewTabKeydown(event, 'editor')}
        >
          <FileText size={12} />
          Editor
        </button>
        {#if currentNote}
          <button
            id="notes-tab-preview"
            type="button"
            role="tab"
            aria-selected={activeView === 'preview'}
            aria-controls="notes-view-panel"
            tabindex={activeView === 'preview' ? 0 : -1}
            class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors"
            style="background: {activeView === 'preview'
              ? 'var(--color-surface-3)'
              : 'transparent'}; color: {activeView === 'preview'
              ? 'var(--color-text-primary)'
              : 'var(--color-text-muted)'};"
            onclick={() => {
              activeView = 'preview';
            }}
            onkeydown={(event) => handleViewTabKeydown(event, 'preview')}
            title={currentNote.format === 'html'
              ? 'Sandboxed HTML preview'
              : 'Rendered Markdown preview'}
          >
            <Eye size={12} />
            Preview
          </button>
        {/if}
        <button
          id="notes-tab-graph"
          type="button"
          role="tab"
          aria-selected={activeView === 'graph'}
          aria-controls="notes-view-panel"
          tabindex={activeView === 'graph' ? 0 : -1}
          class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors"
          style="
          background: {activeView === 'graph' ? 'var(--color-surface-3)' : 'transparent'};
          color: {activeView === 'graph' ? 'var(--color-text-primary)' : 'var(--color-text-muted)'};
        "
          onclick={switchToGraph}
          onkeydown={(event) => handleViewTabKeydown(event, 'graph')}
        >
          <Share2 size={12} />
          Graph
        </button>
        <button
          id="notes-tab-canvas"
          type="button"
          role="tab"
          aria-selected={activeView === 'canvas'}
          aria-controls="notes-view-panel"
          tabindex={activeView === 'canvas' ? 0 : -1}
          class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors"
          style="
          background: {activeView === 'canvas' ? 'var(--color-surface-3)' : 'transparent'};
          color: {activeView === 'canvas'
            ? 'var(--color-text-primary)'
            : 'var(--color-text-muted)'};
        "
          onclick={switchToCanvas}
          onkeydown={(event) => handleViewTabKeydown(event, 'canvas')}
        >
          <LayoutGrid size={12} />
          Canvas
        </button>
      </div>

      {#if (activeView === 'editor' || activeView === 'preview') && currentNote}
        <!-- Note actions -->
        <div class="ml-auto flex items-center gap-1">
          <!-- Format toggle: HTML notes render charts/diagrams in the sandboxed preview -->
          <button
            type="button"
            class="flex items-center gap-1 px-2 py-1 rounded-lg text-xs transition-colors hover:bg-[var(--color-surface-3)]"
            style="color: {currentNote.format === 'html'
              ? 'var(--color-accent)'
              : 'var(--color-text-muted)'};"
            onclick={() => void toggleNoteFormat()}
            title={currentNote.format === 'html'
              ? 'Convert to Markdown note'
              : 'Convert to HTML note (renders HTML+CSS)'}
          >
            <Code2 size={12} />
            <span class="text-[10px]">{currentNote.format === 'html' ? 'HTML' : 'MD'}</span>
          </button>

          {#if currentNote.format === 'html'}
            <button
              type="button"
              class="flex items-center gap-1 px-2 py-1 rounded-lg text-xs transition-colors hover:bg-[var(--color-surface-3)]"
              style="color: var(--color-text-muted);"
              onclick={() => (activeView = activeView === 'preview' ? 'editor' : 'preview')}
              title={activeView === 'preview' ? 'Edit HTML source' : 'Render preview'}
            >
              {activeView === 'preview' ? 'Edit' : 'Preview'}
            </button>
          {/if}

          <button
            type="button"
            class="flex items-center gap-1 px-2 py-1 rounded-lg text-xs transition-colors hover:bg-[var(--color-surface-3)]"
            style="color: var(--color-text-muted);"
            onclick={() => void notesStore.exportNote(currentNote.id)}
            title="Export this note"
          >
            <Download size={12} />
            <span class="text-[10px]">Export</span>
          </button>

          <!-- Tag picker: quick selection of tags already used in this workspace. -->
          <div class="relative">
            <button
              type="button"
              class="flex items-center gap-1 px-2 py-1 rounded-lg text-xs transition-colors hover:bg-[var(--color-surface-3)]"
              style="color: {showTagMenu || tags.length > 0
                ? 'var(--color-accent)'
                : 'var(--color-text-muted)'};"
              onclick={() => (showTagMenu = !showTagMenu)}
              title="Choose tags"
            >
              <Tag size={12} />
              <span class="text-[10px]">{tags.length ? `Tags (${tags.length})` : 'Tags'}</span>
            </button>
            {#if showTagMenu}
              <div
                class="absolute right-0 top-full z-30 mt-1 min-w-40 rounded-lg border p-1 shadow-xl"
                style="background: var(--color-surface-2); border-color: var(--color-border);"
              >
                {#each availableTags as tag (tag)}
                  <button
                    type="button"
                    class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-[var(--color-surface-3)]"
                    style="color: var(--color-text-secondary);"
                    onclick={() => {
                      addTag(tag);
                      scheduleAutosave();
                      showTagMenu = false;
                    }}
                  >
                    <Tag size={11} />
                    {tag}
                  </button>
                {:else}
                  <span class="block px-2 py-1.5 text-xs" style="color: var(--color-text-muted);">
                    Add a tag below
                  </span>
                {/each}
              </div>
            {/if}
          </div>

          <!-- Pin toggle -->
          <button
            type="button"
            class="flex items-center gap-1 px-2 py-1 rounded-lg text-xs transition-colors hover:bg-[var(--color-surface-3)]"
            style="color: {pinned ? 'var(--color-accent)' : 'var(--color-text-muted)'};"
            onclick={() => {
              pinned = !pinned;
              scheduleAutosave();
            }}
            title={pinned
              ? 'Unpin from the top of the Notes list'
              : 'Pin near the top of the Notes list (does not add agent context)'}
            aria-pressed={pinned}
          >
            {#if pinned}<Pin size={12} />{:else}<PinOff size={12} />{/if}
            <span class="text-[10px]">{pinned ? 'Pinned' : 'Pin'}</span>
          </button>

          <!-- Include in context toggle -->
          <button
            type="button"
            class="flex items-center gap-1 px-2 py-1 rounded-lg text-xs transition-colors hover:bg-[var(--color-surface-3)]"
            style="color: {includeInContext ? 'var(--color-accent)' : 'var(--color-text-muted)'};"
            onclick={() => {
              includeInContext = !includeInContext;
              scheduleAutosave();
            }}
            title={includeInContext ? 'Remove from agent context' : 'Include in agent context'}
            aria-pressed={includeInContext}
          >
            <BookOpen size={12} />
            <span class="text-[10px]">{includeInContext ? 'In context' : 'Add to context'}</span>
          </button>

          <!-- Save -->
          <button
            type="button"
            class="flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium transition-colors"
            style="
              background: {isDirty ? 'var(--color-accent)' : 'var(--color-surface-3)'};
              color: {isDirty ? 'var(--color-surface-0)' : 'var(--color-text-muted)'};
            "
            onclick={() => void saveCurrentNote()}
            title="Save (Ctrl+S)"
            disabled={saveState === 'saving' || overNoteBudget}
          >
            {#if saveState === 'saving'}<LoaderCircle size={12} class="animate-spin" /> Saving…{:else if !isDirty}<Check
                size={12}
              /> Saved{:else}<Save size={12} /> Save{/if}
          </button>

          <!-- Delete -->
          <button
            type="button"
            class="p-1.5 rounded-lg text-xs transition-colors hover:bg-[var(--color-surface-3)]"
            style="color: var(--color-text-muted);"
            onclick={() => void deleteCurrentNote()}
            title="Delete note"
          >
            <Trash2 size={12} />
          </button>
        </div>
      {/if}
    </div>

    {#if strandedDraft}
      <div
        class="shrink-0 border-b px-4 py-2.5"
        style="border-color: color-mix(in srgb, var(--color-warning) 30%, var(--color-border)); background: var(--color-warning-bg);"
        role="alert"
      >
        <div class="flex flex-wrap items-center gap-3">
          <AlertTriangle size={15} class="shrink-0 text-[var(--color-warning)]" />
          <p class="min-w-56 flex-1 text-xs leading-5 text-[var(--color-text-primary)]">
            An unsaved draft for “{strandedDraft.noteTitle}” is being held from
            {projectDisplayName(strandedDraft.projectPath)}. It was not carried into
            {projectDisplayName(projectStore.currentPath) ||
              'the new workspace'}.{#if strandedDrafts.length > 1}
              {strandedDrafts.length - 1} more draft{strandedDrafts.length === 2 ? '' : 's'} are also
              held.{/if}
          </p>
          <button
            type="button"
            class="rounded-lg px-2.5 py-1.5 text-xs font-semibold hover:brightness-110"
            style="background: var(--color-warning); color: var(--color-surface-0);"
            onclick={() => void recoverStrandedDraft()}>Return and recover</button
          >
          <button
            type="button"
            class="rounded-lg border border-[var(--color-warning)]/30 px-2.5 py-1.5 text-xs text-[var(--color-warning)] hover:bg-[var(--color-warning-bg)]"
            onclick={discardStrandedDraft}>Discard draft</button
          >
        </div>
      </div>
    {/if}

    {#if notesStore.conflict && notesStore.conflict.noteId === currentNote?.id && activeView !== 'canvas'}
      <div
        class="shrink-0 border-b px-4 py-2.5"
        style="border-color: color-mix(in srgb, var(--color-warning) 30%, var(--color-border)); background: var(--color-warning-bg);"
        role="alert"
      >
        <div class="flex flex-wrap items-center gap-3">
          <AlertTriangle size={15} class="shrink-0 text-[var(--color-warning)]" />
          <p class="min-w-56 flex-1 text-xs leading-5 text-[var(--color-text-primary)]">
            {notesStore.conflict.sourceDeleted
              ? 'The project source file was deleted outside Koryphaios. Your draft is safe; recreate the file or accept its deletion.'
              : 'A newer revision was saved elsewhere. Your draft has not been overwritten.'}
          </p>
          {#if notesStore.conflict.sourceDeleted}
            <button
              type="button"
              class="rounded-lg border border-[var(--color-warning)]/30 px-2.5 py-1.5 text-xs text-[var(--color-warning)] hover:bg-[var(--color-warning-bg)]"
              onclick={() => void deleteCurrentNote()}>Accept deletion</button
            >
          {:else}
            <button
              type="button"
              class="rounded-lg border border-[var(--color-warning)]/30 px-2.5 py-1.5 text-xs text-[var(--color-warning)] hover:bg-[var(--color-warning-bg)]"
              onclick={loadRemoteNote}>Load newer version</button
            >
          {/if}
          <button
            type="button"
            class="rounded-lg px-2.5 py-1.5 text-xs font-semibold hover:brightness-110"
            style="background: var(--color-warning); color: var(--color-surface-0);"
            onclick={keepLocalNote}
            >{notesStore.conflict.sourceDeleted
              ? 'Recreate from my draft'
              : 'Keep my draft'}</button
          >
        </div>
      </div>
    {:else if notesStore.error && activeView !== 'canvas'}
      <div
        class="shrink-0 border-b px-4 py-2.5"
        style="border-color: color-mix(in srgb, var(--color-error) 30%, var(--color-border)); background: var(--color-error-bg);"
        role="alert"
      >
        <div class="flex items-center gap-3">
          <AlertTriangle size={15} class="shrink-0 text-[var(--color-error)]" />
          <p class="min-w-0 flex-1 text-xs text-[var(--color-text-primary)]">{notesStore.error}</p>
          <button
            type="button"
            class="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs text-[var(--color-error)] hover:bg-[var(--color-surface-2)]"
            onclick={() => void retryCurrentAction()}><RefreshCw size={12} /> {retryLabel()}</button
          >
        </div>
      </div>
    {/if}

    {#if overNoteBudget}
      <div
        class="shrink-0 border-b px-4 py-2 text-xs text-[var(--color-text-primary)]"
        style="border-color: color-mix(in srgb, var(--color-error) 30%, var(--color-border)); background: var(--color-error-bg);"
        role="alert"
      >
        This draft is {formatBytes(contentBytes - noteByteLimit)} over its configured size budget. Shorten
        it or raise the budget before saving.
      </div>
    {/if}

    <!-- Content -->
    <div
      id="notes-view-panel"
      class="flex-1 min-h-0 overflow-hidden"
      role="tabpanel"
      aria-labelledby={`notes-tab-${activeView}`}
    >
      {#if activeView === 'canvas'}
        <NotesCanvas onOpenNote={handleCanvasOpenNote} />
      {:else if activeView === 'graph'}
        <NotesGraph onNodeClick={handleGraphNodeClick} />
      {:else if activeView === 'preview' && currentNote?.format === 'html'}
        <div class="h-full flex flex-col" style="background: var(--color-surface-1);">
          <div
            class="flex items-center gap-2 px-4 py-2 border-b text-[11px]"
            style="border-color: var(--color-border); color: var(--color-text-muted);"
          >
            <Code2 size={12} />
            Sandboxed preview — CSS and embedded media work; scripts, forms, navigation, and network requests
            are blocked.
          </div>
          <iframe
            class="flex-1 w-full border-0 bg-white"
            title="HTML note preview"
            sandbox=""
            referrerpolicy="no-referrer"
            srcdoc={htmlPreview}
          ></iframe>
        </div>
      {:else if activeView === 'preview' && currentNote}
        <!-- Rendered Markdown preview -->
        <div class="h-full overflow-y-auto" style="background: var(--color-surface-1);">
          <div
            bind:this={previewContainer}
            class="note-markdown max-w-3xl mx-auto w-full px-8 py-8 text-sm leading-relaxed"
            style="color: var(--color-text-primary);"
            use:previewLinks
          >
            {@html markdownPreview}
          </div>
        </div>
      {:else if currentNote}
        <!-- Editor view -->
        <div
          bind:this={editorAreaEl}
          class="h-full overflow-y-auto flex flex-col"
          style="background: var(--color-surface-1);"
          ondragover={handleDragOver}
          ondragleave={handleDragLeave}
          ondrop={handleDrop}
          role="region"
          aria-label="Note editor"
        >
          {#if dragOver}
            <div
              class="absolute inset-0 z-10 flex items-center justify-center rounded-lg border-2 border-dashed pointer-events-none"
              style="border-color: var(--color-accent); background: rgba(var(--color-accent-rgb), 0.08);"
            >
              <div class="text-sm font-medium" style="color: var(--color-accent);">
                Drop files to attach
              </div>
            </div>
          {/if}

          <div class="max-w-3xl mx-auto w-full px-8 pt-8 pb-4 flex flex-col gap-4">
            <!-- Title -->
            <input
              bind:this={titleInputEl}
              type="text"
              placeholder="Note title..."
              class="w-full bg-transparent border-none outline-none text-2xl font-bold"
              style="color: var(--color-text-primary); font-family: var(--font-family-sans, inherit);"
              bind:value={titleInput}
              disabled={Boolean(currentNote.sourcePath)}
              oninput={scheduleAutosave}
            />

            {#if currentNote.sourcePath}
              <div
                class="flex items-center gap-2 rounded-xl border px-3 py-2 text-xs"
                style="border-color: var(--color-border); background: var(--color-surface-2); color: var(--color-text-secondary);"
              >
                <FileText size={12} style="color: var(--color-accent);" />
                <span class="font-mono truncate">{currentNote.sourcePath}</span>
                <span
                  class="ml-auto shrink-0 text-[10px] uppercase tracking-wider"
                  style="color: var(--color-text-muted);">live project file</span
                >
              </div>
            {/if}

            <!-- Metadata row -->
            <div class="flex flex-wrap items-center gap-3">
              <!-- Folder path -->
              <div class="relative flex items-center gap-1.5">
                <Folder size={12} style="color: var(--color-text-muted);" />
                <input
                  type="text"
                  placeholder="/"
                  class="bg-transparent border-none outline-none text-xs"
                  style="color: var(--color-text-secondary); width: 140px;"
                  bind:value={folderInput}
                  disabled={Boolean(currentNote.sourcePath)}
                  oninput={handleFolderInput}
                  onkeydown={handleFolderKeydown}
                  role="combobox"
                  aria-label="Note folder"
                  aria-autocomplete="list"
                  aria-expanded={showFolderSuggestions}
                  aria-controls={showFolderSuggestions ? 'note-folder-suggestions' : undefined}
                  aria-activedescendant={showFolderSuggestions
                    ? `note-folder-option-${folderActiveIndex}`
                    : undefined}
                  onblur={() => {
                    showFolderSuggestions = false;
                  }}
                />
                {#if showFolderSuggestions}
                  <div
                    id="note-folder-suggestions"
                    class="absolute top-full left-0 z-20 mt-1 rounded-lg border shadow-xl overflow-hidden"
                    style="background: var(--color-surface-2); border-color: var(--color-border); min-width: 160px;"
                    role="listbox"
                    aria-label="Folder suggestions"
                  >
                    {#each folderSuggestions.slice(0, 6) as sug, index (sug)}
                      <button
                        id={`note-folder-option-${index}`}
                        type="button"
                        role="option"
                        tabindex="-1"
                        aria-selected={index === folderActiveIndex}
                        class="w-full text-left px-3 py-1.5 text-xs hover:bg-[var(--color-surface-3)] transition-colors"
                        style="color: var(--color-text-secondary);"
                        onmousedown={(event) => {
                          event.preventDefault();
                          chooseFolder(sug);
                        }}>{sug}</button
                      >
                    {/each}
                  </div>
                {/if}
              </div>

              <!-- Tags -->
              <div class="flex items-center flex-wrap gap-1">
                <Tag size={11} style="color: var(--color-text-muted);" />
                {#each tags as tag (tag)}
                  <span
                    class="inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px]"
                    style="background: var(--color-surface-3); color: var(--color-text-secondary);"
                  >
                    {tag}
                    <button
                      type="button"
                      onclick={() => removeTag(tag)}
                      class="ml-0.5 hover:text-[var(--color-error)]"
                      aria-label="Remove tag"
                    >
                      <X size={8} />
                    </button>
                  </span>
                {/each}
                <input
                  type="text"
                  placeholder="Add tag…"
                  class="bg-transparent border-none outline-none text-xs"
                  style="color: var(--color-text-muted); width: 80px;"
                  bind:value={tagsInput}
                  onkeydown={handleTagsKeydown}
                  onblur={() => {
                    if (tagsInput.trim()) addTag(tagsInput);
                  }}
                />
              </div>
            </div>

            <!-- Divider -->
            <div class="border-t" style="border-color: var(--color-border);"></div>

            <!-- Content textarea + [[ wikilink autocomplete -->
            <div class="relative">
              <textarea
                bind:this={contentAreaEl}
                class="w-full min-h-[400px] bg-transparent border-none outline-none resize-none text-sm leading-relaxed font-mono"
                style="color: var(--color-text-primary); font-family: var(--font-mono, monospace);"
                placeholder="Start writing... Use [[Note Title]] to link notes."
                bind:value={contentInput}
                oninput={onContentInput}
                onkeydown={handleContentKeydown}
                onblur={() => {
                  setTimeout(() => (showWikilinkMenu = false), 150);
                }}
                aria-describedby="note-editor-status"
                role="combobox"
                aria-autocomplete="list"
                aria-expanded={showWikilinkMenu && wikilinkSuggestions.length > 0}
                aria-controls={showWikilinkMenu && wikilinkSuggestions.length > 0
                  ? 'note-wikilink-suggestions'
                  : undefined}
                aria-activedescendant={showWikilinkMenu && wikilinkSuggestions.length > 0
                  ? `note-wikilink-option-${wikilinkSuggestions[wikilinkActiveIndex]?.id}`
                  : undefined}
              ></textarea>
              {#if showWikilinkMenu && wikilinkSuggestions.length > 0}
                <div
                  id="note-wikilink-suggestions"
                  class="absolute z-30 mt-1 rounded-lg border shadow-xl overflow-hidden"
                  style="background: var(--color-surface-2); border-color: var(--color-border); min-width: 200px; max-width: 320px;"
                  role="listbox"
                  aria-label="Note link suggestions"
                >
                  <div
                    class="px-3 py-1 text-[10px] uppercase tracking-wider"
                    style="color: var(--color-text-muted);"
                  >
                    Link a note
                  </div>
                  {#each wikilinkSuggestions as sug, index (sug.id)}
                    <button
                      id={`note-wikilink-option-${sug.id}`}
                      type="button"
                      role="option"
                      tabindex="-1"
                      aria-selected={index === wikilinkActiveIndex}
                      class="w-full text-left px-3 py-1.5 text-xs hover:bg-[var(--color-surface-3)] transition-colors truncate"
                      style="color: var(--color-text-secondary);"
                      onmousedown={(e) => {
                        e.preventDefault();
                        insertWikilink(sug.title);
                      }}>{sug.title}</button
                    >
                  {/each}
                </div>
              {/if}
            </div>

            <div
              id="note-editor-status"
              class="flex items-center justify-between text-[11px]"
              style="color: var(--color-text-muted);"
            >
              <span
                >{notesStore.settings.autosaveEnabled
                  ? `Autosave after ${(notesStore.settings.autosaveDelayMs / 1000).toFixed(1)}s`
                  : 'Autosave off · only Ctrl/⌘ S or Save writes to disk'}</span
              >
              <span
                >{contentInput.split(/\s+/).filter(Boolean).length.toLocaleString()} words · {formatBytes(
                  contentBytes,
                )}{#if notesStore.settings.noteSizeLimitEnabled}
                  / {formatBytes(noteByteLimit)}{/if}</span
              >
            </div>

            <!-- Attachments -->
            <div class="border-t pt-4" style="border-color: var(--color-border);">
              <div class="flex items-center justify-between mb-3">
                <div
                  class="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-widest"
                  style="color: var(--color-text-muted);"
                >
                  <Paperclip size={11} />
                  Attachments
                </div>
                <label
                  class="flex items-center gap-1 px-2 py-1 rounded-lg text-[10px] cursor-pointer transition-colors hover:bg-[var(--color-surface-3)]"
                  style="color: var(--color-text-muted);"
                  title="Upload file"
                >
                  <Plus size={10} />
                  Add
                  <input
                    type="file"
                    class="hidden"
                    multiple
                    accept=".png,.jpg,.jpeg,.gif,.webp,.pdf,.txt,.log,.md,.markdown,.json,.zip,image/png,image/jpeg,image/gif,image/webp,application/pdf,text/plain,text/markdown,application/json,application/zip"
                    onchange={handleFileInputChange}
                  />
                </label>
              </div>

              {#if attachments.length === 0}
                <div
                  class="border-2 border-dashed rounded-xl flex flex-col items-center justify-center py-6 text-xs"
                  style="border-color: var(--color-border); color: var(--color-text-muted);"
                >
                  <Paperclip size={18} class="opacity-30 mb-1" />
                  Drag & drop files here
                </div>
              {:else}
                <div class="grid grid-cols-3 gap-2">
                  {#each attachments as att (att.id)}
                    <div
                      class="group relative rounded-lg border overflow-hidden"
                      style="border-color: var(--color-border); background: var(--color-surface-2);"
                    >
                      {#if att.mimeType.startsWith('image/') && attachmentSrc(att)}
                        <img
                          src={attachmentSrc(att)}
                          alt={att.filename}
                          class="w-full h-20 object-cover"
                        />
                      {:else}
                        <div class="flex flex-col items-center justify-center py-4">
                          <FileText size={20} style="color: var(--color-text-muted);" />
                          {#if attachmentLoadErrors.has(att.id)}
                            <button
                              type="button"
                              class="mt-2 rounded-md px-2 py-1 text-[10px] font-medium"
                              style="background: var(--color-error-bg); color: var(--color-error);"
                              onclick={() => void loadAttachmentUrls()}
                              aria-label={`Retry loading ${att.filename}`}>Retry load</button
                            >
                          {/if}
                        </div>
                      {/if}
                      <div class="p-1.5">
                        <div
                          class="text-[10px] truncate"
                          style="color: var(--color-text-secondary);"
                        >
                          {att.filename}
                        </div>
                      </div>
                      <!-- Actions overlay -->
                      <div
                        class="absolute top-1 right-1 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
                      >
                        {#if attachmentSrc(att)}
                          <a
                            href={attachmentSrc(att)}
                            download={att.filename}
                            class="rounded border p-1 transition-colors hover:bg-[var(--color-surface-3)]"
                            style="background: var(--color-surface-1); border-color: var(--color-border); color: var(--color-text-primary);"
                            title="Download"
                            aria-label="Download {att.filename}"
                          >
                            <Download size={10} />
                          </a>
                        {/if}
                        <button
                          type="button"
                          class="rounded border p-1 transition-colors hover:bg-[var(--color-error)]"
                          style="background: var(--color-surface-1); border-color: var(--color-border); color: var(--color-text-primary);"
                          onclick={() => void deleteNoteAttachment(att)}
                          title="Delete"
                          aria-label="Delete {att.filename}"
                        >
                          <X size={10} />
                        </button>
                      </div>
                    </div>
                  {/each}
                </div>
              {/if}
            </div>

            <!-- Backlinks -->
            {#if currentNote && currentNote.backlinks && currentNote.backlinks.length > 0}
              <div class="border-t pt-4" style="border-color: var(--color-border);">
                <div
                  class="text-xs font-semibold uppercase tracking-widest mb-2"
                  style="color: var(--color-text-muted);"
                >
                  Backlinks ({currentNote.backlinks.length})
                </div>
                <div class="space-y-1">
                  {#each currentNote.backlinks as backlinkId (backlinkId)}
                    {@const backNote = notesStore.notes.find((n) => n.id === backlinkId)}
                    {#if backNote}
                      <button
                        type="button"
                        class="flex items-center gap-2 w-full text-left px-3 py-1.5 rounded-lg text-xs transition-colors hover:bg-[var(--color-surface-3)]"
                        style="color: var(--color-text-secondary);"
                        onclick={() => void openNote(backlinkId)}
                      >
                        <FileText size={11} style="color: var(--color-text-muted);" />
                        {backNote.title}
                      </button>
                    {/if}
                  {/each}
                </div>
              </div>
            {/if}

            <!-- Outlinks -->
            {#if currentNote && currentNote.outlinks && currentNote.outlinks.length > 0}
              <div class="border-t pt-4 pb-8" style="border-color: var(--color-border);">
                <div
                  class="text-xs font-semibold uppercase tracking-widest mb-2"
                  style="color: var(--color-text-muted);"
                >
                  Outlinks ({currentNote.outlinks.length})
                </div>
                <div class="space-y-1">
                  {#each currentNote.outlinks as outlinkId (outlinkId)}
                    {@const outNote = notesStore.notes.find((n) => n.id === outlinkId)}
                    {#if outNote}
                      <button
                        type="button"
                        class="flex items-center gap-2 w-full text-left px-3 py-1.5 rounded-lg text-xs transition-colors hover:bg-[var(--color-surface-3)]"
                        style="color: var(--color-text-secondary);"
                        onclick={() => void openNote(outlinkId)}
                      >
                        <FileText size={11} style="color: var(--color-text-muted);" />
                        {outNote.title}
                      </button>
                    {/if}
                  {/each}
                </div>
              </div>
            {/if}
          </div>
        </div>
      {:else}
        <!-- Empty state: no note selected -->
        <div
          class="flex-1 flex flex-col items-center justify-center h-full"
          style="background: var(--color-surface-1);"
        >
          <div class="text-center max-w-xs">
            <StickyNote
              size={48}
              class="mx-auto mb-4 opacity-20"
              style="color: var(--color-text-muted);"
            />
            <div class="text-sm font-medium mb-1" style="color: var(--color-text-secondary);">
              No note selected
            </div>
            <div class="text-xs mb-4" style="color: var(--color-text-muted);">
              Pick a note from the list or create a new one.
            </div>
            <button
              type="button"
              class="px-4 py-2 rounded-xl text-xs font-semibold transition-colors"
              style="background: rgba(var(--color-accent-rgb), 0.12); color: var(--color-accent); border: 1px solid rgba(var(--color-accent-rgb), 0.25);"
              onclick={createNewNote}
            >
              + New Note
            </button>
          </div>
        </div>
      {/if}
    </div>
  </div>

  {#if showEditorSettings}
    <aside
      class="absolute inset-y-0 right-0 z-40 w-full max-w-sm overflow-y-auto border-l border-[var(--color-border)] bg-[var(--color-surface-1)] p-5 shadow-2xl shadow-black/40"
      aria-label="Notes editor settings"
    >
      <div class="flex items-start justify-between gap-3">
        <div>
          <h3 class="text-sm font-semibold text-[var(--color-text-primary)]">Notes policy</h3>
          <p class="mt-1 text-xs leading-5 text-[var(--color-text-muted)]">
            Long-form saving, storage, attachments, and context.
          </p>
        </div>
        <button
          bind:this={settingsCloseEl}
          type="button"
          class="rounded-lg p-1.5 text-[var(--color-text-muted)] hover:bg-[var(--color-surface-3)]"
          onclick={() => {
            showEditorSettings = false;
            void tick().then(() => settingsTriggerEl?.focus());
          }}
          aria-label="Close Notes settings"><X size={16} /></button
        >
      </div>

      <section class="mt-5 border-t border-[var(--color-border)]">
        <SettingsSwitch
          checked={notesStore.settings.autosaveEnabled}
          label="Autosave drafts"
          description="On saves while editing; off only Save or Ctrl/⌘ S writes to disk"
          onchange={() => {
            void notesStore.updateSettings({
              autosaveEnabled: !notesStore.settings.autosaveEnabled,
            });
          }}
          flat
        />
        {#if notesStore.settings.autosaveEnabled}
          <div class="border-t border-[var(--color-border)] py-3">
            <p class="mb-1.5 text-xs font-medium text-[var(--color-text-secondary)]">
              Autosave delay
            </p>
            <KorySelect
              compact
              value={String(notesStore.settings.autosaveDelayMs)}
              options={notesAutosaveOptions}
              label="Notes autosave delay"
              onchange={(value) => notesStore.updateSettings({ autosaveDelayMs: Number(value) })}
            />
          </div>
        {/if}
      </section>

      <section class="mt-3 border-t border-[var(--color-border)]">
        <SettingsSwitch
          checked={notesStore.settings.noteSizeLimitEnabled}
          label="Note size budget"
          description="Reject oversized writes without truncating the draft"
          onchange={() => {
            void notesStore.updateSettings({
              noteSizeLimitEnabled: !notesStore.settings.noteSizeLimitEnabled,
            });
          }}
          flat
        />
        {#if notesStore.settings.noteSizeLimitEnabled}
          <div class="border-t border-[var(--color-border)] py-3">
            <p class="mb-1.5 text-xs font-medium text-[var(--color-text-secondary)]">
              Maximum note bytes
            </p>
            <NumberStepper
              compact
              value={notesStore.settings.maxNoteBytes}
              min={16384}
              max={5000000}
              step={65536}
              label="Maximum note bytes"
              onchange={(value) => notesStore.updateSettings({ maxNoteBytes: value })}
            />
          </div>
        {/if}
      </section>

      <section class="mt-3 border-t border-[var(--color-border)]">
        <SettingsSwitch
          checked={notesStore.settings.attachmentSizeLimitEnabled}
          label="Attachment size budget"
          description="Enforce a per-file upload limit before reading the payload"
          onchange={() => {
            void notesStore.updateSettings({
              attachmentSizeLimitEnabled: !notesStore.settings.attachmentSizeLimitEnabled,
            });
          }}
          flat
        />
        {#if notesStore.settings.attachmentSizeLimitEnabled}
          <div class="border-t border-[var(--color-border)] py-3">
            <p class="mb-1.5 text-xs font-medium text-[var(--color-text-secondary)]">
              Maximum attachment bytes
            </p>
            <NumberStepper
              compact
              value={notesStore.settings.maxAttachmentBytes}
              min={64000}
              max={100000000}
              step={1000000}
              label="Maximum attachment bytes"
              onchange={(value) => notesStore.updateSettings({ maxAttachmentBytes: value })}
            />
          </div>
        {/if}
        <div class="border-t border-[var(--color-border)] py-3">
          <p class="mb-1.5 text-xs font-medium text-[var(--color-text-secondary)]">
            Attachments per note
          </p>
          <NumberStepper
            compact
            value={notesStore.settings.maxAttachmentsPerNote}
            min={1}
            max={250}
            step={1}
            label="Maximum attachments per note"
            onchange={(value) => notesStore.updateSettings({ maxAttachmentsPerNote: value })}
          />
        </div>
      </section>

      <section class="mt-3 border-y border-[var(--color-border)]">
        <SettingsSwitch
          checked={notesStore.settings.autoIncludeInContext}
          label="Notes in agent context"
          description="Allow explicitly selected notes to enter the active project context"
          onchange={() => {
            void notesStore.updateSettings({
              autoIncludeInContext: !notesStore.settings.autoIncludeInContext,
            });
          }}
          flat
        />
        <div class="border-t border-[var(--color-border)]">
          <SettingsSwitch
            checked={notesStore.settings.maxContextTokensEnabled}
            label="Context budget"
            description="Off still applies the 100,000-token safety ceiling"
            onchange={() => {
              void notesStore.updateSettings({
                maxContextTokensEnabled: !notesStore.settings.maxContextTokensEnabled,
              });
            }}
            flat
          />
        </div>
        {#if notesStore.settings.maxContextTokensEnabled}
          <div class="border-t border-[var(--color-border)] py-3">
            <p class="mb-1.5 text-xs font-medium text-[var(--color-text-secondary)]">
              Maximum context tokens
            </p>
            <NumberStepper
              compact
              value={notesStore.settings.maxContextTokens}
              min={100}
              max={100000}
              step={100}
              label="Maximum Notes context tokens"
              onchange={(value) => notesStore.updateSettings({ maxContextTokens: value })}
            />
          </div>
        {/if}
      </section>

      <p class="mt-4 text-[11px] leading-5 text-[var(--color-text-muted)]">
        Even with custom limits disabled, Koryphaios keeps hard 5 MiB note and 100 MB attachment
        safety ceilings.
      </p>
    </aside>
  {/if}
</div>

<style>
  /* Rendered Markdown preview typography */
  .note-markdown :global(h1) {
    font-size: 1.5rem;
    font-weight: 700;
    margin: 0.6em 0 0.4em;
    color: var(--color-text-primary);
  }
  .note-markdown :global(h2) {
    font-size: 1.25rem;
    font-weight: 700;
    margin: 0.6em 0 0.4em;
    color: var(--color-text-primary);
  }
  .note-markdown :global(h3) {
    font-size: 1.05rem;
    font-weight: 600;
    margin: 0.6em 0 0.3em;
    color: var(--color-text-primary);
  }
  .note-markdown :global(p) {
    margin: 0.5em 0;
  }
  .note-markdown :global(ul),
  .note-markdown :global(ol) {
    margin: 0.5em 0;
    padding-left: 1.4em;
  }
  .note-markdown :global(li) {
    margin: 0.2em 0;
  }
  .note-markdown :global(a) {
    color: var(--color-accent);
    text-decoration: underline;
  }
  .note-markdown :global(a.wikilink) {
    color: var(--color-accent);
    cursor: pointer;
    text-decoration: none;
    border-bottom: 1px dashed color-mix(in srgb, var(--color-accent) 50%, transparent);
  }
  .note-markdown :global(code) {
    font-family: var(--font-mono, monospace);
    font-size: 0.85em;
    background: var(--color-surface-3);
    padding: 0.1em 0.35em;
    border-radius: 4px;
  }
  .note-markdown :global(pre) {
    background: var(--color-surface-2);
    border: 1px solid var(--color-border);
    border-radius: 10px;
    padding: 0.8em 1em;
    overflow-x: auto;
    margin: 0.7em 0;
  }
  .note-markdown :global(pre code) {
    background: none;
    padding: 0;
  }
  .note-markdown :global(blockquote) {
    border-left: 3px solid var(--color-border);
    padding-left: 1em;
    margin: 0.6em 0;
    color: var(--color-text-secondary);
  }
  .note-markdown :global(table) {
    border-collapse: collapse;
    margin: 0.7em 0;
  }

  .note-markdown :global(.note-attachment-embed) {
    display: block;
    max-width: 100%;
    max-height: 32rem;
    margin: 1rem 0;
    border: 1px solid var(--color-border);
    border-radius: 0.75rem;
    object-fit: contain;
    background: var(--color-surface-2);
  }

  .note-markdown :global(.note-attachment-download) {
    color: var(--color-accent);
    text-decoration: underline;
    text-underline-offset: 0.2em;
  }

  .note-markdown :global(.attachment-unavailable) {
    color: var(--color-error);
  }
  .note-markdown :global(th),
  .note-markdown :global(td) {
    border: 1px solid var(--color-border);
    padding: 0.4em 0.7em;
  }
  .note-markdown :global(hr) {
    border: none;
    border-top: 1px solid var(--color-border);
    margin: 1em 0;
  }
  .note-markdown :global(img) {
    max-width: 100%;
    border-radius: 8px;
  }
  .note-markdown :global(mark) {
    background: color-mix(in srgb, var(--color-accent) 35%, transparent);
    color: inherit;
    padding: 0.05em 0.2em;
    border-radius: 3px;
  }
  /* KaTeX: keep block math scrollable, inherit color */
  .note-markdown :global(.katex) {
    color: var(--color-text-primary);
  }
  .note-markdown :global(.katex-display) {
    overflow-x: auto;
    overflow-y: hidden;
    padding: 0.3em 0;
  }
  /* Mermaid diagrams */
  .note-markdown :global(.mermaid-block) {
    display: flex;
    justify-content: center;
    margin: 0.8em 0;
  }
  .note-markdown :global(.mermaid-block svg) {
    max-width: 100%;
    height: auto;
  }
  .note-markdown :global(.mermaid-error) {
    color: var(--color-error);
    font-size: 0.8em;
    white-space: pre-wrap;
  }
  /* Dataview query results */
  .note-markdown :global(.dataview-result) {
    margin: 0.7em 0;
  }
  .note-markdown :global(.dataview-table) {
    border-collapse: collapse;
    width: 100%;
    font-size: 0.9em;
  }
  .note-markdown :global(.dataview-table th) {
    text-align: left;
    background: var(--color-surface-2);
    color: var(--color-text-secondary);
    font-weight: 600;
  }
  .note-markdown :global(.dataview-empty),
  .note-markdown :global(.dataview-error) {
    font-size: 0.85em;
    color: var(--color-text-secondary);
    font-style: italic;
    padding: 0.4em 0;
  }
  .note-markdown :global(.dataview-error) {
    color: var(--color-error);
    font-style: normal;
  }
  /* Callouts */
  .note-markdown :global(.callout) {
    border: 1px solid var(--color-border);
    border-left-width: 3px;
    border-radius: 8px;
    padding: 0.6em 0.9em;
    margin: 0.7em 0;
    background: var(--color-surface-2);
  }
  .note-markdown :global(.callout-title) {
    font-weight: 700;
    margin-bottom: 0.2em;
  }
  .note-markdown :global(.callout-body) {
    color: var(--color-text-secondary);
    font-size: 0.95em;
  }
  .note-markdown :global(.callout-warning),
  .note-markdown :global(.callout-caution) {
    border-left-color: var(--color-warning);
  }
  .note-markdown :global(.callout-danger),
  .note-markdown :global(.callout-error),
  .note-markdown :global(.callout-bug) {
    border-left-color: var(--color-error);
  }
  .note-markdown :global(.callout-tip),
  .note-markdown :global(.callout-success),
  .note-markdown :global(.callout-info),
  .note-markdown :global(.callout-note) {
    border-left-color: var(--color-accent);
  }
</style>
