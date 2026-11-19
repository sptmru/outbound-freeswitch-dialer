#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
case "${1:-}" in
  "") exec bash "$ROOT_DIR/scripts/test-inbound-db.sh" --load smoke ;;
  control) shift; exec bash "$ROOT_DIR/scripts/test-inbound-db.sh" --load "$@" ;;
  sip-rtp)
    if [[ $# != 1 ]]; then echo 'sip-rtp takes no arguments' >&2; exit 2; fi
    exec bash "$ROOT_DIR/scripts/test-e02-acceptance.sh" --i03-load ;;
  *) echo 'Usage: npm run test:load:inbound -- control {smoke|reference} | sip-rtp' >&2; exit 2 ;;
esac
