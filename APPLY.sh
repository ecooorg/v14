#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
fail=0
grep -q 'buildSimpleConversationPrompt' server/promptPacks.ts && echo OK packs || { echo FAIL packs; fail=1; }
grep -q 'Simple Mode: a calm, direct assistant' server/promptPacks.ts && echo OK simple || { echo FAIL simple; fail=1; }
grep -q 'EXPERT_STEP_PREFIX' server.ts && echo OK expert || { echo FAIL expert; fail=1; }
grep -q 'Project Mode (project analyst)' server/contextBuilder.ts && echo OK project || { echo FAIL project; fail=1; }
grep -q 'userForbadeMethodology' server/intentFlags.ts && echo OK intent || { echo FAIL intent; fail=1; }
exit $fail
