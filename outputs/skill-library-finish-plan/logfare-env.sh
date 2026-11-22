# Source this to make every Koryphaios skill campaign run on the logfare
# provider with the deepseek model instead of the Codex CLI:
#   source outputs/skill-library-finish-plan/logfare-env.sh
# The key is read from the project config at source time, never stored here.
export KORY_SKILL_EVAL_LOGFARE_API_KEY="$(bun -e 'const c=require("./config.json");process.stdout.write(c.provider?.logfare?.options?.apiKey??"")')"
export KORY_SKILL_EVAL_LOGFARE_MODEL="${KORY_SKILL_EVAL_LOGFARE_MODEL:-deepseek-v4.1-flash-1017}"
export KORY_SKILL_V5_EXECUTOR=logfare-text-patch
