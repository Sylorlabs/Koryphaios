<script lang="ts">
  import { EXISTING_PROVIDER_ICON_PATHS } from './provider-icon-assets';
  import { base } from '$app/paths';

  interface Props {
    provider: string;
    size?: number;
    class?: string;
  }

  interface IconCandidate {
    src: string;
    themeAdaptive: boolean;
  }

  let { provider, size = 16, class: className = '' }: Props = $props();

  const providerSlugMap: Record<string, string[]> = {
    anthropic: ['anthropic'],
    claude: ['claudecode', 'claude'],
    openai: ['openai'],
    google: ['google', 'google-brand'],
    xai: ['xai'],
    openrouter: ['openrouter'],
    groq: ['groq'],
    togetherai: ['together', 'together-brand'],
    deepseek: ['deepseek'],
    mistralai: ['mistral'],
    mistral: ['mistral'],
    cohere: ['cohere'],
    perplexity: ['perplexity'],
    azure: ['azure'],
    azurecognitive: ['azureai', 'azure'],
    bedrock: ['bedrock'],
    vertexai: ['vertexai'],
    cloudflare: ['cloudflare'],
    vercel: ['vercel'],
    huggingface: ['huggingface'],
    replicate: ['replicate'],
    ollama: ['ollama'],
    qwen: ['qwen'],
    alibaba: ['alibaba'],
    'alibaba-cn': ['alibaba'],
    '302ai': ['ai302'],
    baichuan: ['baichuan'],
    minimax: ['minimax'],
    kimicode: ['kimicode', 'kimi'],
    moonshot: ['moonshot'],
    stepfun: ['stepfun'],
    zhipuai: ['zhipu'],
    fireworks: ['fireworks'],
    deepinfra: ['deepinfra'],
    codex: ['codex'],
    cortex: ['cortex', 'openai'],
    nebius: ['nebius'],
    together: ['together', 'together-brand'],
    upstage: ['upstage'],
    opencodezen: ['opencode'],
    opencodego: ['opencode'],
    copilot: ['githubcopilot'],
    github: ['github'],
    gitlab: ['gitlab'],
    v0: ['v0'],
    local: ['local', 'lmstudio'],
    lmstudio: ['lmstudio'],
    nvidia: ['nvidia'],
    nim: ['nvidia'],
    voyageai: ['voyage'],
    friendliai: ['friendli'],
    cortecs: ['cortecs'],
    cline: ['cline'],
    cerebras: ['cerebras'],
    klingai: ['kling'],
    ionet: ['ionet'],
    ollamacloud: ['ollama'],
    firmware: ['firmware'],
    helicone: ['helicone'],
    llamacpp: ['llamacpp'],
    sapai: ['sapai'],
    stackit: ['stackit'],
    ovhcloud: ['ovhcloud'],
    scaleway: ['scaleway'],
    venice: ['venice'],
    zenmux: ['zenmux'],
    zai: ['zai'],
    antigravity: ['antigravity'],
    jules: ['jules'],
    cursor: ['cursor'],
  };

  const themeAdaptiveSlugs = new Set([
    'openai',
    'anthropic',
    'claude',
    'claudecode',
    'xai',
    'deepseek',
    'mistral',
    'moonshot',
    'kimicode',
    'cohere',
    'perplexity',
    'together',
    'groq',
    'openrouter',
    'opencode',
    'replicate',
    'ollama',
    'codex',
    'copilot',
    'github',
    'gitlab',
    'vercel',
    'zai',
    'baseten',
    'nebius',
    'lmstudio',
    'zenmux',
    'grok',
    'cursor',
    'cline',
    'devin',
    'cerebras',
  ]);

  const monochromeFirstProviders = new Set([
    'zai',
    'moonshot',
    'baseten',
    'nebius',
    'lmstudio',
    'zenmux',
    'grok',
    'cursor',
    'cline',
    'devin',
    'cerebras',
  ]);

  // Cortecs does not publish an icon through the bundled LobeHub set. Use the
  // avatar from its verified Hugging Face organization instead of a fabricated
  // fallback mark.
  const officialProviderIcons: Record<string, string> = {
    cortecs:
      'https://cdn-avatars.huggingface.co/v1/production/uploads/64158719bce2fed80ab26ebe/3kkigrx94iBGnQkER3EP2.png',
  };

  let loadError = $state(false);
  let candidateIndex = $state(0);

  const unique = (values: string[]) => [...new Set(values.filter(Boolean))];

  const getSlugCandidates = (p: string) => {
    const normalized = p.toLowerCase();
    const mapped = providerSlugMap[normalized];
    return mapped ? unique(mapped) : [normalized];
  };

  const getIconCandidates = (p: string): IconCandidate[] => {
    const normalized = p.toLowerCase();
    const slugs = getSlugCandidates(normalized);
    const candidates: IconCandidate[] = [];
    const seen = new Set<string>();
    const preferMonochrome = monochromeFirstProviders.has(normalized);

    const pushCandidate = (src: string, themeAdaptive: boolean, remote = false) => {
      if (seen.has(src) || (!remote && !EXISTING_PROVIDER_ICON_PATHS.has(src))) return;
      seen.add(src);
      // Local assets must respect the SvelteKit base path (e.g. /demo-app on
      // the koryphaios.com embed); remote URLs pass through untouched.
      candidates.push({ src: remote ? src : `${base}${src}`, themeAdaptive });
    };

    const officialIcon = officialProviderIcons[normalized];
    if (officialIcon) pushCandidate(officialIcon, false, true);

    const pushColorCandidates = () => {
      for (const slug of slugs) {
        pushCandidate(`/provider-icons/${slug}-color.svg`, false);
        pushCandidate(`/provider-icons/${slug}-color.png`, false);
        pushCandidate(`/provider-icons/${slug}-color.ico`, false);
        pushCandidate(`/provider-icons/lobehub/${slug}-color.svg`, false);
      }
    };

    const pushMonochromeCandidates = () => {
      for (const slug of slugs) {
        const themeAdaptive = themeAdaptiveSlugs.has(slug) || themeAdaptiveSlugs.has(normalized);
        pushCandidate(`/provider-icons/lobehub/${slug}.svg`, themeAdaptive);
        pushCandidate(`/provider-icons/${slug}.svg`, themeAdaptive);
      }
    };

    if (preferMonochrome) {
      pushMonochromeCandidates();
      pushColorCandidates();
    } else {
      pushColorCandidates();
      pushMonochromeCandidates();
    }

    return candidates;
  };

  const iconCandidates = $derived.by(() => getIconCandidates(provider));
  const currentCandidate = $derived.by(() => iconCandidates[candidateIndex] ?? null);

  $effect(() => {
    provider;
    candidateIndex = 0;
    loadError = false;
  });
