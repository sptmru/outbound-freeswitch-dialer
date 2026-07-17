#!/usr/bin/env bash

build_cron_path() {
  local command_name
  local command_path
  local command_directory
  local directory
  local joined=""
  local -a directories=()
  local -A seen_directories=()
  local -a standard_directories=(
    /usr/local/sbin
    /usr/local/bin
    /usr/sbin
    /usr/bin
    /sbin
    /bin
  )

  for command_name in "$@"; do
    command_path="$(command -v "${command_name}" 2>/dev/null)" || {
      echo "Missing required cron command: ${command_name}" >&2
      return 1
    }
    [[ "${command_path}" == /* \
      && "${command_path}" != *$'\n'* \
      && "${command_path}" != *$'\r'* \
      && "${command_path}" != *:* \
      && "${command_path}" != *%* \
      && -x "${command_path}" ]] || {
      echo "Cron command ${command_name} did not resolve to a safe absolute executable path" >&2
      return 1
    }
    command_directory="${command_path%/*}"
    directories+=("${command_directory:-/}")
  done

  directories+=("${standard_directories[@]}")
  for directory in "${directories[@]}"; do
    if [[ -n "${seen_directories["${directory}"]+present}" ]]; then
      continue
    fi
    seen_directories["${directory}"]=true
    if [[ -n "${joined}" ]]; then
      joined+=:
    fi
    joined+="${directory}"
  done
  printf '%s\n' "${joined}"
}
