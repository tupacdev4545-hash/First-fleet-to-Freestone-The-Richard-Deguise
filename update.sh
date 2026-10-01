#!/usr/bin/env bash
# Pull in the newest deguise-family-tree zip and run the site.
#
#   ./update.sh          unzip the newest download, install, start the dev server
#   ./update.sh --no-run  unzip and install only
#
# Safe to run while the dev server is going — Vite reloads on its own.
# Your .env and .deploy.env are never in the zip, so they survive untouched.

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
die() { printf '\n\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------- find it ---
say "1/4  Looking for the newest zip"

ZIP=""
for dir in "$HOME/Downloads" "$HERE/.." "$HOME/Desktop"; do
  [[ -d "$dir" ]] || continue
  found="$(ls -t "$dir"/deguise-family-tree*.zip "$dir"/deguisefamilytree*.zip 2>/dev/null | head -1 || true)"
  if [[ -n "$found" ]]; then ZIP="$found"; break; fi
done

[[ -n "$ZIP" ]] || die "No zip found in ~/Downloads, this folder's parent, or ~/Desktop.
Download it from the chat first, then run this again."

printf '     %s\n' "$ZIP"
printf '     %s\n' "$(date -r "$ZIP" '+%a %d %b %H:%M')"

# ---------------------------------------------------------------- unpack ----
say "2/4  Unpacking over the current files"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
unzip -q -o "$ZIP" -d "$TMP"

# The zip carries a top-level deguise-tree/ folder; copy its contents in.
SRC="$TMP/deguise-tree"
[[ -d "$SRC" ]] || SRC="$TMP"
[[ -f "$SRC/package.json" ]] || die "That zip does not look like the project — no package.json inside."

# -a keeps timestamps so npm can tell whether package.json actually changed.
cp -a "$SRC/." "$HERE/"
chmod +x "$HERE"/scripts/*.sh "$HERE"/update.sh 2>/dev/null || true
printf '     Updated %s\n' "$HERE"

# ------------------------------------------------------------- dependencies -
say "3/4  Installing dependencies"
npm install --no-audit --no-fund

# ------------------------------------------------------------------- run ----
if [[ "${1:-}" == "--no-run" ]]; then
  say "4/4  Done. Start it yourself with:  npm run dev"
  exit 0
fi

say "4/4  Starting the dev server — open http://localhost:5173"
printf '     Ctrl-C to stop.\n'
npm run dev
