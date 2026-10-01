#!/usr/bin/env bash
# One-time setup: creates the AWS stack and writes .env for the front end.
#
#   ./scripts/bootstrap.sh you@example.com [ap-southeast-2] [deguise-tree]
#
# You will be asked for the family passcode. It is typed in, not passed as an
# argument, so it never lands in your shell history. On a stack that already
# exists you can press Enter to keep the passcode it has.
#
# The custom domain looks after itself. The script remembers it in .deploy.env,
# reads it back off the stack, and failing both goes looking in ACM for an
# issued certificate. You should never have to pass it by hand — but you can:
#
#   DOMAIN_NAME=guisefamilytree.com \
#   ACM_CERT_ARN=arn:aws:acm:us-east-1:...:certificate/... \
#   ./scripts/bootstrap.sh you@example.com

set -euo pipefail

ADMIN_EMAIL="${1:-}"
REGION_ARG="${2:-}"
STACK_ARG="${3:-}"

cd "$(dirname "$0")/.."

# What the caller asked for on the command line, captured before any file is
# sourced — otherwise a remembered value would be indistinguishable from a
# deliberate one, and a mistake written into .deploy.env would outlive itself.
DOMAIN_OVERRIDE="${DOMAIN_NAME:-}"
CERT_OVERRIDE="${ACM_CERT_ARN:-}"

# The domain this site belongs on. Declared, not discovered, because an AWS
# account holds other projects whose domains must never be picked up here.
# shellcheck disable=SC1091
[[ -f infra/site.env ]] && source infra/site.env
SITE_DOMAIN="${SITE_DOMAIN:-}"

# Anything remembered from last time — STACK, REGION, CERT.
# shellcheck disable=SC1091
[[ -f .deploy.env ]] && source .deploy.env

REGION="${REGION_ARG:-${REGION:-ap-southeast-2}}"
STACK="${STACK_ARG:-${STACK:-deguise-tree}}"
FAMILY_PASSCODE="${FAMILY_PASSCODE:-}"
CERT_REGION="us-east-1"

# Precedence, highest first: the command line, then this repo's declaration,
# then whatever was remembered. The remembered domain is deliberately last.
DOMAIN_NAME="${DOMAIN_OVERRIDE:-${SITE_DOMAIN:-${DOMAIN_NAME:-}}}"
ACM_CERT_ARN="${CERT_OVERRIDE:-${CERT:-}}"

die() { printf '\n\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

# ------------------------------------------------------------------ email ----
# A placeholder here is silent and expensive: every notification email goes
# nowhere and you never find out. Refuse the obvious ones outright.

[[ -n "$ADMIN_EMAIL" ]] || die "Usage: $0 <admin-email> [region] [stack-name]"

case "$(printf '%s' "$ADMIN_EMAIL" | tr '[:upper:]' '[:lower:]')" in
  your@email.com | you@example.com | *your*email* | *example.com | *@email.com)
    die "\"$ADMIN_EMAIL\" is a placeholder, not your address.

Rerun it with the real one — that is where every photograph, story and
take-down link gets sent:

  ./scripts/bootstrap.sh yourname@gmail.com"
    ;;
esac
[[ "$ADMIN_EMAIL" == *@*.* ]] || die "\"$ADMIN_EMAIL\" does not look like an email address."

# ----------------------------------------------------------------- domain ----
# This site's domain is declared in infra/site.env, and that declaration wins
# over anything remembered in .deploy.env or read back off the stack. Those can
# be wrong — a bad earlier run writes its mistake into both — and an AWS
# account contains other projects whose domains must never be picked up here.

stack_param() {
  aws cloudformation describe-stacks --stack-name "$STACK" --region "$REGION" \
    --query "Stacks[0].Parameters[?ParameterKey=='$1'].ParameterValue" \
    --output text 2>/dev/null | sed 's/^None$//'
}

