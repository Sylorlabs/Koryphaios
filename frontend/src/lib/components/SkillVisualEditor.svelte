<script module lang="ts">
  let nextVisualEditorId = 0;
</script>

<script lang="ts">
  import { onMount } from 'svelte';
  import { baseKeymap, setBlockType, toggleMark, wrapIn } from 'prosemirror-commands';
  import { history, redo, undo } from 'prosemirror-history';
  import { keymap } from 'prosemirror-keymap';
  import {
    DOMParser as ProseMirrorDOMParser,
    DOMSerializer,
    Fragment,
    Schema,
    type Node as ProseMirrorNode,
    type NodeSpec,
  } from 'prosemirror-model';
  import {
    defaultMarkdownParser,
    defaultMarkdownSerializer,
    MarkdownParser,
    schema as markdownSchema,
  } from 'prosemirror-markdown';
  import { wrapInList } from 'prosemirror-schema-list';
  import { EditorState, Plugin, type Command } from 'prosemirror-state';
  import { EditorView } from 'prosemirror-view';
  import AlertTriangle from 'lucide-svelte/icons/triangle-alert';
  import Code2 from 'lucide-svelte/icons/code-2';
  import Redo2 from 'lucide-svelte/icons/redo-2';
  import Undo2 from 'lucide-svelte/icons/undo-2';
  import {
    analyzeHtmlVisualSafety,
    analyzeMarkdownVisualSafety,
    visualModeFor,
    type SkillVisualFormat,
    type SkillVisualRenderer,
    type VisualSourceSafety,
  } from './skill-visual-safety';
  import {
    segmentHtmlVisualSource,
    segmentMarkdownVisualSource,
    type VisualSourceSegment,
  } from './skill-visual-segments';

  const lockedRawNodeSpec: NodeSpec = {
    attrs: {
      id: { default: '' },
      source: { default: '' },
      reason: { default: 'This block requires exact source editing.' },
    },
    group: 'block',
    atom: true,
    isolating: true,
    selectable: true,
    draggable: false,
    toDOM: (node) => [
      'pre',
      { class: 'skill-visual-raw-fallback', contenteditable: 'false' },
      String(node.attrs.source),
    ],
  };

  const visualSchema = new Schema({
    nodes: markdownSchema.spec.nodes.addBefore('text', 'locked_raw', lockedRawNodeSpec),
    marks: markdownSchema.spec.marks,
  });
  const visualMarkdownParser = new MarkdownParser(
    visualSchema,
    defaultMarkdownParser.tokenizer,
    defaultMarkdownParser.tokens,
  );

  interface Props {
    value: string;
    format?: SkillVisualFormat;
    renderer?: SkillVisualRenderer;
    onchange?: (source: string) => void;
    onrequestsource?: () => void;
    onstatus?: (message: string) => void;
    disabled?: boolean;
    label?: string;
  }

  let {
    value,
    format = 'markdown',
    renderer = 'markdown',
    onchange,
    onrequestsource,
    onstatus,
    disabled = false,
    label = 'Visual skill editor',
  }: Props = $props();

  const editorId = `skill-visual-editor-${++nextVisualEditorId}`;
  let mountElement = $state<HTMLDivElement>();
  let mounted = $state(false);
  let lossRisk = $state<VisualSourceSafety | null>(null);
  let lockedBlockCount = $state(0);
  let editorVersion = $state(0);
  let liveStatus = $state('');
  let editorView: EditorView | undefined;
  let currentSource = '';
  let currentConfiguration = '';
  let activeMode = $state<SkillVisualRenderer>('markdown');

  function announce(message: string) {
    liveStatus = message;
    onstatus?.(message);
  }

  function imagePlaceholder(node: ProseMirrorNode) {
    const dom = document.createElement('span');
    dom.className = 'skill-visual-image-placeholder';
    dom.setAttribute('contenteditable', 'false');
    dom.setAttribute('role', 'img');

    const update = (nextNode: ProseMirrorNode) => {
      if (nextNode.type.name !== 'image') return false;
      const alt = String(nextNode.attrs.alt || 'Image');
      dom.setAttribute('aria-label', alt);
      dom.textContent = `Image: ${alt}`;
      return true;
    };

    update(node);
    return { dom, update };
  }

  function lockedRawBlock(node: ProseMirrorNode) {
    const ownerDocument = mountElement!.ownerDocument;
    const dom = ownerDocument.createElement('section');
    const title = ownerDocument.createElement('div');
    const reason = ownerDocument.createElement('p');
    const source = ownerDocument.createElement('pre');
    const action = onrequestsource ? ownerDocument.createElement('button') : null;

    dom.className = 'skill-visual-raw-block';
    dom.setAttribute('contenteditable', 'false');
    dom.setAttribute('role', 'note');
    dom.setAttribute('aria-label', 'Locked raw source');
    title.className = 'skill-visual-raw-title';
    title.textContent = 'Raw source protected';
    reason.className = 'skill-visual-raw-reason';
    source.className = 'skill-visual-raw-source';
    source.dataset.testid = 'locked-raw-source';
    if (action) {
      action.type = 'button';
      action.className = 'skill-visual-raw-action';
      action.textContent = 'Open Source mode';
      action.addEventListener('click', onrequestsource!);
    }

    dom.append(title, reason, source);
    if (action) dom.append(action);

    const update = (nextNode: ProseMirrorNode) => {
      if (nextNode.type.name !== 'locked_raw') return false;
      reason.textContent = String(nextNode.attrs.reason);
      source.textContent = String(nextNode.attrs.source);
      return true;
    };
    update(node);

    return {
      dom,
      update,
      ignoreMutation: () => true,
      stopEvent: (event: Event) =>
        !!action && (event.target === action || action.contains(event.target as Node)),
      destroy: () => {
        if (action) action.removeEventListener('click', onrequestsource!);
      },
    };
  }

  function parseSupportedDocument(source: string, mode: SkillVisualRenderer): ProseMirrorNode {
    if (mode === 'markdown') return visualMarkdownParser.parse(source);

    if (mode === 'html') {
      const template = mountElement!.ownerDocument.createElement('template');
      template.innerHTML = source;
      return ProseMirrorDOMParser.fromSchema(visualSchema).parse(template.content);
    }

    const codeBlock = visualSchema.nodes.code_block.create(
      null,
      source ? visualSchema.text(source) : null,
    );
    return visualSchema.nodes.doc.create(null, codeBlock);
  }

  function serializeSupportedDocument(doc: ProseMirrorNode, mode: SkillVisualRenderer): string {
    if (mode === 'markdown') return defaultMarkdownSerializer.serialize(doc);
    if (mode === 'plain') return doc.textBetween(0, doc.content.size, '\n\n', '\n');

    const ownerDocument = mountElement!.ownerDocument;
    const container = ownerDocument.createElement('div');
    container.appendChild(
      DOMSerializer.fromSchema(visualSchema).serializeFragment(doc.content, {
        document: ownerDocument,
      }),
    );
    return container.innerHTML;
  }

  function serializeDocument(doc: ProseMirrorNode, mode: SkillVisualRenderer): string {
    const output: string[] = [];
    let editableNodes: ProseMirrorNode[] = [];
    const flushEditable = () => {
      if (editableNodes.length === 0) return;
      const editableDoc = visualSchema.nodes.doc.create(null, Fragment.fromArray(editableNodes));
      output.push(serializeSupportedDocument(editableDoc, mode));
      editableNodes = [];
    };

    doc.forEach((node) => {
      if (node.type.name === 'locked_raw') {
        flushEditable();
        output.push(String(node.attrs.source));
      } else {
        editableNodes.push(node);
      }
    });
    flushEditable();
    return output.join('');
  }

  function analyzeSource(source: string, mode: SkillVisualRenderer): VisualSourceSafety {
    if (mode === 'markdown') {
      const safety = analyzeMarkdownVisualSafety(source);
      if (!safety.editable) return safety;
      try {
        const parsed = visualMarkdownParser.parse(source);
        const reparsed = visualMarkdownParser.parse(defaultMarkdownSerializer.serialize(parsed));
        if (!parsed.eq(reparsed)) {
          return {
            editable: false,
            reason: 'This Markdown cannot round-trip through the Visual editor schema.',
          };
        }
      } catch {
        return { editable: false, reason: 'This Markdown could not be parsed without loss.' };
      }
      return { editable: true };
    }
    if (mode === 'html') {
      return analyzeHtmlVisualSafety(source, mountElement!.ownerDocument);
    }
    if (source.includes('\0')) {
      return { editable: false, reason: 'The document contains a NUL byte.' };
    }
    return { editable: true };
  }

  function segmentSource(source: string, mode: SkillVisualRenderer): VisualSourceSegment[] {
    if (mode === 'markdown') return segmentMarkdownVisualSource(source);
    if (mode === 'html') return segmentHtmlVisualSource(source, mountElement!.ownerDocument);
    const safety = analyzeSource(source, mode);
    return [
      safety.editable
        ? { kind: 'editable', source, start: 0, end: source.length }
        : {
            kind: 'locked',
            source,
            start: 0,
            end: source.length,
            reason: safety.reason,
          },
    ];
  }

  function parseVisualDocument(
    source: string,
    mode: SkillVisualRenderer,
  ): { doc: ProseMirrorNode; locked: number } {
    const segments = segmentSource(source, mode);
    const children: ProseMirrorNode[] = [];
    let locked = 0;

    for (const segment of segments) {
      const safety =
        segment.kind === 'editable' ? analyzeSource(segment.source, mode) : { editable: false };
      if (segment.kind === 'locked' || !safety.editable) {
        const reason =
          segment.reason ??
          safety.reason ??
          'This block cannot round-trip through the Visual editor schema.';
        children.push(
          visualSchema.nodes.locked_raw.create({
            id: `raw-${segment.start}-${segment.end}-${locked}`,
            source: segment.source,
            reason,
          }),
        );
        locked += 1;
        continue;
      }

      const parsed = parseSupportedDocument(segment.source, mode);
      parsed.forEach((child) => children.push(child));
    }

    if (children.length === 0) children.push(visualSchema.nodes.paragraph.create());
    return { doc: visualSchema.nodes.doc.create(null, Fragment.fromArray(children)), locked };
  }

  function classifiedLockedSources(source: string, mode: SkillVisualRenderer): string[] {
    return segmentSource(source, mode).flatMap((segment) => {
      if (segment.kind === 'locked') return [segment.source];
      return analyzeSource(segment.source, mode).editable ? [] : [segment.source];
    });
  }

  function createState(doc: ProseMirrorNode, mode: SkillVisualRenderer) {
    const shortcutCommands: Record<string, Command> = {
      'Mod-z': undo,
      'Shift-Mod-z': redo,
      'Mod-y': redo,
    };
    if (mode !== 'plain') {
      shortcutCommands['Mod-b'] = toggleMark(visualSchema.marks.strong);
      shortcutCommands['Mod-i'] = toggleMark(visualSchema.marks.em);
      shortcutCommands['Shift-Ctrl-0'] = setBlockType(visualSchema.nodes.paragraph);
      shortcutCommands['Shift-Ctrl-2'] = setBlockType(visualSchema.nodes.heading, { level: 2 });
    }

    const preserveLockedRaw = new Plugin({
      filterTransaction(transaction, state) {
        if (!transaction.docChanged) return true;
        const before: string[] = [];
        const after: string[] = [];
        state.doc.descendants((node) => {
          if (node.type.name === 'locked_raw') {
            before.push(`${String(node.attrs.id)}\0${String(node.attrs.source)}`);
          }
        });
        transaction.doc.descendants((node) => {
          if (node.type.name === 'locked_raw') {
            after.push(`${String(node.attrs.id)}\0${String(node.attrs.source)}`);
          }
        });
        const preserved =
          before.length === after.length &&
          before.every((signature, index) => signature === after[index]);
        if (!preserved) {
          announce('Locked raw-source blocks can only be changed in Source mode.');
          return false;
        }

        try {
          const expectedRaw = before.map((signature) =>
            signature.slice(signature.indexOf('\0') + 1),
          );
          const nextRaw = classifiedLockedSources(serializeDocument(transaction.doc, mode), mode);
          const classificationPreserved =
            expectedRaw.length === nextRaw.length &&
            expectedRaw.every((source, index) => source === nextRaw[index]);
          if (!classificationPreserved) {
            announce(
              'That change would cross a protected source boundary. Use Source mode for this edit.',
            );
          }
          return classificationPreserved;
        } catch {
          announce('The source safety check could not prove this Visual edit lossless.');
          return false;
        }
      },
    });

    return EditorState.create({
      doc,
      plugins: [preserveLockedRaw, history(), keymap(shortcutCommands), keymap(baseKeymap)],
    });
  }

  function editorAttributes() {
    return {
      id: `${editorId}-document`,
      class: 'skill-prosemirror-document',
      role: 'textbox',
      'aria-label': label,
      'aria-multiline': 'true',
      'aria-describedby': `${editorId}-help`,
      'aria-disabled': String(disabled),
    };
  }

  function buildEditor(source: string, configuration: string) {
    if (!mountElement) return;
    const mode = visualModeFor(format, renderer);
    activeMode = mode;
    currentSource = source;
    currentConfiguration = configuration;
    let parsed: { doc: ProseMirrorNode; locked: number };
    try {
      parsed = parseVisualDocument(source, mode);
    } catch {
      editorView?.destroy();
      editorView = undefined;
      mountElement.replaceChildren();
      lossRisk = { editable: false, reason: 'This document could not be parsed without loss.' };
      lockedBlockCount = 0;
      announce('Visual editing is locked because the document could not be parsed safely.');
      return;
    }

    lossRisk = null;
    lockedBlockCount = parsed.locked;
    const state = createState(parsed.doc, mode);
    if (editorView) {
      editorView.setProps({
        editable: () => !disabled,
        attributes: editorAttributes(),
      });
      editorView.updateState(state);
      editorVersion += 1;
      if (parsed.locked > 0) {
        announce(
          `${parsed.locked} raw-source ${parsed.locked === 1 ? 'block is' : 'blocks are'} locked; supported content remains editable.`,
        );
      }
      return;
    }

    editorView = new EditorView(mountElement, {
      state,
      editable: () => !disabled,
      attributes: editorAttributes(),
      nodeViews: { image: imagePlaceholder, locked_raw: lockedRawBlock },
      handlePaste: (view, event) => {
        const clipboard = event.clipboardData;
        if (activeMode === 'plain') {
          event.preventDefault();
          const text = clipboard?.getData('text/plain') ?? '';
          if (text) {
            const { from, to } = view.state.selection;
            view.dispatch(view.state.tr.insertText(text, from, to));
          }
          return true;
        }
        const html = clipboard?.getData('text/html') ?? '';
        if (!html) return false;
        const safety = analyzeHtmlVisualSafety(html, mountElement!.ownerDocument);
        if (safety.editable) return false;
        event.preventDefault();
        announce(
          `Rich paste was not inserted because ${safety.reason ?? 'it contains unsupported markup'} Use Source mode to preserve it exactly.`,
        );
        return true;
      },
      handleDrop: (_view, event, _slice, moved) => {
        if (activeMode !== 'plain' || moved) return false;
        event.preventDefault();
        announce('Dropped rich content was not inserted. Paste plain text to keep exact contents.');
        return true;
      },
      handleDOMEvents: {
        click: (_view, event) => {
          const target = event.target;
          if (target instanceof Element && target.closest('a')) {
            event.preventDefault();
            return true;
          }
          return false;
        },
      },
      dispatchTransaction(transaction) {
        if (!editorView) return;
        const nextState = editorView.state.apply(transaction);
        editorView.updateState(nextState);
        editorVersion += 1;
        if (!transaction.docChanged) return;
        const nextSource = serializeDocument(nextState.doc, activeMode);
        currentSource = nextSource;
        onchange?.(nextSource);
        announce('Visual changes synchronized to the skill source.');
      },
    });
    editorVersion += 1;
    if (parsed.locked > 0) {
      announce(
        `${parsed.locked} raw-source ${parsed.locked === 1 ? 'block is' : 'blocks are'} locked; supported content remains editable.`,
      );
    }
  }

  function run(command: Command) {
    if (!editorView || disabled) return;
    if (command(editorView.state, editorView.dispatch, editorView)) {
      editorView.focus();
      editorVersion += 1;
    }
  }

  function canRun(command: Command): boolean {
    void editorVersion;
    return !!editorView && !disabled && command(editorView.state);
  }

  function markActive(name: 'strong' | 'em'): boolean {
    void editorVersion;
    if (!editorView || activeMode === 'plain') return false;
    const mark = visualSchema.marks[name];
    const selection = editorView.state.selection;
    const { from, to, empty } = selection;
    if (empty) return !!mark.isInSet(editorView.state.storedMarks ?? selection.$from.marks());
    return editorView.state.doc.rangeHasMark(from, to, mark);
  }

  function blockActive(name: string, attrs?: Record<string, unknown>): boolean {
    void editorVersion;
    if (!editorView) return false;
    const selection = editorView.state.selection;
    const { to } = selection;
    let active = false;
    editorView.state.doc.nodesBetween(selection.$from.pos, to, (node) => {
      if (node.type.name !== name) return;
      if (attrs && Object.entries(attrs).some(([key, next]) => node.attrs[key] !== next)) return;
      active = true;
    });
    return active;
  }

  const bold = toggleMark(visualSchema.marks.strong);
  const italic = toggleMark(visualSchema.marks.em);
  const paragraph = setBlockType(visualSchema.nodes.paragraph);
  const heading = setBlockType(visualSchema.nodes.heading, { level: 2 });
  const bulletList = wrapInList(visualSchema.nodes.bullet_list);
  const orderedList = wrapInList(visualSchema.nodes.ordered_list);
  const quote = wrapIn(visualSchema.nodes.blockquote);
  const codeBlock = setBlockType(visualSchema.nodes.code_block);

  onMount(() => {
    mounted = true;
    return () => {
      mounted = false;
      editorView?.destroy();
      editorView = undefined;
    };
  });

  $effect(() => {
    const nextValue = value;
    const configuration = `${format}:${renderer}:${disabled}:${label}`;
    if (!mounted || !mountElement) return;
    if (currentSource === nextValue && currentConfiguration === configuration) return;
    buildEditor(nextValue, configuration);
  });
