#!/bin/sh
set -eu

storage_dir="${PCAP_STORAGE_DIR:-/var/lib/outbound-dialer/pcaps}"

# Debian tcpdump drops privileges to the tcpdump user before opening the
# savefile. Named volumes are root-owned by default, including existing
# volumes created before the image supplied an initialized mountpoint.
mkdir -p "$storage_dir"
chown root:root "$storage_dir"
chmod 0770 "$storage_dir"
chown tcpdump:root "$storage_dir"

exec "$@"