cert_domain() { # arn -> the domain that certificate is actually for
  aws acm describe-certificate --certificate-arn "$1" --region "$CERT_REGION" \
    --query 'Certificate.DomainName' --output text 2>/dev/null |
    sed 's/^None$//'
}

STACK_EXISTS=no
LIVE_DOMAIN=""
if aws cloudformation describe-stacks --stack-name "$STACK" --region "$REGION" \
     >/dev/null 2>&1; then
  STACK_EXISTS=yes
  LIVE_DOMAIN="$(stack_param DomainName)"
fi

if [[ "$STACK_EXISTS" == yes && -n "$LIVE_DOMAIN" && "$LIVE_DOMAIN" != "$DOMAIN_NAME" ]]; then
  echo "==> The stack is currently on ${LIVE_DOMAIN}; moving it back to ${DOMAIN_NAME}"
fi

# A remembered certificate is only usable if it is for our domain. Anything
# else is left over from a mistake — drop it and go find the right one.
if [[ -n "$ACM_CERT_ARN" && -n "$DOMAIN_NAME" ]]; then
  HELD="$(cert_domain "$ACM_CERT_ARN")"
  if [[ -n "$HELD" && "$HELD" != "$DOMAIN_NAME" ]]; then
    echo "==> Ignoring a certificate for ${HELD} — this site is ${DOMAIN_NAME}"
    ACM_CERT_ARN=""
  fi
fi

# Match on the domain name. Never take "the first certificate in the account".
if [[ -z "$ACM_CERT_ARN" && -n "$DOMAIN_NAME" ]]; then
  ACM_CERT_ARN="$(aws acm list-certificates --region "$CERT_REGION" \
    --certificate-statuses ISSUED \
    --query "CertificateSummaryList[?DomainName=='${DOMAIN_NAME}']|[0].CertificateArn" \
    --output text 2>/dev/null | sed 's/^None$//')"
  [[ -n "$ACM_CERT_ARN" ]] && echo "==> Certificate for ${DOMAIN_NAME} found in ACM"
fi

# Last check before it goes anywhere near CloudFront.
if [[ -n "$ACM_CERT_ARN" ]]; then
  FINAL="$(cert_domain "$ACM_CERT_ARN")"
  [[ -z "$FINAL" || "$FINAL" == "$DOMAIN_NAME" ]] ||
    die "Refusing to continue: that certificate is for ${FINAL}, not ${DOMAIN_NAME}."
fi

# No certificate for our own domain? Then this run has no custom domain. Say
# so out loud rather than quietly serving on the CloudFront address — the
# API's allowed origin moves with it, and uploads then fail CORS, which shows
# up as "fetch failed" and looks like a passcode problem.
if [[ -z "$ACM_CERT_ARN" ]]; then
  DOMAIN_NAME=""
  if [[ -n "$SITE_DOMAIN" ]]; then
    die "No issued certificate for ${SITE_DOMAIN} in ${CERT_REGION}.

Going ahead would put the site on its CloudFront address only, and uploads
from ${SITE_DOMAIN} would start failing CORS. Issue the certificate first:

  bash scripts/domain.sh"
  fi
fi

if [[ -n "$DOMAIN_NAME" ]]; then
  echo "==> Domain    $DOMAIN_NAME"
else
  echo "==> No custom domain — the site will answer on its CloudFront address."
fi

# ---------------------------------------------------------------- passcode ---
# One shared word the family types once before they can add a photograph.
# A stack that has never had the parameter cannot "keep" it, so only offer
# that when there is genuinely one there to keep.

HAS_PASSCODE=no
if [[ "$STACK_EXISTS" == yes ]] &&
   aws cloudformation describe-stacks --stack-name "$STACK" --region "$REGION" \
     --query "Stacks[0].Parameters[?ParameterKey=='FamilyPasscode']" \
     --output text 2>/dev/null | grep -q .; then
  HAS_PASSCODE=yes
fi

