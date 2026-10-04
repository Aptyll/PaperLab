#!/bin/sh
# Builds the two downloads offered on the demo site:
#   PaperLab-Windows.zip  Paper Lab plus its own copy of Node, so nothing needs installing.
#   PaperLab-Mac.zip      Paper Lab; needs Node installed once (nodejs.org).
#
#   sh scripts/package-release.sh [output folder, default dist]
#
# Only files committed to git go in (git archive), so a local database, log or
# config.local.json can never end up in a download. Node comes from nodejs.org
# and its checksum is checked before it is used.
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
OUT=$(mkdir -p "${1:-dist}" && cd "${1:-dist}" && pwd)
NODE_LINE=latest-v24.x
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

app() {
  mkdir -p "$1"
  git -C "$ROOT" archive HEAD src public notes launcher data package.json README.md SETUP.md | tar -x -C "$1"
}

# Windows
app "$WORK/win/Paper Lab"
curl -fsSL "https://nodejs.org/dist/$NODE_LINE/SHASUMS256.txt" -o "$WORK/SHASUMS256.txt"
NODE_ZIP=$(grep -o 'node-v[0-9.]*-win-x64\.zip' "$WORK/SHASUMS256.txt" | head -n 1)
curl -fsSL "https://nodejs.org/dist/$NODE_LINE/$NODE_ZIP" -o "$WORK/$NODE_ZIP"
(cd "$WORK" && grep " $NODE_ZIP\$" SHASUMS256.txt | sha256sum -c -)
unzip -q "$WORK/$NODE_ZIP" -d "$WORK/node"
NODE_DIR="$WORK/node/${NODE_ZIP%.zip}"
mkdir -p "$WORK/win/Paper Lab/node"
cp "$NODE_DIR/node.exe" "$NODE_DIR/LICENSE" "$WORK/win/Paper Lab/node/"
mv "$WORK/win/Paper Lab/launcher/windows/Start Paper Lab.cmd" "$WORK/win/Paper Lab/"
rm -rf "$WORK/win/Paper Lab/launcher/mac"
rm -f "$OUT/PaperLab-Windows.zip"
(cd "$WORK/win" && zip -qr -9 "$OUT/PaperLab-Windows.zip" "Paper Lab")

# Mac
app "$WORK/mac/Paper Lab"
mv "$WORK/mac/Paper Lab/launcher/mac/Start Paper Lab.command" "$WORK/mac/Paper Lab/"
chmod +x "$WORK/mac/Paper Lab/Start Paper Lab.command"
rm -rf "$WORK/mac/Paper Lab/launcher/windows"
rm -f "$OUT/PaperLab-Mac.zip"
(cd "$WORK/mac" && zip -qr -9 "$OUT/PaperLab-Mac.zip" "Paper Lab")

echo "Built with ${NODE_ZIP%-win-x64.zip} for Windows:"
ls -l "$OUT"/PaperLab-*.zip