</script>

<div class="skill-visual-editor" data-renderer={visualModeFor(format, renderer)}>
  {#if !lossRisk}
    <div class="format-toolbar" role="toolbar" aria-label="Visual formatting">
      {#if activeMode !== 'plain'}
        <button
          type="button"
          class:active={markActive('strong')}
          aria-pressed={markActive('strong')}
          title="Bold (Ctrl or Command + B)"
          onclick={() => run(bold)}>Bold</button
        >
        <button
          type="button"
          class:active={markActive('em')}
          aria-pressed={markActive('em')}
          title="Italic (Ctrl or Command + I)"
          onclick={() => run(italic)}>Italic</button
        >
        <span class="toolbar-separator" aria-hidden="true"></span>
        <button
          type="button"
          class:active={blockActive('paragraph')}
          aria-pressed={blockActive('paragraph')}
          onclick={() => run(paragraph)}>Text</button
        >
        <button
          type="button"
          class:active={blockActive('heading', { level: 2 })}
          aria-pressed={blockActive('heading', { level: 2 })}
          onclick={() => run(heading)}>Heading</button
        >
        <button
          type="button"
          class:active={blockActive('bullet_list')}
          aria-pressed={blockActive('bullet_list')}
          onclick={() => run(bulletList)}>Bullets</button
        >
        <button
          type="button"
          class:active={blockActive('ordered_list')}
          aria-pressed={blockActive('ordered_list')}
          onclick={() => run(orderedList)}>Numbered</button
        >
        <button
          type="button"
          class:active={blockActive('blockquote')}
          aria-pressed={blockActive('blockquote')}
          onclick={() => run(quote)}>Quote</button
        >
        <button
          type="button"
          class:active={blockActive('code_block')}
          aria-pressed={blockActive('code_block')}
          onclick={() => run(codeBlock)}><Code2 size={15} />Code</button
        >
        <span class="toolbar-separator" aria-hidden="true"></span>
      {/if}
      <button
        type="button"
        disabled={!canRun(undo)}
        aria-label="Undo visual edit"
        onclick={() => run(undo)}><Undo2 size={16} />Undo</button
      >
      <button
        type="button"
        disabled={!canRun(redo)}
        aria-label="Redo visual edit"
        onclick={() => run(redo)}><Redo2 size={16} />Redo</button
      >
    </div>
  {/if}

  <div
    bind:this={mountElement}
    class="editor-mount"
    class:locked={!!lossRisk}
    aria-hidden={lossRisk ? 'true' : undefined}
  ></div>

  {#if lossRisk}
    <section class="locked-source" role="note" aria-labelledby={`${editorId}-locked-title`}>
      <div class="locked-title-row">
        <span class="warning-icon" aria-hidden="true"><AlertTriangle size={19} /></span>
        <div>
          <h3 id={`${editorId}-locked-title`}>Raw source protected</h3>
          <p>{lossRisk.reason} Its original bytes remain unchanged.</p>
        </div>
      </div>
      <pre data-testid="locked-raw-source">{value || 'Empty document'}</pre>
      <div class="locked-actions">
        <p>Edit this construct in Source mode, then return here when it is representable.</p>
        {#if onrequestsource}
          <button type="button" class="source-action" onclick={() => onrequestsource?.()}
            ><Code2 size={16} />Open Source mode</button
          >
        {/if}
      </div>
    </section>
  {/if}

  <p id={`${editorId}-help`} class="editor-help">
    {#if lockedBlockCount > 0}
      {lockedBlockCount} raw-source {lockedBlockCount === 1 ? 'block is' : 'blocks are'} protected. Edit
      the surrounding supported content here, or open Source mode to change a protected block.
    {:else if activeMode === 'html'}
      Supported HTML is edited structurally; Source mode keeps byte-exact formatting. Links and
      images never navigate or load in this editor.
    {:else if activeMode === 'plain'}
      Plain text keeps whitespace and line breaks exactly as written.
    {:else}
      CommonMark changes synchronize to source. Advanced extensions stay locked until edited in
      Source mode.
    {/if}
  </p>
  <span class="sr-status" aria-live="polite">{liveStatus}</span>
</div>

<style>
  .skill-visual-editor {
    min-width: 0;
    overflow: hidden;
    border: 1px solid var(--color-border);
    border-radius: 14px;
    background: var(--color-surface-1);
    color: var(--color-text-primary);
  }

  .format-toolbar {
    display: flex;
    min-height: 48px;
    align-items: center;
    gap: 6px;
    overflow-x: auto;
    border-bottom: 1px solid var(--color-border);
    background: var(--color-surface-2);
    padding: 6px;
  }

  .format-toolbar button,
  .source-action {
    display: inline-flex;
    min-height: 40px;
    flex: 0 0 auto;
    align-items: center;
    justify-content: center;
    gap: 6px;
    border: 1px solid var(--color-border);
    border-radius: 9px;
    background: var(--color-surface-1);
    padding: 8px 11px;
    color: var(--color-text-secondary);
    font: inherit;
    font-size: 13px;
    font-weight: 650;
    cursor: pointer;
  }

  .format-toolbar button:hover:not(:disabled),
  .source-action:hover {
    border-color: var(--color-border-bright);
    background: var(--color-surface-3);
    color: var(--color-text-primary);
  }

  .format-toolbar button:focus-visible,
  .source-action:focus-visible,
  :global(.skill-prosemirror-document:focus-visible) {
    outline: 2px solid var(--color-accent);
    outline-offset: 2px;
  }

  .format-toolbar button.active {
    border-color: var(--color-accent);
    background: var(--color-accent-transparent);
    color: var(--color-text-primary);
  }

  .format-toolbar button:disabled {
    cursor: not-allowed;
    border-color: var(--color-border);
    background: var(--color-surface-2);
    color: var(--color-text-muted);
  }

  .toolbar-separator {
    width: 1px;
    height: 26px;
    flex: 0 0 auto;
    background: var(--color-border-bright);
  }

  .editor-mount {
    min-height: 280px;
  }

  .editor-mount.locked {
    display: none;
  }

  :global(.skill-prosemirror-document) {
    min-height: 280px;
    padding: 24px;
    color: var(--color-text-primary);
    font-size: 14px;
    line-height: 1.65;
    outline: none;
    white-space: normal;
  }

  :global(.skill-prosemirror-document > :first-child) {
    margin-top: 0;
  }

  :global(.skill-prosemirror-document > :last-child) {
    margin-bottom: 0;
  }

  :global(.skill-prosemirror-document h1),
  :global(.skill-prosemirror-document h2),
  :global(.skill-prosemirror-document h3),
  :global(.skill-prosemirror-document h4),
  :global(.skill-prosemirror-document h5),
  :global(.skill-prosemirror-document h6) {
    margin: 1.25em 0 0.55em;
    color: var(--color-text-primary);
    line-height: 1.25;
  }

  :global(.skill-prosemirror-document p),
  :global(.skill-prosemirror-document blockquote),
  :global(.skill-prosemirror-document pre),
  :global(.skill-prosemirror-document ul),
  :global(.skill-prosemirror-document ol) {
    margin: 0.75em 0;
  }

  :global(.skill-prosemirror-document ul),
  :global(.skill-prosemirror-document ol) {
    padding-left: 1.6rem;
  }

  :global(.skill-prosemirror-document blockquote) {
    border-left: 3px solid var(--color-accent);
    padding-left: 14px;
    color: var(--color-text-secondary);
  }

  :global(.skill-prosemirror-document code) {
    border-radius: 5px;
    background: var(--color-surface-3);
    padding: 0.12em 0.35em;
    font-family: var(--font-mono, ui-monospace, monospace);
  }

  :global(.skill-prosemirror-document pre) {
    overflow-x: auto;
    border: 1px solid var(--color-border);
    border-radius: 10px;
    background: var(--color-surface-0);
    padding: 14px;
    font-family: var(--font-mono, ui-monospace, monospace);
    white-space: pre-wrap;
  }

  :global(.skill-prosemirror-document a) {
    color: var(--color-accent);
    pointer-events: none;
    text-decoration: underline;
  }

  :global(.skill-prosemirror-document .skill-visual-image-placeholder) {
    display: inline-flex;
    min-height: 32px;
    align-items: center;
    border: 1px dashed var(--color-border-bright);
    border-radius: 8px;
    background: var(--color-surface-2);
    padding: 4px 9px;
    color: var(--color-text-secondary);
    font-size: 13px;
  }

  :global(.skill-prosemirror-document .ProseMirror-selectednode) {
    outline: 2px solid var(--color-accent);
    outline-offset: 2px;
  }

  :global(.skill-prosemirror-document .skill-visual-raw-block) {
    margin: 16px 0;
    overflow: hidden;
    border: 1px solid var(--color-warning);
    border-radius: 12px;
    background: var(--color-warning-bg);
  }

  :global(.skill-prosemirror-document .skill-visual-raw-title) {
    padding: 12px 14px 0;
    color: var(--color-text-primary);
    font-size: 14px;
    font-weight: 700;
  }

  :global(.skill-prosemirror-document .skill-visual-raw-reason) {
    margin: 0;
    padding: 4px 14px 12px;
    color: var(--color-text-secondary);
    font-size: 13px;
    line-height: 1.5;
  }

  :global(.skill-prosemirror-document .skill-visual-raw-source) {
    max-height: 240px;
    margin: 0;
    overflow: auto;
    border-block: 1px solid var(--color-border);
    border-radius: 0;
    background: var(--color-surface-0);
    padding: 14px;
    color: var(--color-text-primary);
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 13px;
    line-height: 1.55;
    white-space: pre-wrap;
    word-break: break-word;
  }

  :global(.skill-prosemirror-document .skill-visual-raw-action) {
    min-height: 40px;
    margin: 10px 14px 12px;
    border: 1px solid var(--color-border-bright);
    border-radius: 9px;
    background: var(--color-surface-1);
    padding: 8px 11px;
    color: var(--color-text-primary);
    font: inherit;
    font-size: 13px;
    font-weight: 650;
    cursor: pointer;
  }

  :global(.skill-prosemirror-document .skill-visual-raw-action:hover) {
    border-color: var(--color-accent);
    background: var(--color-surface-3);
  }

  :global(.skill-prosemirror-document .skill-visual-raw-action:focus-visible) {
    outline: 2px solid var(--color-accent);
    outline-offset: 2px;
  }

  .locked-source {
    margin: 14px;
    overflow: hidden;
    border: 1px solid var(--color-warning);
    border-radius: 12px;
    background: var(--color-warning-bg);
  }

  .locked-title-row {
    display: flex;
    align-items: flex-start;
    gap: 11px;
    padding: 16px;
  }

  .warning-icon {
    display: inline-flex;
    width: 34px;
    height: 34px;
    flex: 0 0 auto;
    align-items: center;
    justify-content: center;
    border-radius: 9px;
    background: var(--color-surface-1);
    color: var(--color-warning);
  }

  .locked-title-row h3 {
    margin: 0;
    color: var(--color-text-primary);
    font-size: 15px;
  }

  .locked-title-row p,
  .locked-actions p,
  .editor-help {
    margin: 4px 0 0;
    color: var(--color-text-secondary);
    font-size: 13px;
    line-height: 1.5;
  }

  .locked-source pre {
    max-height: 260px;
    margin: 0;
    overflow: auto;
    border-block: 1px solid var(--color-border);
    background: var(--color-surface-0);
    padding: 16px;
    color: var(--color-text-primary);
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 13px;
    line-height: 1.55;
    white-space: pre-wrap;
    word-break: break-word;
  }

  .locked-actions {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 14px;
    padding: 12px 16px;
  }

  .locked-actions p {
    margin: 0;
  }

  .source-action {
    border-color: var(--color-border-bright);
    color: var(--color-text-primary);
  }

  .editor-help {
    min-height: 44px;
    margin: 0;
    border-top: 1px solid var(--color-border);
    padding: 11px 14px;
    background: var(--color-surface-2);
  }

  .sr-status {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    clip-path: inset(50%);
    white-space: nowrap;
  }

  @media (max-width: 720px) {
    .locked-actions {
      align-items: stretch;
      flex-direction: column;
    }

    .source-action {
      width: 100%;
    }

    :global(.skill-prosemirror-document) {
      padding: 18px;
    }
  }
</style>
