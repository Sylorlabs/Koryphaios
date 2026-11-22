#!/bin/bash
# usage: stage-blind.sh <skill> <campaign-json-log>
set -e
cd /Users/Shared/micah/Documents/koryphaios
skill="$1"; log="$2"
bun -e '
const fs=require("fs"),path=require("path");
const skill=process.argv[1], log=process.argv[2];
const s=fs.readFileSync(log,"utf8");
const i=s.lastIndexOf("\n{");
const obj=JSON.parse(i>=0?s.slice(i):s);
if(!obj.stagedReviews||!obj.stagedReviews.length){console.log("NO_STAGED_REVIEW");process.exit(0);}
for(const r of obj.stagedReviews){
  const dir=path.dirname(r.envelopePath);
  const out=path.join("outputs/skill-v5-staged/blind",`${skill}-${r.assignmentId}`);
  fs.mkdirSync(out,{recursive:true});
  for(const f of fs.readdirSync(dir)){
    fs.copyFileSync(path.join(dir,f),path.join(out,f));
    fs.chmodSync(path.join(out,f),0o644);
  }
  const env=JSON.parse(fs.readFileSync(path.join(out,"import.json"),"utf8"));
  const att=JSON.parse(fs.readFileSync(path.join(out,"review-attestation.json"),"utf8"));
  let verdict={};
  try{
    const out0=env.reviews[0].output;
    const parsed=JSON.parse(out0);
    const a=parsed.artifactA||{}, b=parsed.artifactB||{};
    verdict={artifactA:{passed:a.passed,quality:a.quality,verification:a.verification},artifactB:{passed:b.passed,quality:b.quality,verification:b.verification},preference:parsed.preference};
  }catch(e){verdict={parseError:String(e)};}
  fs.writeFileSync(path.join(out,"README.md"),[
    `# Staged blind review: ${skill}`,
    "",
    "Status: staged, not ingested. Ledger persistence belongs to the coordinator.",
    "",
    `- assignmentId: ${att.assignmentId}`,
    `- skill: ${att.skill}`,
    `- scenarioId: ${att.scenarioId}`,
    `- pairId: ${att.pairId}`,
    `- reviewerAdapter: ${att.reviewerAdapter}`,
    `- reviewerModel: ${att.reviewerModel}`,
    `- reviewerThread: ${att.reviewerThread}`,
    `- verdict: ${JSON.stringify(verdict)}`,
    `- producer: scripts/run-skill-v5-blind-review-campaign.ts --skill=${skill} --concurrency=1`,
    `- produced: ${new Date().toISOString()}`,
    "",
    "Files: `import.json` (envelope the importer consumes), `review-attestation.json`,",
    "`reviewer-events.json`, `review-task.prompt.txt` (sealed prompt snapshot), and the",
    "completing reviewer result text.",
    "",
    "The reviewer route reports identity and isolation as unverified by design",
    "(`stageOnlyAttemptAllowed`). Coordinator qualification is required before ingestion.",
    "",
  ].join("\n"));
  console.log("STAGED",out,JSON.stringify(verdict));
}
' "$skill" "$log"
