#!/bin/bash
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo ""
  echo "  Node is not installed — this needs it to run."
  echo "  Get it from https://nodejs.org (press the LTS button), then open this again."
  echo ""
  read -n 1 -s -r -p "  Press any key to close."
  exit 1
fi
node server.js
echo ""
read -n 1 -s -r -p "  Server stopped. Press any key to close."
