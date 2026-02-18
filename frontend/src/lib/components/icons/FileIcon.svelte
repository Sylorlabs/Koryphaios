<script lang="ts">
  import {
    FileText,
    FileJson,
    File,
    Hash,
    Terminal,
    Layers,
    Settings2,
    Database,
    Lock,
    Image as ImageIcon,
    Box,
    Type,
    Archive
  } from 'lucide-svelte';

  interface Props {
    path: string;
    size?: number;
    class?: string;
  }

  let { path, size = 16, class: className = "" }: Props = $props();

  let extension = $derived(path.split('.').pop()?.toLowerCase() || "");
  let fileName = $derived(path.split('/').pop()?.toLowerCase() || "");

  const colors = {
    typescript: '#3178c6',
    javascript: '#f7df1e',
    svelte: '#ff3e00',
    python: '#3776ab',
    go: '#00add8',
    rust: '#dea584',
    cpp: '#00599c',
    c: '#a8b9cc',
    java: '#b07219',
    ruby: '#701516',
    php: '#4f5d95',
    swift: '#ffac45',
    kotlin: '#7f52ff',
    dart: '#00b4ab',
    elixir: '#6e4a7e',
    lua: '#000080',
    csharp: '#178600',
    zig: '#ec915c',
    asm: '#6d6d6d',
    html: '#e34c26',
    css: '#264de4',
    json: '#cbcb41',
    markdown: '#000000', // Markdown official is often black or blue
    git: '#f05032',
    docker: '#2496ed',
    node: '#83cd29',
    shell: '#4ebd37',
    yaml: '#cb171e',
    toml: '#9c4221',
    sql: '#336791',
    xml: '#0060ac',
    graphql: '#e10098',
    image: '#ec915c'
  };

  type IconType = 'ts' | 'tsx' | 'js' | 'jsx' | 'svelte' | 'py' | 'go' | 'rs' | 'cpp' | 'c' | 'java' | 'rb' | 'php' | 'swift' | 'kt' | 'dart' | 'ex' | 'lua' | 'cs' | 'zig' | 'asm' | 'html' | 'css' | 'json' | 'md' | 'git' | 'docker' | 'shell' | 'yaml' | 'toml' | 'sql' | 'xml' | 'gql' | 'node' | 'image' | 'default';

  const getType = (ext: string, name: string): IconType => {
    if (name === 'dockerfile') return 'docker';
    if (name.startsWith('.git')) return 'git';
    if (name.startsWith('.env')) return 'shell';
    if (name === 'package.json' || name.includes('lock')) return 'node';
    if (name.toLowerCase().includes('makefile')) return 'shell';

    switch (ext) {
      case 'ts': return 'ts';
      case 'tsx': return 'tsx';
      case 'js': case 'mjs': case 'cjs': return 'js';
      case 'jsx': return 'jsx';
      case 'svelte': return 'svelte';
      case 'py': return 'py';
      case 'go': return 'go';
      case 'rs': return 'rs';
      case 'cpp': case 'cc': return 'cpp';
      case 'c': case 'h': return 'c';
      case 'java': return 'java';
      case 'rb': return 'rb';
      case 'php': return 'php';
      case 'swift': return 'swift';
      case 'kt': case 'kts': return 'kt';
      case 'dart': return 'dart';
      case 'ex': case 'exs': return 'ex';
      case 'lua': return 'lua';
      case 'cs': return 'cs';
      case 'zig': return 'zig';
      case 'asm': case 's': return 'asm';
      case 'html': return 'html';
      case 'css': case 'scss': case 'sass': return 'css';
      case 'json': return 'json';
      case 'md': case 'markdown': return 'md';
      case 'yaml': case 'yml': return 'yaml';
      case 'toml': return 'toml';
      case 'sql': return 'sql';
      case 'xml': return 'xml';
      case 'graphql': case 'gql': return 'gql';
      case 'png': case 'jpg': case 'jpeg': case 'gif': case 'webp': case 'svg': case 'ico': return 'image';
      default: return 'default';
    }
  };

  let type = $derived(getType(extension, fileName));

  const badgeMap: Record<string, { label: string; color: string; darkText?: boolean }> = {
    ts: { label: 'TS', color: colors.typescript },
    tsx: { label: 'TX', color: colors.typescript },
    js: { label: 'JS', color: colors.javascript, darkText: true },
    jsx: { label: 'JX', color: colors.javascript, darkText: true },
    go: { label: 'GO', color: colors.go },
    rs: { label: 'RS', color: colors.rust },
    cpp: { label: 'C++', color: colors.cpp },
    c: { label: 'C', color: colors.c },
    java: { label: 'J', color: colors.java },
    rb: { label: 'RB', color: colors.ruby },
    php: { label: 'PHP', color: colors.php },
    swift: { label: 'SW', color: colors.swift },
    kt: { label: 'KT', color: colors.kotlin },
    dart: { label: 'DA', color: colors.dart },
    ex: { label: 'EX', color: colors.elixir },
    lua: { label: 'LUA', color: colors.lua },
    cs: { label: 'C#', color: colors.csharp },
    zig: { label: 'ZIG', color: colors.zig },
    asm: { label: 'ASM', color: colors.asm },
    html: { label: '<>', color: colors.html },
    css: { label: '#', color: colors.css },
    xml: { label: 'XML', color: colors.xml },
    toml: { label: 'TML', color: colors.toml },
    gql: { label: 'GQL', color: colors.graphql }
  };
