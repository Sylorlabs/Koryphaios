<script lang="ts">
  interface Props {
    provider: string;
    size?: number;
    class?: string;
  }

  let { provider, size = 16, class: className = '' }: Props = $props();

  const providerIconPath: Record<string, string> = {
    anthropic: '/provider-icons/anthropic.svg',
    openai: '/provider-icons/openai.svg',
    google: '/provider-icons/google.svg',
    xai: '/provider-icons/xai.svg',
    openrouter: '/provider-icons/openrouter.svg',
    cline: '/provider-icons/openrouter.svg',
    copilot: '/provider-icons/copilot.svg',
    groq: '/provider-icons/groq.svg',
    togetherai: '/provider-icons/togetherai.svg',
    opencodezen: '/provider-icons/opencodezen.svg',

    cloudflare: '/provider-icons/cloudflare.svg',
    vercel: '/provider-icons/vercel.svg',
    baseten: '/provider-icons/baseten.svg',
    helicone: '/provider-icons/helicone.svg',
    portkey: '/provider-icons/portkey.svg',

    cerebras: '/provider-icons/cerebras.svg',
    fireworks: '/provider-icons/fireworks.svg',
    deepinfra: '/provider-icons/deepinfra.svg',
    hyperbolic: '/provider-icons/hyperbolic.svg',
    ionet: '/provider-icons/ionet.svg',

    deepseek: '/provider-icons/deepseek.svg',
    moonshot: '/provider-icons/moonshot.svg',
    minimax: '/provider-icons/minimax.svg',
    nebius: '/provider-icons/nebius.svg',
    zai: '/provider-icons/zai.svg',
    cortecs: '/provider-icons/cortecs.svg',
    stepfun: '/provider-icons/stepfun.svg',

    huggingface: '/provider-icons/huggingface.svg',
    replicate: '/provider-icons/replicate.svg',
    modal: '/provider-icons/modal.svg',
    scaleway: '/provider-icons/scaleway.svg',
    venice: '/provider-icons/venice.svg',
    zenmux: '/provider-icons/zenmux.svg',
    firmware: '/provider-icons/firmware.svg',

    azure: '/provider-icons/azure.svg',
    azurecognitive: '/provider-icons/azurecognitive.svg',
    bedrock: '/provider-icons/bedrock.svg',
    vertexai: '/provider-icons/vertexai.svg',
    sapai: '/provider-icons/sapai.svg',
    stackit: '/provider-icons/stackit.svg',
    ovhcloud: '/provider-icons/ovhcloud.svg',

    local: '/provider-icons/local.svg',
    ollama: '/provider-icons/ollama.svg',
    ollamacloud: '/provider-icons/ollamacloud.svg',
    lmstudio: '/provider-icons/lmstudio.svg',
    llamacpp: '/provider-icons/llamacpp.svg',

    gitlab: '/provider-icons/gitlab.svg',
    codex: '/provider-icons/codex.svg',
    antigravity: '/provider-icons/antigravity.svg',
    chromeai: '/provider-icons/chromeai.svg',

    mistralai: '/provider-icons/mistralai.svg',
    cohere: '/provider-icons/cohere.svg',
    perplexity: '/provider-icons/perplexity.svg',
    luma: '/provider-icons/luma.svg',
    fal: '/provider-icons/fal.svg',

    elevenlabs: '/provider-icons/elevenlabs.svg',
    deepgram: '/provider-icons/deepgram.svg',
    gladia: '/provider-icons/gladia.svg',
    assemblyai: '/provider-icons/assemblyai.svg',
    lmnt: '/provider-icons/lmnt.svg',

    nvidia: '/provider-icons/nvidia.svg',
    nim: '/provider-icons/nvidia.svg',
    friendliai: '/provider-icons/friendliai.svg',
    friendli: '/provider-icons/friendliai.svg',
    voyageai: '/provider-icons/voyageai.svg',
    mixedbread: '/provider-icons/mixedbread.svg',
    mem0: '/provider-icons/mem0.svg',
    letta: '/provider-icons/letta.svg',
    blackforestlabs: '/provider-icons/blackforestlabs.svg',
    klingai: '/provider-icons/klingai.svg',
    prodia: '/provider-icons/prodia.svg',
    a302ai: '/provider-icons/a302ai.svg',
    qwen: '/provider-icons/qwen.svg',
    alibaba: '/provider-icons/alibaba.svg',
    'alibaba-cn': '/provider-icons/alibaba.svg',
    zhipuai: '/provider-icons/zhipuai.svg',
    modelscope: '/provider-icons/modelscope.svg',
    'moonshotai-cn': '/provider-icons/moonshot.svg',
    cloudflareworkers: '/provider-icons/cloudflare.svg',
    'novita-ai': '/provider-icons/novita-ai.svg',
    upstage: '/provider-icons/upstage.svg',
    siliconflow: '/provider-icons/siliconflow.svg',
    abacus: '/provider-icons/abacus.svg',
    llama: '/provider-icons/llama.svg',
    vultr: '/provider-icons/vultr.svg',
    wandb: '/provider-icons/wandb.svg',
    poe: '/provider-icons/poe.svg',
    'github-models': '/provider-icons/github-models.svg',
    requesty: '/provider-icons/requesty.svg',
    inference: '/provider-icons/inference.svg',
    submodel: '/provider-icons/submodel.svg',
    synthetic: '/provider-icons/synthetic.svg',
    moark: '/provider-icons/moark.svg',
    nova: '/provider-icons/nova.svg',
    // Fallbacks for missing icons
    v0: '/provider-icons/vercel.svg',
  };

  const themeAdaptive = new Set([
    'openai',
    'codex',
    'vercel',
    'ollama',
    'ollamacloud',
  ]);
  let loadError = $state(false);
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
    loading="lazy"
    decoding="async"
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
