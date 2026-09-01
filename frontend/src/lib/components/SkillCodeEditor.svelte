<script lang="ts">
  import { html } from '@codemirror/lang-html';
  import { markdown } from '@codemirror/lang-markdown';
  import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
  import { Compartment, EditorState } from '@codemirror/state';
  import { tags } from '@lezer/highlight';
  import { basicSetup, EditorView } from 'codemirror';
  import { onMount } from 'svelte';

  export type SkillSourceLanguage = 'markdown' | 'text' | 'plain' | 'html' | 'custom';
  export type SkillSourceRenderer = 'markdown' | 'plain' | 'html';

  interface Props {
    value?: string;
    language?: SkillSourceLanguage;
    renderer?: SkillSourceRenderer;
    onchange?: (value: string) => void;
    ariaLabel?: string;
    'aria-label'?: string;
    readonly?: boolean;
  }

  let {
    value = '',
    language = 'markdown',
    renderer,
    onchange,
    ariaLabel = 'Skill source editor',
    'aria-label': ariaLabelAttribute,
    readonly = false,
  }: Props = $props();

  let host: HTMLDivElement;
  let view: EditorView | undefined;
  let applyingExternalValue = false;

  const languageConfiguration = new Compartment();
  const editableConfiguration = new Compartment();
  const accessibilityConfiguration = new Compartment();

  const koryHighlightStyle = HighlightStyle.define([
    {
      tag: [
        tags.heading1,
        tags.heading2,
        tags.heading3,
        tags.heading4,
        tags.heading5,
        tags.heading6,
      ],
      color: 'var(--color-accent)',
      fontWeight: '700',
    },
    {
      tag: [tags.keyword, tags.controlKeyword, tags.definitionKeyword, tags.tagName],
      color: 'var(--color-accent)',
    },
    {
      tag: [tags.attributeName, tags.propertyName, tags.labelName],
      color: 'var(--color-info)',
    },
    {
      tag: [tags.string, tags.attributeValue, tags.inserted],
      color: 'var(--color-success)',
    },
    {
      tag: [tags.number, tags.bool, tags.null, tags.atom],
      color: 'var(--color-warning)',
    },
    {
      tag: [tags.comment, tags.meta, tags.processingInstruction],
      color: 'var(--color-text-muted)',
      fontStyle: 'italic',
    },
    {
      tag: [tags.link, tags.url],
      color: 'var(--color-info)',
      textDecoration: 'underline',
    },
    {
      tag: [tags.emphasis],
      fontStyle: 'italic',
    },
    {
      tag: [tags.strong],
      fontWeight: '700',
    },
    {
      tag: [tags.monospace],
      color: 'var(--color-text-secondary)',
    },
    {
      tag: [tags.invalid, tags.deleted],
      color: 'var(--color-error)',
    },
  ]);

  const koryEditorTheme = EditorView.theme({
    '&': {
      height: '100%',
      minHeight: 'inherit',
      color: 'var(--color-text-primary)',
      backgroundColor: 'var(--color-surface-1)',
      fontSize: '14px',
    },
    '&.cm-focused': {
      outline: '2px solid var(--color-accent)',
      outlineOffset: '-2px',
    },
    '.cm-scroller': {
      overflow: 'auto',
      fontFamily: 'var(--font-mono)',
      lineHeight: '1.6',
    },
    '.cm-content': {
      minHeight: '100%',
      padding: '12px 0',
      caretColor: 'var(--color-accent)',
    },
    '.cm-line': {
      padding: '0 14px',
    },
    '.cm-cursor, .cm-dropCursor': {
      borderLeftColor: 'var(--color-accent)',
    },
    '.cm-gutters': {
      color: 'var(--color-text-muted)',
      backgroundColor: 'var(--color-surface-2)',
      borderRight: '1px solid var(--color-border)',
    },
    '.cm-gutterElement': {
      padding: '0 8px 0 10px',
    },
    '.cm-activeLine, .cm-activeLineGutter': {
      backgroundColor: 'var(--color-surface-2)',
    },
    '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection': {
      backgroundColor: 'var(--color-accent-transparent)',
    },
    '.cm-matchingBracket': {
      color: 'var(--color-text-primary)',
      backgroundColor: 'var(--color-accent-transparent)',
      outline: '1px solid var(--color-border-bright)',
    },
    '.cm-panels': {
      color: 'var(--color-text-primary)',
      backgroundColor: 'var(--color-surface-2)',
    },
    '.cm-panels.cm-panels-top': {
      borderBottom: '1px solid var(--color-border)',
    },
    '.cm-panels.cm-panels-bottom': {
      borderTop: '1px solid var(--color-border)',
    },
    '.cm-searchMatch': {
      backgroundColor: 'var(--color-warning-bg)',
      outline: '1px solid var(--color-warning)',
    },
    '.cm-searchMatch.cm-searchMatch-selected': {
      backgroundColor: 'var(--color-accent-transparent)',
    },
    '.cm-tooltip': {
      color: 'var(--color-text-primary)',
      backgroundColor: 'var(--color-surface-2)',
      border: '1px solid var(--color-border-bright)',
    },
    '.cm-button, .cm-textfield': {
      minHeight: '32px',
      color: 'var(--color-text-primary)',
      background: 'var(--color-surface-1)',
      border: '1px solid var(--color-border-bright)',
      borderRadius: '6px',
    },
    '.cm-button': {
      padding: '4px 10px',
      backgroundImage: 'none',
    },
  });

  function languageExtension(
    sourceLanguage: SkillSourceLanguage,
    sourceRenderer?: SkillSourceRenderer,
  ) {
    if (sourceLanguage === 'markdown') return markdown();
    if (sourceLanguage === 'html') return html();
    if (sourceLanguage === 'custom' && sourceRenderer === 'markdown') return markdown();
    if (sourceLanguage === 'custom' && sourceRenderer === 'html') return html();
    return [];
  }

  function editableExtensions(isReadonly: boolean) {
    return [EditorState.readOnly.of(isReadonly), EditorView.editable.of(!isReadonly)];
  }

  function accessibilityExtensions(label: string, isReadonly: boolean) {
    return EditorView.contentAttributes.of({
      'aria-label': label,
      'aria-multiline': 'true',
      'aria-readonly': String(isReadonly),
      role: 'textbox',
      spellcheck: 'false',
    });
  }

  onMount(() => {
    view = new EditorView({
      parent: host,
      doc: value,
      extensions: [
        basicSetup,
        languageConfiguration.of(languageExtension(language, renderer)),
        editableConfiguration.of(editableExtensions(readonly)),
        accessibilityConfiguration.of(
          accessibilityExtensions(ariaLabelAttribute ?? ariaLabel, readonly),
        ),
        koryEditorTheme,
        syntaxHighlighting(koryHighlightStyle),
        EditorView.lineWrapping,
        EditorView.updateListener.of((update) => {
          if (!update.docChanged || applyingExternalValue) return;
          onchange?.(update.state.doc.toString());
        }),
      ],
    });

    return () => {
      view?.destroy();
      view = undefined;
    };
  });

  $effect(() => {
    const nextValue = value;
    if (!view || nextValue === view.state.doc.toString()) return;

    applyingExternalValue = true;
    try {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: nextValue },
      });
    } finally {
      applyingExternalValue = false;
    }
  });

  $effect(() => {
    const nextLanguage = language;
    const nextRenderer = renderer;
    if (!view) return;
    view.dispatch({
      effects: languageConfiguration.reconfigure(languageExtension(nextLanguage, nextRenderer)),
    });
  });

  $effect(() => {
    const nextReadonly = readonly;
    if (!view) return;
    view.dispatch({
      effects: editableConfiguration.reconfigure(editableExtensions(nextReadonly)),
    });
  });

  $effect(() => {
    const nextLabel = ariaLabelAttribute ?? ariaLabel;
    const nextReadonly = readonly;
    if (!view) return;
    view.dispatch({
      effects: accessibilityConfiguration.reconfigure(
        accessibilityExtensions(nextLabel, nextReadonly),
      ),
    });
  });
</script>

<div
  class="skill-code-editor"
  class:skill-code-editor--readonly={readonly}
  data-language={language}
  data-renderer={renderer ?? 'plain'}
  bind:this={host}
></div>

<style>
  .skill-code-editor {
    height: 100%;
    min-height: 18rem;
    overflow: hidden;
    border: 1px solid var(--color-border);
    border-radius: 10px;
    background: var(--color-surface-1);
  }

  .skill-code-editor:hover {
    border-color: var(--color-border-bright);
  }

  .skill-code-editor--readonly {
    background: var(--color-surface-2);
  }
</style>