</script>

<div
  class="inline-flex items-center justify-center shrink-0 {className} overflow-hidden"
  style="width: {size}px; height: {size}px;"
>
  {#if type === 'svelte'}
    <svg viewBox="0 0 32 32" width={size} height={size}>
      <path fill={colors.svelte} d="M27.573 4.229c-2.927-4.25-8.656-5.479-13.068-2.802l-7.464 4.745c-2.042 1.281-3.443 3.365-3.854 5.734-0.365 1.969-0.047 4.005 0.891 5.776-0.641 0.964-1.073 2.052-1.266 3.198-0.427 2.406 0.13 4.885 1.547 6.88 2.932 4.24 8.646 5.474 13.068 2.828l7.469-4.75c2.031-1.281 3.427-3.365 3.839-5.734 0.359-1.964 0.042-3.995-0.896-5.755 1.984-3.115 1.88-7.12-0.266-10.12zM13.76 28.172c-2.401 0.625-4.938-0.318-6.349-2.359-0.865-1.198-1.182-2.677-0.932-4.146l0.146-0.708 0.135-0.438 0.401 0.266c0.88 0.667 1.865 1.146 2.917 1.469l0.271 0.094-0.031 0.266c-0.026 0.37 0.083 0.786 0.297 1.104 0.438 0.63 1.198 0.932 1.932 0.734 0.161-0.052 0.318-0.104 0.453-0.188l7.438-4.745c0.375-0.24 0.615-0.599 0.708-1.026 0.083-0.443-0.026-0.896-0.266-1.255-0.443-0.615-1.198-0.891-1.932-0.708-0.161 0.057-0.333 0.12-0.469 0.203l-2.813 1.786c-2.661 1.583-6.099 0.839-7.865-1.708-0.859-1.198-1.198-2.693-0.938-4.146 0.26-1.438 1.12-2.698 2.365-3.469l7.422-4.745c0.469-0.292 0.974-0.505 1.521-0.667 2.401-0.625 4.932 0.318 6.349 2.349 1 1.406 1.281 3.203 0.76 4.849l-0.135 0.443-0.385-0.266c-0.891-0.651-1.88-1.146-2.932-1.469l-0.266-0.078 0.026-0.266c0.026-0.391-0.083-0.802-0.297-1.12-0.438-0.63-1.198-0.896-1.932-0.708-0.161 0.052-0.318 0.104-0.453 0.188l-7.453 4.786c-0.375 0.25-0.615 0.599-0.693 1.036-0.078 0.427 0.026 0.896 0.266 1.24 0.427 0.63 1.203 0.896 1.922 0.708 0.172-0.052 0.333-0.104 0.464-0.188l2.844-1.813c0.464-0.307 0.984-0.531 1.516-0.677 2.417-0.63 4.938 0.318 6.349 2.359 0.865 1.198 1.198 2.677 0.958 4.13-0.25 1.438-1.099 2.698-2.333 3.469l-7.438 4.734c-0.484 0.292-1.005 0.521-1.547 0.677z"/>
    </svg>
  {:else if type === 'md'}
    <svg viewBox="0 0 208 128" width={size} height={size}>
      <path fill="currentColor" class="text-[var(--color-text-primary)]" d="M30 98V30h20l20 25 20-25h20v68H90V59L70 84 50 59v39zm125 0l-30-33h20V30h20v35h20z"/>
    </svg>
  {:else if badgeMap[type]}
    {@const b = badgeMap[type]}
    <svg viewBox="0 0 32 32" width={size} height={size}>
      <rect width="32" height="32" rx="4" fill={b.color} />
      <text
        x="16"
        y={b.label.length > 2 ? "21" : "22"}
        text-anchor="middle"
        font-family="Inter, -apple-system, sans-serif"
        font-weight="800"
        font-size={b.label.length > 2 ? "11" : "14"}
        fill={b.darkText ? "#323330" : "white"}
      >{b.label}</text>
    </svg>
  {:else if type === 'py'}
    <svg viewBox="0 0 32 32" width={size} height={size}>
      <path fill={colors.python} d="M16 3C11.03 3 11.28 5.16 11.28 5.16l.03 3.53h4.75v.66H9.31S5 8.81 5 14.16c0 5.34 3.81 5.16 3.81 5.16h2.28v-3.19s-.06-3.81 3.75-3.81h5.69s3.66.06 3.66-3.53V5.16S24.44 3 16 3zm-3.81 1.84a1.16 1.16 0 1 1 0 2.31 1.16 1.16 0 0 1 0-2.31z"/>
      <path fill="#ffd343" d="M16 29c4.97 0 4.72-2.16 4.72-2.16l-.03-3.53h-4.75v-.66h6.75S27 23.19 27 17.84c0-5.34-3.81-5.16-3.81-5.16h-2.28v3.19s.06 3.81-3.75 3.81h-5.69s-3.66-.06-3.66 3.53v3.63S7.56 29 16 29zm3.81-1.84a1.16 1.16 0 1 1 0-2.31 1.16 1.16 0 0 1 0-2.31z"/>
    </svg>
  {:else if type === 'json'}
    <FileJson size={size} style="color: {colors.json};" strokeWidth={2.5} />
  {:else if type === 'git'}
    <Hash size={size} style="color: {colors.git};" strokeWidth={2.5} />
  {:else if type === 'docker'}
    <Layers size={size} style="color: {colors.docker};" strokeWidth={2.5} />
  {:else if type === 'node'}
    <Lock size={size} style="color: {colors.node};" strokeWidth={2.5} />
  {:else if type === 'yaml'}
    <Settings2 size={size} style="color: {colors.yaml};" strokeWidth={2.5} />
  {:else if type === 'sql'}
    <Database size={size} style="color: {colors.sql};" strokeWidth={2.5} />
  {:else if type === 'shell'}
    <Terminal size={size} style="color: {colors.shell};" strokeWidth={2.5} />
  {:else if type === 'image'}
    <ImageIcon size={size} style="color: {colors.image};" strokeWidth={2.5} />
  {:else}
    <File size={size} style="color: #8b8b96;" strokeWidth={2.5} />
  {/if}
</div>
