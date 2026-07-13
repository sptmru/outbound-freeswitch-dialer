#!/usr/bin/env bash
set -euo pipefail

SCRIPT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT_DIR="${DEPLOY_ROOT_DIR:-${SCRIPT_ROOT}}"
REMOTE="${DEPLOY_REMOTE:-origin}"
BRANCH="${DEPLOY_BRANCH:-main}"
LOCK_FILE="${DEPLOY_LOCK_FILE:-${ROOT_DIR}/.git/deploy.lock}"
TARGET_SHA="${1:-}"

fail() {
  echo "Remote deploy refused: $*" >&2
  exit 1
}

[[ "${TARGET_SHA}" =~ ^[0-9a-f]{40}$ ]] || fail "expected a full 40-character lowercase Git commit SHA"
[[ -d "${ROOT_DIR}/.git" ]] || fail "${ROOT_DIR} is not a Git checkout"

for command in flock git; do
  command -v "${command}" >/dev/null || fail "missing required command: ${command}"
done

mkdir -p "$(dirname "${LOCK_FILE}")"
exec 9>"${LOCK_FILE}"
flock -n 9 || fail "another deployment is already running"

if [[ -n "$(git -C "${ROOT_DIR}" status --porcelain --untracked-files=normal)" ]]; then
  fail "working tree must be clean before fetching a release"
fi

echo "Fetching ${REMOTE}/${BRANCH} for deployment target ${TARGET_SHA}"
git -C "${ROOT_DIR}" fetch --prune "${REMOTE}" \
  "refs/heads/${BRANCH}:refs/remotes/${REMOTE}/${BRANCH}"

git -C "${ROOT_DIR}" cat-file -e "${TARGET_SHA}^{commit}" 2>/dev/null \
  || fail "commit ${TARGET_SHA} is not available after fetch"
git -C "${ROOT_DIR}" merge-base --is-ancestor \
  "${TARGET_SHA}" "refs/remotes/${REMOTE}/${BRANCH}" \
  || fail "commit ${TARGET_SHA} is not an ancestor of ${REMOTE}/${BRANCH}"

git -C "${ROOT_DIR}" checkout --detach "${TARGET_SHA}"
[[ "$(git -C "${ROOT_DIR}" rev-parse HEAD)" == "${TARGET_SHA}" ]] \
  || fail "checked-out commit does not match ${TARGET_SHA}"

echo "Starting guarded deployment for ${TARGET_SHA}"
cd "${ROOT_DIR}"
exec env ENV_FILE="${ENV_FILE:-${ROOT_DIR}/.env}" "${ROOT_DIR}/scripts/deploy.sh"
