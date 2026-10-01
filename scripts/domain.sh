#!/usr/bin/env bash
# Put the site on guisefamilytree.com, start to finish.
#
#   bash scripts/domain.sh
#
# It requests the certificate, tells you which DNS records to add, waits while
# you add them, then rebuilds the stack on the domain and deploys. Nothing in
# here has to be copied out of a chat window.
#
# Optional — if you export a Cloudflare API token with Zone:Read and DNS:Edit
# on this zone, it adds the records for you and you never open the dashboard:
#
#   export CF_API_TOKEN=...        # typed by you, never shared with anyone
#   bash scripts/domain.sh
#
# Written for the bash that ships with macOS (3.2), so no mapfile, no fancy
# parameter expansion.

set -euo pipefail
cd "$(dirname "$0")/.."

APEX="guisefamilytree.com"
SUB="www"
FQDN_WWW="${SUB}.${APEX}"
CERT_REGION="us-east-1"

[ -f .deploy.env ] && . .deploy.env
STACK="${STACK:-deguise-tree}"
REGION="${REGION:-ap-southeast-2}"

bold() { printf '\n\033[1m%s\033[0m\n' "$*"; }
dim()  { printf '\033[2m%s\033[0m\n' "$*"; }
die()  { printf '\n\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

command -v aws  >/dev/null || die "The AWS CLI is not installed."
command -v node >/dev/null || die "Node is not installed."

ADMIN_EMAIL="$(sed -n 's/^VITE_ADMIN_EMAIL=//p' .env 2>/dev/null | head -1 || true)"
# A placeholder left in .env by an earlier run must not be carried forward —
# it would silently send every notification into the void.
case "$(printf '%s' "$ADMIN_EMAIL" | tr '[:upper:]' '[:lower:]')" in
  '' | your@email.com | you@example.com | *your*email* | *example.com)
    printf '\n  Which address should submissions be emailed to? '
    read -r ADMIN_EMAIL < /dev/tty ;;
esac
case "$ADMIN_EMAIL" in
  *@*.*) : ;;
  *) die "\"$ADMIN_EMAIL\" does not look like an email address." ;;
esac

# ------------------------------------------------------------- certificate ---

bold "1/6  Clearing any half-made certificates for ${APEX}"

aws acm list-certificates --region "$CERT_REGION" \
  --query "CertificateSummaryList[?DomainName=='${APEX}'].CertificateArn" \
  --output text | tr '\t' '\n' > /tmp/gft-old-certs.txt || true

while IFS= read -r arn; do
  [ -n "$arn" ] || continue
  if aws acm delete-certificate --certificate-arn "$arn" --region "$CERT_REGION" 2>/dev/null; then
    dim "     binned  $arn"
  else
    dim "     in use, left alone  $arn"
  fi
done < /tmp/gft-old-certs.txt

bold "2/6  Requesting a certificate for ${APEX} and ${FQDN_WWW}"

CERT="$(aws acm request-certificate \
  --domain-name "$APEX" \
  --subject-alternative-names "$FQDN_WWW" \
  --validation-method DNS \
  --region "$CERT_REGION" \
  --query CertificateArn --output text)"
dim "     $CERT"

COVERS="$(aws acm describe-certificate --certificate-arn "$CERT" --region "$CERT_REGION" \
  --query 'Certificate.SubjectAlternativeNames' --output text | tr '\t' ' ')"
printf '     covers: %s\n' "$COVERS"
case "$COVERS" in
  *'['* | *'http'* ) die "The certificate names came out malformed: $COVERS" ;;
esac

grep -q '^CERT=' .deploy.env 2>/dev/null \
  && sed -i '' "s|^CERT=.*|CERT=${CERT}|" .deploy.env \
  || echo "CERT=${CERT}" >> .deploy.env

# The validation records appear a moment after the request.
attempt=0
while [ "$attempt" -lt 8 ]; do
  aws acm describe-certificate --certificate-arn "$CERT" --region "$CERT_REGION" \
    --query 'Certificate.DomainValidationOptions[].ResourceRecord' \
    --output json > /tmp/gft-acm.json
  if ! grep -q 'null' /tmp/gft-acm.json && grep -q 'Name' /tmp/gft-acm.json; then break; fi
  attempt=$((attempt + 1))
  sleep 3
done
grep -q 'Name' /tmp/gft-acm.json || die "ACM has not produced validation records yet. Rerun in a minute."

# Cloudflare wants the host without the zone suffix and without a trailing dot.
node -e '
  const fs = require("fs");
  const apex = process.argv[1];
  const rows = JSON.parse(fs.readFileSync("/tmp/gft-acm.json", "utf8"));
  const trim = (s) => s.replace(/\.$/, "");
  for (const r of rows) {
    const host = trim(r.Name).replace("." + apex, "");
    process.stdout.write(host + "\t" + trim(r.Value) + "\n");
  }
' "$APEX" > /tmp/gft-records.tsv

