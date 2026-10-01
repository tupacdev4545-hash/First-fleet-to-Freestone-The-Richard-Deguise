#!/usr/bin/env bash
# Emails the archivist a fresh "Add to the tree" button for every person still
# waiting — including ones sent before the button existed.
#
#   ./scripts/resend-pending.sh

set -euo pipefail
cd "$(dirname "$0")/.."

[[ -f .deploy.env ]] && source .deploy.env
STACK="${STACK:-deguise-tree}"
REGION="${REGION:-ap-southeast-2}"

aws lambda invoke \
  --function-name "${STACK}-submit" \
  --region "$REGION" \
  --cli-binary-format raw-in-base64-out \
  --payload '{"source":"deguise.resend-pending"}' \
  --no-cli-pager \
  /tmp/resend-pending.json >/dev/null

echo "Sent: $(cat /tmp/resend-pending.json)"
