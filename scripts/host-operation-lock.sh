#!/usr/bin/env bash

# This file is sourced by host-side mutating scripts. The lock descriptor and
# marker are inherited by nested operations (deploy -> backup -> verify), so the
# whole maintenance workflow owns one non-reentrant host lock.
acquire_host_operation_lock() {
  local root_dir="$1"
  local operation="$2"
  local lock_file="${OUTBOUND_DIALER_OPERATION_LOCK_FILE:-${root_dir}/.git/outbound-dialer-operation.lock}"
  local inherited_fd="${OUTBOUND_DIALER_OPERATION_LOCK_FD:-}"
  local inherited_identity
  local lock_identity
  local lock_fd

  command -v flock >/dev/null || {
    echo "Missing required command: flock" >&2
    return 1
  }

  if [[ -n "${inherited_fd}" ]]; then
    command -v stat >/dev/null || {
      echo "Missing required command: stat" >&2
      return 1
    }
    [[ "${inherited_fd}" =~ ^[0-9]+$ \
      && -e "/proc/$$/fd/${inherited_fd}" \
      && -e "${lock_file}" ]] || {
      echo "Invalid inherited outbound-dialer host-operation lock" >&2
      return 1
    }
    inherited_identity="$(stat -Lc '%d:%i' "/proc/$$/fd/${inherited_fd}")" || {
      echo "Invalid inherited outbound-dialer host-operation lock descriptor" >&2
      return 1
    }
    lock_identity="$(stat -Lc '%d:%i' "${lock_file}")" || {
      echo "Invalid inherited outbound-dialer host-operation lock path" >&2
      return 1
    }
    [[ "${inherited_identity}" == "${lock_identity}" ]] || {
      echo "Inherited outbound-dialer host-operation lock does not match ${lock_file}" >&2
      return 1
    }
    flock -n "${inherited_fd}" || {
      echo "Inherited outbound-dialer host-operation descriptor does not own ${lock_file}" >&2
      return 1
    }
    return 0
  fi

  mkdir -p "$(dirname "${lock_file}")"
  exec {lock_fd}>"${lock_file}"
  if ! flock -n "${lock_fd}"; then
    echo "Refusing ${operation}: another deploy, backup, restore, rollback, or certificate operation is running" >&2
    return 1
  fi

  export OUTBOUND_DIALER_OPERATION_LOCK_FD="${lock_fd}"
  export OUTBOUND_DIALER_OPERATION_LOCK_FILE="${lock_file}"
  export OUTBOUND_DIALER_OPERATION_LOCK_OWNER="${operation}"
}
