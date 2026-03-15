#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../../.." && pwd)"
DIST_DIR="$ROOT_DIR/backend/lambda/.dist"
DATA_DIR="$DIST_DIR/data"

rm -rf "$DIST_DIR"
mkdir -p "$DATA_DIR"

cp "$ROOT_DIR/backend/lambda/api/handler.js" "$DIST_DIR/handler.js"
cp "$ROOT_DIR/mock_api/deck_default.json" "$DATA_DIR/deck_default.json"
cp "$ROOT_DIR/mock_api/champions_recent.json" "$DATA_DIR/champions_recent.json"

node - "$ROOT_DIR" <<'EOF' > "$DIST_DIR/package.json"
const fs = require("fs");
const path = require("path");

const rootDir = process.argv[2];
const rootPackage = JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf8"));

process.stdout.write(JSON.stringify({
  name: "omojan-lambda-bundle",
  private: true,
  dependencies: rootPackage.dependencies || {}
}, null, 2));
EOF

(
  cd "$DIST_DIR"
  npm install --omit=dev --ignore-scripts --no-package-lock --no-audit --no-fund
)

rm -f "$DIST_DIR/package.json"

echo "Built Lambda bundle at $DIST_DIR"
du -sh "$DIST_DIR"
