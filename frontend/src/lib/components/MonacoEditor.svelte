<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import * as monaco from 'monaco-editor';

  export let value: string = '';
  export let language: string = 'typescript';
  export let theme: string = 'vs-dark';
  export let readOnly: boolean = false;

  let editorContainer: HTMLElement;
  let editor: monaco.editor.IStandaloneCodeEditor;

  onMount(() => {
    editor = monaco.editor.create(editorContainer, {
      value,
      language,
      theme,
      readOnly,
      automaticLayout: true,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      fontFamily: 'monospace',
      fontSize: 14,
    });

    editor.onDidChangeModelContent(() => {
      const currentValue = editor.getValue();
      if (value !== currentValue) {
        value = currentValue;
      }
    });

    return () => {
      editor.dispose();
    };
  });

  // React to prop changes
  $: if (editor && value !== editor.getValue()) {
    editor.setValue(value);
  }
  
  $: if (editor) {
    const model = editor.getModel();
    if (model) {
      monaco.editor.setModelLanguage(model, language);
    }
  }
  
  $: if (editor) {
    monaco.editor.setTheme(theme);
  }
</script>

<div bind:this={editorContainer} class="w-full h-full min-h-[400px] border border-gray-700 rounded-md overflow-hidden"></div>
