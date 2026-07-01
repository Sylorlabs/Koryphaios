import fs from 'fs/promises';
import path from 'path';
import * as simpleIcons from 'simple-icons';

/**
 * download-provider-icons.ts
 * Refactored to prioritize @lobehub/icons-static-svg via CDN or local module.
 * This script now only downloads icons NOT found in LobeHub or when manual overrides are needed.
 */

const OUT_DIR = path.resolve('static/provider-icons');

const providers = [
  'anthropic',
  'openai',
  'google',
  'xai',
  'openrouter',
  'groq',
  'copilot',
  'azure',
  'bedrock',
  'vertexai',
  'local',
  'ollama',
  'ollamacloud',
  'llamacpp',
  'lmstudio',
  'deepseek',
  'togetherai',
  'cerebras',
  'fireworks',
  'huggingface',
  'deepinfra',
  'minimax',
  'moonshot',
  'zai',
  'stepfun',
  'qwen',
  'baichuan',
  'zhipuai',
  'replicate',
  'modal',
  'vercel',
  'cloudflare',
  'baseten',
  'helicone',
  'portkey',
  'scaleway',
  'ovhcloud',
  'stackit',
  'nebius',
  'togetherai',
  'venice',
  'zenmux',
  'opencodezen',
  'opencodego',
  'firmware',
  '302ai',
  'mistralai',
  'claude',
  'codex',
  'jules',
  'mistral',
  'cohere',
  'perplexity',
  'luma',
  'fal',
  'elevenlabs',
  'assemblyai',
  'deepgram',
  'gladia',
  'lmnt',
  'azurecognitive',
  'sapai',
  'gitlab',
  'nvidia',
  'nim',
  'friendliai',
  'voyageai',
  'mixedbread',
  'mem0',
  'letta',
  'chromeai',
  'requesty',
  'aihubmix',
  'aimlapi',
  'blackforestlabs',
  'klingai',
  'prodia',
  'novita',
  'upstage',
  'v0',
  'siliconflow',
  'abacus',
  'llama',
  'vultr',
  'wandb',
  'poe',
  'github-models',
  'submodel',
  'synthetic',
  'moark',
  'nova',
  'banbri',
];

// SimpleIcons mapping for providers not in LobeHub or where SimpleIcons is preferred
const simpleIconsMap: Record<string, string> = {
  xai: 'siX',
  copilot: 'siGithubcopilot',
  azure: 'siMicrosoftazure',
  bedrock: 'siAmazonaws',
  vertexai: 'siGooglecloud',
  cloudflare: 'siCloudflare',
  huggingface: 'siHuggingface',
  replicate: 'siReplicate',
  vercel: 'siVercel',
  scaleway: 'siScaleway',
  ovhcloud: 'siOvh',
  togetherai: 'siTogether',
  elevenlabs: 'siElevenlabs',
  assemblyai: 'siAssemblyai',
  deepgram: 'siDeepgram',
  gitlab: 'siGitlab',
  nvidia: 'siNvidia',
  qwen: 'siAlibaba',
  alibaba: 'siAlibabacloud',
  chromeai: 'siGooglechrome',
  modal: 'siModal',
  baseten: 'siBaseten',
  friendliai: 'siFriendli',
  voyageai: 'siVoyage',
  mixedbread: 'siMixedbread',
  mem0: 'siMem0',
  letta: 'siLetta',
  aihubmix: 'siAihub',
  aimlapi: 'siAiml',
  blackforestlabs: 'siBlackforestlabs',
  prodia: 'siProdia',
  banbri: 'siBanbri',
  cerebras: 'siCerebras',
  stepfun: 'siStepfun',
  zai: 'siZai',
  azurecognitive: 'siMicrosoftazure',
  sapai: 'siSap',
  ionet: 'siIo',
  helicone: 'siHelicone',
  portkey: 'siPortkey',
  stackit: 'siStackit',
  venice: 'siVenice',
  opencodezen: 'siOpencode',
  opencodego: 'siOpencode',
  firmware: 'siFirmware',
  '302ai': 'si302',
  gladia: 'siGladia',
  lmnt: 'siLmnt',
  nim: 'siNvidia',
  requesty: 'siRequesty',
  klingai: 'siKuaishou',
};

async function run() {
  await fs.mkdir(OUT_DIR, { recursive: true });

  for (const p of providers) {
    const targetPath = path.join(OUT_DIR, `${p}.svg`);

    // Skip if exists
    try {
      await fs.access(targetPath);
      continue;
    } catch {
      // Not found, download it
    }

    let svg = '';
    if (p === 'jules') {
      try {
        const res = await fetch(
          'https://raw.githubusercontent.com/homarr-labs/dashboard-icons/main/svg/google-jules.svg',
        );
        if (res.ok) {
          svg = await res.text();
          await fs.writeFile(targetPath, svg);
          await fs.writeFile(path.join(OUT_DIR, 'jules-color.svg'), svg);
          console.log(`Downloaded icon for ${p}`);
          continue;
        }
      } catch {
        /* fall through to placeholder */
      }
    }

    const siKey = simpleIconsMap[p];

    if (siKey) {
      const si = (simpleIcons as any)[siKey];
      if (si) {
        svg = si.svg.replace('<svg ', `<svg fill="currentColor" `);
      }
    }

    if (svg) {
      console.log(`Downloaded icon for ${p}`);
      await fs.writeFile(targetPath, svg);
    } else {
      // Placeholder for truly missing icons
      const placeholder = `<svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><rect width="20" height="20" x="2" y="2" rx="5" ry="5"></rect><path d="M12 12h.01"></path><path d="M8 12h.01"></path><path d="M16 12h.01"></path></svg>`;
      await fs.writeFile(targetPath, placeholder);
    }
  }
}

run();
