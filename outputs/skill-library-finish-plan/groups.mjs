import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const rows = JSON.parse(readFileSync(new URL('./rows.json', import.meta.url), 'utf8'));
const status = new Map(rows.map((row) => [row.s, row]));

const GROUPS = {
  'A-language-runtimes': ['typescript-javascript-engineering','nodejs-runtime','bun-deno-runtime','python-engineering','ruby-engineering','php-engineering','go-engineering','csharp-dotnet-engineering','java-jvm-engineering','kotlin-engineering','c-cpp-systems-engineering','rust-engineering','swift-engineering','compiler-runtime-backend','shell-cli-engineering'],
  'B-backend-and-apis': ['backend-engineering','http-rest-engineering','graphql-engineering','grpc-protobuf','api-contract-design','in-process-backend','local-service-backend','network-service-backend','distributed-backend','event-driven-architecture','realtime-systems','stream-processing','webhook-integration','payment-integration'],
  'C-data-stores-and-search': ['postgres-engineering','mysql-engineering','mongodb-engineering','redis-engineering','sqlite-engineering','database-performance','relational-data-modeling','data-pipeline-engineering','analytics-engineering','data-analysis','exploratory-data-analysis','data-visualization','statistical-inference','experimental-analysis','experimentation-ab-testing','operational-data-analysis','embedding-systems','vector-search-systems','search-indexing'],
  'D-frontend-and-interfaces': ['react-engineering','nextjs-engineering','vue-engineering','svelte-engineering','angular-engineering','web-interface','visual-interface-design','interaction-design','information-architecture','accessibility-practice','accessibility-verification','novel-ui-toolkit','three-d-graphics','terminal-interface','human-experience','usability-evaluation','visual-verification','content-error-design','frontend-engineering','interface-usability-testing','user-research'],
  'E-native-mobile-and-devices': ['ios-swiftui','android-compose','react-native-expo','desktop-electron-tauri','computer-use','embedded-firmware','embedded-interface','embedded-device-security','robotics-control','simulation-device-testing','hardware-runtime-debugging','gpu-compute','native-interface','game-development','game-spatial-interface'],
  'F-security-and-crypto': ['application-security','security-review','security-verification','web-security','infrastructure-security','cloud-security','language-runtime-security','supply-chain-security','secrets-key-management','secure-authentication','authorization-security','oauth-oidc','privacy-engineering','applied-cryptography','threat-modeling-practice','ai-safety-evaluation'],
  'G-cloud-and-operations': ['aws-cloud','gcp-cloud','azure-cloud','terraform-iac','serverless-platforms','edge-cdn','cicd-engineering','observability-sre','incident-response','reliability-verification','finops-cloud-cost','email-delivery','networking-systems','linux-systems','container-engineering','kubernetes-operations'],
  'H-agentic-and-llm': ['llm-application-engineering','agentic-systems','prompt-context-engineering','rag-retrieval-systems','llm-evaluation','ml-evaluation','fine-tuning-training','mlops','recommendation-ranking','computer-vision','speech-audio-ai','image-generation-practice','video-production','audio-production'],
  'I-verification-and-debugging': ['debugging','deterministic-debugging','distributed-debugging','concurrency-debugging','performance-debugging','property-fuzz-differential-testing','deterministic-contract-testing','testing-engineering','integration-fault-testing','performance-testing','performance-verification','functional-verification','verification','release-planning','migration-planning'],
  'J-architecture-and-research': ['architecture-planning','planning','feature-implementation','refactor-implementation','implementation','integration-implementation','developer-experience','repository-environment-discovery','repository-research','research','literature-research','factual-research','market-competitive-research'],
  'K-product-and-business': ['product-management','product-analytics','project-program-management','business-case-analysis','procurement-vendor-evaluation','pricing-monetization','startup-operations','market-strategy','marketing-strategy','sales-engineering','customer-success','growth-engineering','financial-modeling','contract-analysis','documents-communication','executive-communication','technical-communication','reference-communication','instructional-communication','response-style'],
  'L-skill-system-and-routing': ['skill-authoring-evaluation','task-routing','dash-free-writing','plan-mode'],
};

const assigned = new Set();
const duplicates = [];
for (const [group, skills] of Object.entries(GROUPS)) {
  for (const skill of skills) {
    if (assigned.has(skill)) duplicates.push(`${skill} in ${group}`);
    assigned.add(skill);
  }
}
const missing = rows.map((row) => row.s).filter((skill) => !assigned.has(skill));
const unknown = [...assigned].filter((skill) => !status.has(skill));

console.log(JSON.stringify({ groups: Object.keys(GROUPS).length, assigned: assigned.size, catalog: rows.length, missing, unknown, duplicates }, null, 2));

mkdirSync(new URL('./briefs', import.meta.url), { recursive: true });
writeFileSync(new URL('./groups.json', import.meta.url), JSON.stringify(GROUPS, null, 2) + '\n');
for (const [group, skills] of Object.entries(GROUPS)) {
  const lines = skills.map((skill) => {
    const row = status.get(skill);
    return `- ${skill} [${row.st}] ${row.l}`;
  });
  writeFileSync(new URL(`./briefs/${group}.status.txt`, import.meta.url), lines.join('\n') + '\n');
}
