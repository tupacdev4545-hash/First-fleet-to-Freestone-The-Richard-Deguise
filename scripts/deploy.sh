#!/usr/bin/env bash
# Builds the site, ships the Lambda code, syncs S3 and invalidates CloudFront.
#
#   ./scripts/deploy.sh            # uses .deploy.env written by bootstrap.sh
#   STACK=deguise-tree REGION=ap-southeast-2 ./scripts/deploy.sh

set -euo pipefail
cd "$(dirname "$0")/.."

[[ -f .deploy.env ]] && source .deploy.env
STACK="${STACK:-deguise-tree}"
REGION="${REGION:-ap-southeast-2}"

out() {
  aws cloudformation describe-stacks \
    --stack-name "$STACK" --region "$REGION" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" \
    --output text
}

BUCKET="$(out SiteBucketName)"
DIST_ID="$(out DistributionId)"
SITE_URL="$(out SiteUrl)"

echo "==> Packaging Lambda"
rm -f /tmp/submit.zip
(cd api && zip -qr /tmp/submit.zip index.mjs)
# The record rides along so the API can count existing photographs and check
# where a new relative can hang.
zip -qj /tmp/submit.zip src/data/tree.json
aws lambda update-function-code \
  --function-name "${STACK}-submit" \
  --zip-file fileb:///tmp/submit.zip \
  --region "$REGION" \
  --no-cli-pager >/dev/null
aws lambda wait function-updated \
  --function-name "${STACK}-submit" --region "$REGION"

echo "==> Building site"
npm run build

echo "==> Uploading to s3://$BUCKET"
# Fingerprinted assets can be cached forever.
#
# The two exclusions below matter more than they look. `--delete` removes
# anything in the bucket that is not in dist/, and what the family has
# published lives only in the bucket: the photographs under photos/live/ and
# the index of photographs and life stories in gallery.json. Without these,
# every deploy would quietly wipe every contribution since the last one.
aws s3 sync dist/ "s3://$BUCKET/" \
  --region "$REGION" \
  --delete \
  --exclude "index.html" \
  --exclude "gallery.json" \
  --exclude "photos/live/*" \
  --cache-control "public,max-age=31536000,immutable"
# The entry point must never be cached.
aws s3 cp dist/index.html "s3://$BUCKET/index.html" \
  --region "$REGION" \
  --cache-control "no-cache,no-store,must-revalidate" \
  --content-type "text/html; charset=utf-8"

echo "==> Invalidating CloudFront"
aws cloudfront create-invalidation \
  --distribution-id "$DIST_ID" \
  --paths "/index.html" "/" \
  --no-cli-pager >/dev/null

echo
echo "Live at $SITE_URL"
