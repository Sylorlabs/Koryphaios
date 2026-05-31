<script lang="ts">
  import { EXISTING_PROVIDER_ICON_PATHS } from './provider-icon-assets';

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
    nebius: ['nebius'],
    together: ['together', 'together-brand'],
    upstage: ['upstage'],
    opencodezen: ['opencode'],
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
  ]);

  const monochromeFirstProviders = new Set([
    'zai',
    'moonshot',
    'baseten',
    'nebius',
    'lmstudio',
    'zenmux',
  ]);

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

    const pushCandidate = (src: string, themeAdaptive: boolean) => {
      if (seen.has(src) || !EXISTING_PROVIDER_ICON_PATHS.has(src)) return;
      seen.add(src);
      candidates.push({ src, themeAdaptive });
    };

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

{#if !loadError && currentCandidate}
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

  :global(:root[data-theme='dark']) .theme-adaptive {
    filter: brightness(0) invert(1);
  }
</style>
