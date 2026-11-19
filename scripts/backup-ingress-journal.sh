#!/usr/bin/env bash

# Uses the same private named volume as ingress-journal. The caller supplies
# compose(), ROOT_DIR and the host-operation lock.
ingress_journal_volume_exists() {
  local name volumes
  name="$(compose config --format json | node -e '
    const config = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
    if (!config.volumes?.ingress_journal?.name) process.exit(1);
    console.log(config.volumes.ingress_journal.name);
  ')" || return 2
  volumes="$(docker volume ls --format '{{.Name}}')" || return 2
  [[ $'\n'"${volumes}"$'\n' == *$'\n'"${name}"$'\n'* ]]
}

run_ingress_journal_tool() {
  local source
  source="$(cat "${ROOT_DIR}/scripts/backup-ingress-journal.mjs")" || return
  compose run --rm --no-deps --pull never -T -e TMPDIR=/dev/shm --entrypoint node ingress-journal \
    --input-type=module -e "${source}" -- "$@"
}

validate_ingress_journal_bundle() {
  local directory="$1" marker
  marker="$(sed -n 's/^ingress_journal=//p' "${directory}/metadata.txt" 2>/dev/null)" || marker=""
  case "${marker}" in
    present)
      [[ -f "${directory}/ingress.sqlite" && ! -L "${directory}/ingress.sqlite" ]] || {
        echo "Backup metadata requires an ingress journal snapshot" >&2
        return 1
      }
      node "${ROOT_DIR}/scripts/backup-ingress-journal.mjs" verify "${directory}/ingress.sqlite"
      ;;
    absent | "")
      if [[ -e "${directory}/ingress.sqlite" || -L "${directory}/ingress.sqlite" ]]; then
        echo "Backup contains an ingress journal without matching metadata" >&2
        return 1
      fi
      ;;
    *)
      echo "Invalid ingress journal backup metadata" >&2
      return 1
      ;;
  esac
}
