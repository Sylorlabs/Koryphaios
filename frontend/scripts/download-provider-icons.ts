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
  'unorouter',
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
  'hoplite',
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
  'commandcode',
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
    if (p === 'hoplite') {
      try {
        const res = await fetch('https://app.hoplite.sh/branding/mark-compact.svg');
        if (res.ok) {
          const raw = await res.text();
          // The official compact asset ships the mark plus a © lockup. Provider
          // icons render at 20–24px, where the © is illegible, so keep the mark
          // path only and re-wrap it with a currentColor fill.
          const pathData = raw.match(/<path d="([^"]+)"/)?.[1];
          if (pathData) {
            const body =
              '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 179" role="img" aria-label="Hoplite">\n' +
              `  <path fill="currentColor" d="${pathData}"/>\n` +
              '</svg>\n';
            await fs.writeFile(targetPath, body);
            await fs.writeFile(
              path.join(OUT_DIR, 'hoplite-color.svg'),
              body.replace('fill="currentColor"', 'fill="#FF3616"'),
            );
            console.log(`Downloaded icon for ${p}`);
            continue;
          }
        }
      } catch {
        /* fall through to placeholder */
      }
    }

    if (p === 'commandcode') {
      try {
        // Command Code publishes its official logomark in its own repository.
        // It is a fixed two-colour mark (black rounded square + white command
        // glyph), so it ships only as the -color variant: treating it as a
        // theme-adaptive monochrome asset would invert the square to white on
        // dark backgrounds and erase the glyph.
        const res = await fetch(
          'https://raw.githubusercontent.com/CommandCodeAI/command-code/main/.github/commandcode/symbols/symbol.svg',
        );
        if (res.ok) {
          await fs.writeFile(path.join(OUT_DIR, 'commandcode-color.svg'), await res.text());
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
