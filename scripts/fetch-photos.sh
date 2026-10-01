#!/usr/bin/env bash
# Downloads every photograph people have contributed but you haven't approved.
#
#   ./scripts/fetch-photos.sh
#
# They land in public/photos/pending/ with the submission id and the person's
# name in the filename, so you can see at a glance who each one belongs to.
# Approve one by moving it up into public/photos/ and adding it to that
# person's "photos" array in src/data/tree.json.

set -euo pipefail
cd "$(dirname "$0")/.."

[[ -f .deploy.env ]] && source .deploy.env
STACK="${STACK:-deguise-tree}"
REGION="${REGION:-ap-southeast-2}"
DEST="public/photos/pending"

out() {
  aws cloudformation describe-stacks \
    --stack-name "$STACK" --region "$REGION" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text
}

BUCKET="$(out UploadsBucketName)"
mkdir -p "$DEST"

echo "==> Pending photographs in ${STACK}-submissions"
mapfile -t ROWS < <(
  aws dynamodb scan \
    --table-name "${STACK}-submissions" \
    --region "$REGION" \
    --filter-expression "#s = :p AND #k = :photo" \
    --expression-attribute-names '{"#s":"status","#k":"kind"}' \
    --expression-attribute-values '{":p":{"S":"pending"},":photo":{"S":"photo"}}' \
    --query 'Items[].[id.S,personName.S,storageKey.S]' \
    --output text --no-cli-pager
)

if [[ ${#ROWS[@]} -eq 0 ]]; then
  echo "    Nothing waiting."
  exit 0
fi

for row in "${ROWS[@]}"; do
  IFS=$'\t' read -r ID PERSON KEY <<<"$row"
  [[ -z "${KEY:-}" || "$KEY" == "None" ]] && continue
  SLUG="$(printf '%s' "$PERSON" | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9' '-' | sed 's/^-//;s/-$//')"
  EXT="${KEY##*.}"
  OUT="$DEST/${SLUG}--${ID:0:8}.${EXT}"
  if [[ -f "$OUT" ]]; then
    echo "    have  $OUT"
  else
    aws s3 cp "s3://$BUCKET/$KEY" "$OUT" --region "$REGION" --only-show-errors
    echo "    got   $OUT"
  fi
done

echo
echo "Look through $DEST, then for each one you accept:"
echo "  1. mv it into public/photos/"
echo "  2. add { \"src\": \"/photos/<file>\", \"caption\": \"…\" } to that person in src/data/tree.json"
echo "  3. ./scripts/deploy.sh"