KEEP_PASSCODE=no
if [[ -z "$FAMILY_PASSCODE" ]]; then
  echo
  echo "The family passcode — one shared word anyone in the family types once"
  echo "before they can add a photograph or write a life story. It is not shown"
  echo "as you type."
  if [[ "$HAS_PASSCODE" == yes ]]; then
    echo "Press Enter on its own to keep the one the stack already has."
  fi
  printf "  Passcode: "
  read -r -s FAMILY_PASSCODE < /dev/tty
  echo

  if [[ -z "$FAMILY_PASSCODE" && "$HAS_PASSCODE" == yes ]]; then
    KEEP_PASSCODE=yes
    echo "    Keeping the existing passcode."
  else
    printf "  Again:    "
    read -r -s CONFIRM < /dev/tty
    echo
    [[ "$FAMILY_PASSCODE" == "$CONFIRM" ]] ||
      die "Those did not match. Nothing has been changed."
  fi
fi

if [[ "$KEEP_PASSCODE" == no ]]; then
  [[ ${#FAMILY_PASSCODE} -ge 4 ]] ||
    die "The passcode must be at least 4 characters."
  case "$FAMILY_PASSCODE" in
    ./* | */*)
      die "That looks like a command, not a passcode.

This happens when several commands are pasted in at once and the shell
feeds the next line to the prompt. Run this one on its own." ;;
  esac
fi

# ------------------------------------------------------------------- ship ----

echo "==> Verifying $ADMIN_EMAIL with SES in $REGION"
aws sesv2 create-email-identity \
  --email-identity "$ADMIN_EMAIL" \
  --region "$REGION" >/dev/null 2>&1 || true
echo "    Check that inbox and click the AWS verification link before"
echo "    submissions will send. SES starts in sandbox mode, which is fine"
echo "    here: it only ever emails you."

echo "==> Deploying stack $STACK"
# A parameter left out of --parameter-overrides keeps the value the stack
# already has, which is how "press Enter to keep it" works for the passcode.
# NoEcho means it can never be read back out, only set again.
set -- \
  ProjectName="$STACK" \
  AdminEmail="$ADMIN_EMAIL" \
  DomainName="$DOMAIN_NAME" \
  AcmCertificateArn="$ACM_CERT_ARN"
if [[ "$KEEP_PASSCODE" == no ]]; then
  set -- "$@" FamilyPasscode="$FAMILY_PASSCODE"
fi

aws cloudformation deploy \
  --stack-name "$STACK" \
  --template-file infra/template.yaml \
  --region "$REGION" \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides "$@" \
  --no-fail-on-empty-changeset

out() {
  aws cloudformation describe-stacks \
    --stack-name "$STACK" --region "$REGION" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" \
    --output text
}

API_URL="$(out ApiUrl)"
SITE_URL="$(out SiteUrl)"

cat > .env <<EOF
# Written by scripts/bootstrap.sh — safe to commit? No. Keep it local.
VITE_API_URL=${API_URL%/}
VITE_ADMIN_EMAIL=$ADMIN_EMAIL
EOF

# Everything the next run needs to reproduce this one. Written in full each
# time, so the domain and certificate survive instead of being forgotten.
{
  echo "STACK=$STACK"
  echo "REGION=$REGION"
  [[ -n "$DOMAIN_NAME"  ]] && echo "DOMAIN_NAME=$DOMAIN_NAME"
  [[ -n "$ACM_CERT_ARN" ]] && echo "CERT=$ACM_CERT_ARN"
} > .deploy.env

echo
echo "Stack ready."
echo "  Site      $SITE_URL"
echo "  API       ${API_URL%/}"
echo "  Bucket    $(out SiteBucketName)"
echo "  Email     $ADMIN_EMAIL"
echo
echo "The family passcode is stored only in AWS. Give it to the family however"
echo "you like; rerun this script to change it."
echo
echo "Next: ./scripts/deploy.sh"
