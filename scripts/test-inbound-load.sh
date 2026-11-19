#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
case "${1:-}" in
  "") exec bash "$ROOT_DIR/scripts/test-inbound-db.sh" --load smoke ;;
  control) shift; exec bash "$ROOT_DIR/scripts/test-inbound-db.sh" --load "$@" ;;
  sip-rtp)
    if [[ $# != 1 ]]; then echo 'sip-rtp takes no arguments' >&2; exit 2; fi
    exec bash "$ROOT_DIR/scripts/test-e02-acceptance.sh" --i03-load ;;

  slow-esl)
    if [[ $# != 1 ]]; then echo 'slow-esl takes no arguments' >&2; exit 2; fi
    I03_SLOW_ESL=1 exec bash "$ROOT_DIR/scripts/test-c03-executor.sh" ;;
  mixed)
    if [[ $# != 1 ]]; then echo 'mixed takes no arguments' >&2; exit 2; fi
    exec bash "$ROOT_DIR/scripts/test-e02-acceptance.sh" --i03-mixed ;;
  sustained)
    if [[ $# != 2 ]]; then echo 'Expected sustained {check|history|normal|soak}' >&2; exit 2; fi
    exec bash "$ROOT_DIR/scripts/test-e02-acceptance.sh" --i03-soak "$2" ;;
  *) echo 'Usage: npm run test:load:inbound -- control {smoke|reference} | sip-rtp | slow-esl | mixed | sustained {check|history|normal|soak}' >&2; exit 2 ;;
esac