</script>

{#if provider.toLowerCase() === 'codex'}
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    class={`provider-icon ${className}`}
    role="img"
    aria-label="Codex logo"
  >
    <path
      d="M9.064 3.344a4.578 4.578 0 012.285-.312c1 .115 1.891.54 2.673 1.275.01.01.024.017.037.021a.09.09 0 00.043 0 4.55 4.55 0 013.046.275l.047.022.116.057a4.581 4.581 0 012.188 2.399c.209.51.313 1.041.315 1.595a4.24 4.24 0 01-.134 1.223.123.123 0 00.03.115c.594.607.988 1.33 1.183 2.17.289 1.425-.007 2.71-.887 3.854l-.136.166a4.548 4.548 0 01-2.201 1.388.123.123 0 00-.081.076c-.191.551-.383 1.023-.74 1.494-.9 1.187-2.222 1.846-3.711 1.838-1.187-.006-2.239-.44-3.157-1.302a.107.107 0 00-.105-.024c-.388.125-.78.143-1.204.138a4.441 4.441 0 01-1.945-.466 4.544 4.544 0 01-1.61-1.335c-.152-.202-.303-.392-.414-.617a5.81 5.81 0 01-.37-.961 4.582 4.582 0 01-.014-2.298.124.124 0 00.006-.056.085.085 0 00-.027-.048 4.467 4.467 0 01-1.034-1.651 3.896 3.896 0 01-.251-1.192 5.189 5.189 0 01.141-1.6c.337-1.112.982-1.985 1.933-2.618.212-.141.413-.251.601-.33.215-.089.43-.164.646-.227a.098.098 0 00.065-.066 4.51 4.51 0 01.829-1.615 4.535 4.535 0 011.837-1.388zm3.482 10.565a.637.637 0 000 1.272h3.636a.637.637 0 100-1.272h-3.636zM8.462 9.23a.637.637 0 00-1.106.631l1.272 2.224-1.266 2.136a.636.636 0 101.095.649l1.454-2.455a.636.636 0 00.005-.64L8.462 9.23z"
      fill="url(#codex-app-gradient)"
    />
    <defs>
      <linearGradient id="codex-app-gradient" x1="12" x2="12" y1="3" y2="21" gradientUnits="userSpaceOnUse">
        <stop stop-color="#b1a7ff" />
        <stop offset=".5" stop-color="#7a9dff" />
        <stop offset="1" stop-color="#3941ff" />
      </linearGradient>
    </defs>
  </svg>
{:else if provider.toLowerCase() === 'cerebras'}
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    class={`provider-icon cerebras-icon ${className}`}
    role="img"
    aria-label="Cerebras logo"
  >
    <path
      clip-rule="evenodd"
      d="M14.121 2.701a9.299 9.299 0 000 18.598V22.7c-5.91 0-10.7-4.791-10.7-10.701S8.21 1.299 14.12 1.299V2.7zm4.752 3.677A7.353 7.353 0 109.42 17.643l-.901 1.074a8.754 8.754 0 01-1.08-12.334 8.755 8.755 0 0112.335-1.08l-.901 1.075zm-2.255.844a5.407 5.407 0 00-5.048 9.563l-.656 1.24a6.81 6.81 0 016.358-12.043l-.654 1.24zM14.12 8.539a3.46 3.46 0 100 6.922v1.402a4.863 4.863 0 010-9.726v1.402z"
      fill="#f15a29"
      fill-rule="evenodd"
    />
    <path
      d="M15.407 10.836a2.24 2.24 0 00-.51-.409 1.084 1.084 0 00-.544-.152c-.255 0-.483.047-.684.14a1.58 1.58 0 00-.84.912c-.074.203-.11.416-.11.631 0 .218.036.43.11.631a1.594 1.594 0 00.84.913c.2.093.43.14.684.14.216 0 .417-.046.602-.135.188-.09.35-.225.475-.392l.928 1.006c-.14.14-.3.261-.482.363a3.367 3.367 0 01-1.083.38c-.17.026-.317.04-.44.04a3.315 3.315 0 01-1.182-.21 2.825 2.825 0 01-.961-.597 2.816 2.816 0 01-.644-.929 2.987 2.987 0 01-.238-1.21c0-.444.08-.847.238-1.21.15-.35.368-.666.643-.929.278-.261.605-.464.962-.596a3.315 3.315 0 011.182-.21c.355 0 .712.068 1.072.204.361.138.685.36.944.649l-.962.97z"
      fill="currentColor"
    />
  </svg>
{:else if !loadError && currentCandidate}
  <img
    src={currentCandidate.src}
    alt={`${provider} logo`}
    width={size}
    height={size}
    class={`provider-icon ${currentCandidate.themeAdaptive ? 'theme-adaptive' : ''} ${className}`}
    loading="lazy"
    decoding="async"
    onerror={() => {
      if (candidateIndex < iconCandidates.length - 1) {
        candidateIndex += 1;
      } else {
        loadError = true;
      }
    }}
  />
{:else}
  <div class={`provider-icon-placeholder ${className}`} style="width: {size}px; height: {size}px;">
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="8" stroke="currentColor" stroke-width="1.5" fill="none" style="color: var(--color-text-muted);" />
      <circle cx="12" cy="12" r="3" fill="currentColor" style="color: var(--color-text-muted);" />
    </svg>
  </div>
{/if}

<style>
  .provider-icon {
    display: block;
    object-fit: contain;
    background: transparent;
    border: 0;
    border-radius: 0;
  }

  .provider-icon-placeholder {
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .cerebras-icon {
    color: var(--color-text-primary);
  }

  :global(:root[data-theme='dark']) .theme-adaptive {
    filter: brightness(0) invert(1);
  }
</style>
