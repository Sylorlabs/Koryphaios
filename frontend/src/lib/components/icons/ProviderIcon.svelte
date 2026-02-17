<script lang="ts">
  import { browser } from '$app/environment';

  interface Props {
    provider: string;
    size?: number;
    class?: string;
  }

  let { provider, size = 16, class: className = '' }: Props = $props();

  const providerIconPath: Record<string, string> = {
    anthropic: '/provider-icons/anthropic.png',
    openai: '/provider-icons/openai.png',
    google: '/provider-icons/google.png',
    xai: '/provider-icons/xai.png',
    openrouter: '/provider-icons/openrouter.png',
    copilot: '/provider-icons/copilot.png',
    groq: '/provider-icons/groq.png',
    togetherai: '/provider-icons/togetherai.png',
    opencodezen: '/provider-icons/opencodezen.png',

    cloudflare: '/provider-icons/cloudflare.svg',
    vercel: '/provider-icons/vercel.svg',
    baseten: '/provider-icons/baseten.png',
    helicone: '/provider-icons/helicone.png',
    portkey: '/provider-icons/portkey.png',

    cerebras: '/provider-icons/cerebras.png',
    fireworks: '/provider-icons/fireworks.png',
    deepinfra: '/provider-icons/deepinfra.png',
    hyperbolic: '/provider-icons/hyperbolic.png',
    ionet: '/provider-icons/ionet.png',

    deepseek: '/provider-icons/deepseek.png',
    moonshot: '/provider-icons/moonshot.png',
    minimax: '/provider-icons/minimax.svg',
    nebius: '/provider-icons/nebius.png',
    zai: '/provider-icons/zai.png',
    cortecs: '/provider-icons/cortecs.png',
    stepfun: '/provider-icons/stepfun.png',

    huggingface: '/provider-icons/huggingface.svg',
    replicate: '/provider-icons/replicate.svg',
    modal: '/provider-icons/modal.svg',
    scaleway: '/provider-icons/scaleway.svg',
    venice: '/provider-icons/venice.png',
    zenmux: '/provider-icons/zenmux.png',
    firmware: '/provider-icons/firmware.png',

    azure: '/provider-icons/azure.png',
    azurecognitive: '/provider-icons/azurecognitive.png',
    bedrock: '/provider-icons/bedrock.png',
    vertexai: '/provider-icons/vertexai.png',
    sapai: '/provider-icons/sapai.svg',
    stackit: '/provider-icons/stackit.png',
    ovhcloud: '/provider-icons/ovhcloud.svg',

    local: '/provider-icons/local.png',
    ollama: '/provider-icons/ollama.svg',
    ollamacloud: '/provider-icons/ollamacloud.svg',
    lmstudio: '/provider-icons/lmstudio.png',
    llamacpp: '/provider-icons/llamacpp.png',

    gitlab: '/provider-icons/gitlab.svg',
    codex: '/provider-icons/codex.png',
    antigravity: '/provider-icons/antigravity.png',

    mistralai: '/provider-icons/mistralai.svg',
    cohere: '/provider-icons/cohere.png',
    perplexity: '/provider-icons/perplexity.svg',
    luma: '/provider-icons/luma.png',
    fal: '/provider-icons/fal.png',

    elevenlabs: '/provider-icons/elevenlabs.svg',
    deepgram: '/provider-icons/deepgram.svg',
    gladia: '/provider-icons/gladia.png',
    assemblyai: '/provider-icons/assemblyai.png',
    lmnt: '/provider-icons/lmnt.png',

    nvidia: '/provider-icons/nvidia.svg',
    friendliai: '/provider-icons/friendliai.png',
    voyageai: '/provider-icons/voyageai.png',
    mixedbread: '/provider-icons/mixedbread.png',
    mem0: '/provider-icons/mem0.png',
    letta: '/provider-icons/letta.png',
    blackforestlabs: '/provider-icons/blackforestlabs.png',
    klingai: '/provider-icons/klingai.png',
    prodia: '/provider-icons/prodia.png',
    a302ai: '/provider-icons/a302ai.png',
  };

  const themeAdaptive = new Set([
    'openai',
    'codex',
    'vercel',
  ]);

  let loadError = $state(false);
  let preloaded = false;

  if (browser && !preloaded) {
    preloaded = true;
    for (const src of Object.values(providerIconPath)) {
      const img = new Image();
      img.decoding = 'async';
      img.src = src;
    }
  }

  $effect(() => {
    provider;
    loadError = false;
  });
</script>

{#if providerIconPath[provider] && !loadError}
  <img
    src={providerIconPath[provider]}
    alt={`${provider} logo`}
    width={size}
    height={size}
    class={`provider-icon ${themeAdaptive.has(provider) ? 'theme-adaptive' : ''} ${className}`}
    loading="eager"
    decoding="sync"
    onerror={() => loadError = true}
  />
{:else}
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" class={className}>
    <circle cx="12" cy="12" r="8" stroke="currentColor" stroke-width="1.5" fill="none" style="color: var(--color-text-muted);" />
    <circle cx="12" cy="12" r="3" fill="currentColor" style="color: var(--color-text-muted);" />
  </svg>
{/if}

<style>
  .provider-icon {
    display: block;
    object-fit: contain;
    background: transparent;
    border: 0;
    border-radius: 0;
  }

  :global(:root[data-theme='dark']) .theme-adaptive {
    filter: brightness(0) invert(1);
  }

  :global(:root[data-theme='light']) .theme-adaptive {
    filter: none;
  }
</style>
