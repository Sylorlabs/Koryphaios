<script lang="ts">
  import { 
    FileText, 
    FileCode, 
    FileJson, 
    File, 
    Hash, 
    Terminal, 
    Layers, 
    Settings2, 
    Database, 
    Lock,
    Image as ImageIcon,
    Music,
    Video,
    Box,
    Globe,
    Cpu,
    Coffee,
    Type,
    Table,
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

  type IconTheme = {
    type: 'badge' | 'icon';
    label?: string;
    icon?: any;
    color: string;
    textColor?: string;
  };

  const getTheme = (ext: string, name: string): IconTheme => {
    // ─── Exact Filename Matches ──────────────────────────────────────────────
    if (name === 'dockerfile') return { type: 'icon', icon: Layers, color: '#2496ed' };
    if (name === 'makefile') return { type: 'icon', icon: Terminal, color: '#4ebd37' };
    if (name === 'gemfile') return { type: 'badge', label: 'GEM', color: '#701516' };
    if (name === 'procfile') return { type: 'badge', label: 'PROC', color: '#7b42bc' };
    if (name === 'jenkinsfile') return { type: 'badge', label: 'JENK', color: '#d33833' };
    if (name.startsWith('.env')) return { type: 'icon', icon: Settings2, color: '#cbcb41' };
    if (name.startsWith('.git')) return { type: 'icon', icon: Hash, color: '#f05032' };
    if (name.includes('eslint')) return { type: 'badge', label: 'ES', color: '#4b32c3' };
    if (name.includes('prettier')) return { type: 'badge', label: 'PR', color: '#f7b93e', textColor: '#000' };
    if (name === 'package.json' || name === 'bun.lock' || name === 'yarn.lock' || name.includes('lock')) return { type: 'icon', icon: Lock, color: '#83cd29' };
    if (name === 'license' || name === 'license.md' || name === 'license.txt') return { type: 'badge', label: 'LIC', color: '#d0d0d0', textColor: '#000' };
    if (name === 'readme.md') return { type: 'icon', icon: FileText, color: '#3178c6' };

    // ─── Extension Matches ───────────────────────────────────────────────────
    switch (ext) {
      // JavaScript / Web
      case 'ts': return { type: 'badge', label: 'TS', color: '#3178c6' };
      case 'tsx': return { type: 'badge', label: 'TSX', color: '#3178c6' };
      case 'js': return { type: 'badge', label: 'JS', color: '#f7df1e', textColor: '#000' };
      case 'jsx': return { type: 'badge', label: 'JSX', color: '#61dafb', textColor: '#000' };
      case 'mjs': return { type: 'badge', label: 'JS', color: '#f7df1e', textColor: '#000' };
      case 'cjs': return { type: 'badge', label: 'JS', color: '#f7df1e', textColor: '#000' };
      case 'svelte': return { type: 'badge', label: 'S', color: '#ff3e00' };
      case 'vue': return { type: 'badge', label: 'V', color: '#41b883' };
      case 'astro': return { type: 'badge', label: 'A', color: '#ff5d01' };
      case 'html': return { type: 'badge', label: '<>', color: '#e34c26' };
      case 'css': return { type: 'badge', label: '#', color: '#264de4' };
      case 'scss': return { type: 'badge', label: 'SASS', color: '#c6538c' };
      case 'less': return { type: 'badge', label: 'LESS', color: '#1d365d' };
      case 'wasm': return { type: 'badge', label: 'WASM', color: '#654ff0' };

      // Backend / Systems
      case 'py': return { type: 'badge', label: 'PY', color: '#3776ab' };
      case 'go': return { type: 'badge', label: 'GO', color: '#00add8' };
      case 'rs': return { type: 'badge', label: 'RS', color: '#dea584' };
      case 'java': return { type: 'badge', label: 'J', color: '#b07219' };
      case 'class': return { type: 'badge', label: 'CLS', color: '#b07219' };
      case 'jar': return { type: 'icon', icon: Archive, color: '#b07219' };
      case 'c': return { type: 'badge', label: 'C', color: '#a8b9cc' };
      case 'h': return { type: 'badge', label: 'H', color: '#a8b9cc' };
      case 'cpp': case 'cc': case 'cxx': return { type: 'badge', label: 'C++', color: '#00599c' };
      case 'hpp': case 'hh': case 'hxx': return { type: 'badge', label: 'H++', color: '#00599c' };
      case 'cs': return { type: 'badge', label: 'C#', color: '#178600' };
      case 'php': return { type: 'badge', label: 'PHP', color: '#4f5d95' };
      case 'rb': return { type: 'badge', label: 'RB', color: '#701516' };
      case 'swift': return { type: 'badge', label: 'SW', color: '#ffac45' };
      case 'kt': case 'kts': return { type: 'badge', label: 'KT', color: '#7f52ff' };
      case 'scala': return { type: 'badge', label: 'SC', color: '#dc322f' };
      case 'dart': return { type: 'badge', label: 'DA', color: '#00b4ab' };
      case 'lua': return { type: 'badge', label: 'LUA', color: '#000080' };
      case 'pl': return { type: 'badge', label: 'PL', color: '#0298c3' };
      case 'ex': case 'exs': return { type: 'badge', label: 'EX', color: '#6e4a7e' };
      case 'erl': return { type: 'badge', label: 'ERL', color: '#b83998' };
      case 'hs': return { type: 'badge', label: 'HS', color: '#5e5086' };
      case 'clj': return { type: 'badge', label: 'CLJ', color: '#db5855' };
      case 'lisp': return { type: 'badge', label: 'LISP', color: '#3fb68b' };
      case 'f90': case 'f95': return { type: 'badge', label: 'F', color: '#4d41b1' };
      case 'r': return { type: 'badge', label: 'R', color: '#198ce7' };
      case 'jl': return { type: 'badge', label: 'JL', color: '#9558b2' };
      case 'zig': return { type: 'badge', label: 'ZIG', color: '#ec915c' };
      case 'nim': return { type: 'badge', label: 'NIM', color: '#ffc200', textColor: '#000' };

      // Config / Data
      case 'json': return { type: 'icon', icon: FileJson, color: '#cbcb41' };
      case 'json5': return { type: 'icon', icon: FileJson, color: '#cbcb41' };
      case 'yaml': case 'yml': return { type: 'icon', icon: Layers, color: '#cb171e' };
      case 'toml': return { type: 'icon', icon: Settings2, color: '#9c4221' };
      case 'xml': return { type: 'badge', label: 'XML', color: '#0060ac' };
      case 'ini': return { type: 'icon', icon: Settings2, color: '#cccccc' };
      case 'conf': return { type: 'icon', icon: Settings2, color: '#cccccc' };
      case 'csv': return { type: 'icon', icon: Table, color: '#217346' };
      case 'sql': return { type: 'icon', icon: Database, color: '#336791' };
      case 'db': case 'sqlite': return { type: 'icon', icon: Database, color: '#336791' };
      case 'graphql': case 'gql': return { type: 'badge', label: 'GQL', color: '#e10098' };
      case 'proto': return { type: 'badge', label: 'PB', color: '#4d41b1' };

      // Shell / Scripts
      case 'sh': case 'bash': case 'zsh': case 'fish': return { type: 'icon', icon: Terminal, color: '#4ebd37' };
      case 'bat': case 'cmd': case 'ps1': return { type: 'icon', icon: Terminal, color: '#cccccc' };

      // Assets
      case 'png': case 'jpg': case 'jpeg': case 'gif': case 'webp': case 'ico': case 'svg': case 'bmp': case 'tiff':
        return { type: 'icon', icon: ImageIcon, color: '#b07219' };
      case 'mp3': case 'wav': case 'ogg': case 'flac': case 'm4a':
        return { type: 'icon', icon: Music, color: '#d07e6b' };
      case 'mp4': case 'mov': case 'avi': case 'mkv': case 'webm':
        return { type: 'icon', icon: Video, color: '#d07e6b' };
      case 'zip': case 'tar': case 'gz': case '7z': case 'rar':
        return { type: 'icon', icon: Archive, color: '#dbb32d' };
      case 'ttf': case 'otf': case 'woff': case 'woff2': case 'eot':
        return { type: 'icon', icon: Type, color: '#ff5252' };
      case '3d': case 'obj': case 'fbx': case 'stl': case 'gltf':
        return { type: 'icon', icon: Box, color: '#2496ed' };

      // Docs
      case 'md': case 'markdown': return { type: 'icon', icon: FileText, color: '#999999' };
      case 'txt': case 'text': return { type: 'icon', icon: FileText, color: '#808080' };
      case 'pdf': return { type: 'badge', label: 'PDF', color: '#b30b00' };
      case 'doc': case 'docx': return { type: 'badge', label: 'DOC', color: '#2b579a' };

      default: return { type: 'icon', icon: File, color: '#8b8b96' };
    }
  };

  let theme = $derived(getTheme(extension, fileName));
</script>

<div 
  class="inline-flex items-center justify-center shrink-0 {className}"
  style="width: {size}px; height: {size}px;"
>
  {#if theme.type === 'badge'}
    <div 
      class="w-full h-full rounded-[2px] flex items-center justify-center font-bold tracking-tighter shadow-sm"
      style="background: {theme.color}; color: {theme.textColor || '#fff'}; font-size: {size * 0.5}px; line-height: 1;"
    >
      {theme.label}
    </div>
  {:else}
    <theme.icon size={size} style="color: {theme.color};" strokeWidth={2.5} />
  {/if}
</div>
