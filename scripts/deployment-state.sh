#!/usr/bin/env bash

# Shared helpers for the deploy/rollback/restore state file. The state is kept
# in shell-compatible assignments because the operator runbooks source it.

deployment_state_load() {
  local state_file="$1"

  DEPLOYMENT_STATUS="stable"
  CURRENT_VERSION=""
  PREVIOUS_VERSION=""
  PENDING_VERSION=""
  FAILED_VERSION=""
  DEPLOYMENT_OPERATION=""
  DEPLOYED_AT=""
  STATE_UPDATED_AT=""

  if [[ -f "${state_file}" ]]; then
    # shellcheck disable=SC1090
    source "${state_file}"
  fi
}

deployment_state_write() {
  local state_file="$1"
  local status="$2"
  local current_version="$3"
  local previous_version="$4"
  local pending_version="$5"
  local failed_version="$6"
  local operation="$7"
  local deployed_at="$8"
  local state_tmp="${state_file}.tmp.$$"

  mkdir -p "$(dirname "${state_file}")"
  if ! (
    umask 077
    printf \
      'DEPLOYMENT_STATUS=%q\nCURRENT_VERSION=%q\nPREVIOUS_VERSION=%q\nPENDING_VERSION=%q\nFAILED_VERSION=%q\nDEPLOYMENT_OPERATION=%q\nDEPLOYED_AT=%q\nSTATE_UPDATED_AT=%q\n' \
      "${status}" \
      "${current_version}" \
      "${previous_version}" \
      "${pending_version}" \
      "${failed_version}" \
      "${operation}" \
      "${deployed_at}" \
      "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "${state_tmp}"
  ); then
    rm -f "${state_tmp}"
    return 1
  fi
  mv "${state_tmp}" "${state_file}"
}
