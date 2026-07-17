#!/usr/bin/env bash
set -euo pipefail

SCRIPT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT_DIR="${DEPLOY_ROOT_DIR:-${SCRIPT_ROOT}}"
REMOTE="${DEPLOY_REMOTE:-origin}"
BRANCH="${DEPLOY_BRANCH:-main}"
TARGET_SHA="${1:-}"

fail() {
  echo "Remote deploy refused: $*" >&2
  exit 1
}

ensure_node_runtime() {
  local node_major=""
  if command -v node >/dev/null && command -v npm >/dev/null; then
    node_major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || true)"
    if [[ "${node_major}" =~ ^[0-9]+$ ]] && (( node_major >= 22 )); then
      return
    fi
  fi

  export NVM_DIR="${NVM_DIR:-${HOME}/.nvm}"
  [[ -s "${NVM_DIR}/nvm.sh" ]] \
    || fail "Node.js 22+ is not in PATH and NVM was not found at ${NVM_DIR}/nvm.sh"
  # NVM is intentionally loaded here because GitHub SSH commands are
  # non-interactive and do not reliably source the deployment user's shell rc.
  # shellcheck disable=SC1090
  source "${NVM_DIR}/nvm.sh"
  nvm use --silent "${DEPLOY_NODE_VERSION:-22}" >/dev/null \
    || fail "NVM could not activate Node.js ${DEPLOY_NODE_VERSION:-22}"

  command -v node >/dev/null || fail "node is unavailable after loading NVM"
  command -v npm >/dev/null || fail "npm is unavailable after loading NVM"
  node_major="$(node -p 'process.versions.node.split(".")[0]')"
  [[ "${node_major}" =~ ^[0-9]+$ ]] && (( node_major >= 22 )) \
    || fail "deployment requires Node.js 22 or newer"
}

[[ "${TARGET_SHA}" =~ ^[0-9a-f]{40}$ ]] || fail "expected a full 40-character lowercase Git commit SHA"
[[ -d "${ROOT_DIR}/.git" ]] || fail "${ROOT_DIR} is not a Git checkout"

for command in git; do
  command -v "${command}" >/dev/null || fail "missing required command: ${command}"
done

# shellcheck disable=SC1090
source "${SCRIPT_ROOT}/scripts/host-operation-lock.sh"
acquire_host_operation_lock "${ROOT_DIR}" "remote deployment" || exit 1

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

ensure_node_runtime
echo "Using $(node --version) and npm $(npm --version)"
echo "Starting guarded deployment for ${TARGET_SHA}"
cd "${ROOT_DIR}"
exec env ENV_FILE="${ENV_FILE:-${ROOT_DIR}/.env}" "${ROOT_DIR}/scripts/deploy.sh"