DIST_DOMAIN="$(aws cloudformation describe-stacks --stack-name "$STACK" --region "$REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='CloudFrontDomain'].OutputValue" --output text)"
[ -n "$DIST_DOMAIN" ] || die "Could not read the CloudFront domain from stack ${STACK}."

# ------------------------------------------------------------------- dns ----

cf_add() { # type host content
  curl -sS -X POST "https://api.cloudflare.com/client/v4/zones/${ZONE}/dns_records" \
    -H "Authorization: Bearer ${CF_API_TOKEN}" \
    -H "Content-Type: application/json" \
    --data "{\"type\":\"$1\",\"name\":\"$2\",\"content\":\"$3\",\"ttl\":1,\"proxied\":false}" \
    > /tmp/gft-cf.json || true
  node -e '
    const fs = require("fs");
    let o = {};
    try { o = JSON.parse(fs.readFileSync("/tmp/gft-cf.json", "utf8")); } catch (e) {}
    const host = process.argv[1];
    if (o.success) { console.log("     added   " + host); return; }
    const msg = (o.errors || []).map((e) => e.message).join("; ") || "unknown error";
    if (/already exists|identical/i.test(msg)) console.log("     present " + host);
    else console.log("     FAILED  " + host + " — " + msg);
  ' "$2"
}

if [ -n "${CF_API_TOKEN:-}" ]; then
  bold "3/6  Adding the DNS records in Cloudflare for you"
  curl -sS "https://api.cloudflare.com/client/v4/zones?name=${APEX}" \
    -H "Authorization: Bearer ${CF_API_TOKEN}" > /tmp/gft-zone.json
  ZONE="$(node -e '
    const fs = require("fs");
    const o = JSON.parse(fs.readFileSync("/tmp/gft-zone.json", "utf8"));
    process.stdout.write((o.result && o.result[0] && o.result[0].id) || "");
  ')"
  [ -n "$ZONE" ] || die "Could not find the zone. Does that token have Zone:Read and DNS:Edit on ${APEX}?"

  while IFS="$(printf '\t')" read -r host value; do
    [ -n "$host" ] && cf_add CNAME "$host" "$value"
  done < /tmp/gft-records.tsv
  cf_add CNAME "$APEX" "$DIST_DOMAIN"
  cf_add CNAME "$SUB"  "$DIST_DOMAIN"
else
  bold "3/6  Add these records in Cloudflare, then come back here"
  cat <<BANNER

  dash.cloudflare.com  ->  ${APEX}  ->  DNS  ->  Records  ->  Add record

  Every one of them: Proxy status must be DNS only — the GREY cloud.
  Cloudflare adds the domain to the name itself, so paste the name exactly
  as printed below.

BANNER
  while IFS="$(printf '\t')" read -r host value; do
    [ -n "$host" ] && printf '  CNAME  %s\n         -> %s\n\n' "$host" "$value"
  done < /tmp/gft-records.tsv
  printf '  CNAME  %s\n         -> %s\n\n' "$APEX" "$DIST_DOMAIN"
  printf '  CNAME  %s\n         -> %s\n\n' "$SUB" "$DIST_DOMAIN"
  printf '  Press RETURN when all of them are in. '
  read -r _
fi

# -------------------------------------------------------------- validate ----

bold "4/6  Waiting for the certificate to validate"
dim  "     Usually a couple of minutes. Ctrl-C is safe — just rerun the script."

STATUS=""
attempt=0
while [ "$attempt" -lt 60 ]; do
  STATUS="$(aws acm describe-certificate --certificate-arn "$CERT" --region "$CERT_REGION" \
    --query 'Certificate.Status' --output text)"
  [ "$STATUS" = "ISSUED" ] && break
  if [ "$STATUS" = "FAILED" ] || [ "$STATUS" = "VALIDATION_TIMED_OUT" ]; then
    die "Validation came back $STATUS. The CNAME is wrong, or it is still on the orange cloud."
  fi
  printf '     %s  (check %s)\r' "$STATUS" "$attempt"
  attempt=$((attempt + 1))
  sleep 15
done
[ "$STATUS" = "ISSUED" ] || die "Still $STATUS after fifteen minutes. Check the records and rerun."
printf '     ISSUED                              \n'

# ------------------------------------------------------------------ ship ----

bold "5/6  Rebuilding the stack on ${APEX}"
dim  "     CloudFront takes a few minutes to take on a new domain."

DOMAIN_NAME="$APEX" ACM_CERT_ARN="$CERT" \
  ./scripts/bootstrap.sh "$ADMIN_EMAIL" "$REGION" "$STACK"

bold "6/6  Deploying"
./scripts/deploy.sh

bold "Done"
cat <<DONE

  https://${APEX}
  https://${FQDN_WWW}

  The old CloudFront address keeps working, so any link you have already sent
  out still resolves.

  DNS can take a few minutes to reach you even after this finishes. If the
  domain does not answer straight away, give it five minutes.

DONE
