#!/usr/bin/env bash
# Lists submissions from DynamoDB.
#
#   ./scripts/submissions.sh            # waiting on you
#   ./scripts/submissions.sh live       # photographs and stories already up
#   ./scripts/submissions.sh removed    # taken down
#   ./scripts/submissions.sh all        # everything, including old versions
#
# Every version of a life story is kept, so `all` is also the history: an
# earlier story for someone is still here after a newer one supersedes it.

set -euo pipefail
cd "$(dirname "$0")/.."

[[ -f .deploy.env ]] && source .deploy.env
STACK="${STACK:-deguise-tree}"
REGION="${REGION:-ap-southeast-2}"
MODE="${1:-pending}"

ARGS=(--table-name "${STACK}-submissions" --region "$REGION" --no-cli-pager)
if [[ "$MODE" != "all" ]]; then
  ARGS+=(--filter-expression "#s = :p"
         --expression-attribute-names '{"#s":"status"}'
         --expression-attribute-values "{\":p\":{\"S\":\"$MODE\"}}")
fi

aws dynamodb scan "${ARGS[@]}" \
  --query 'Items[].{when:createdAt.S,status:status.S,kind:kind.S,about:personName.S,from:submitterName.S,email:submitterEmail.S,adding:newPersonName.S,id:id.S}' \
  --output table
