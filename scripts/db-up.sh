#!/usr/bin/env bash
# Throwaway MariaDB 11.8 for the spike. Data lives in tmpfs (RAM): nothing touches a Docker volume.
# Hostinger's server is MariaDB 11.8.9 with READ-COMMITTED and event_scheduler OFF; we copy that.
set -euo pipefail
NAME=jv-mariadb-spike
PORT=${JV_DB_PORT:-33307}
if docker ps -a --format '{{.Names}}' | grep -qx "$NAME"; then docker rm -fv "$NAME" >/dev/null; fi
docker run -d --name "$NAME" -p 127.0.0.1:$PORT:3306 --tmpfs /var/lib/mysql:rw,size=1g \
  -e MARIADB_ROOT_PASSWORD=spike_root_only -e MARIADB_DATABASE=jv_spike \
  mariadb:11.8 --transaction-isolation=READ-COMMITTED --character-set-server=utf8mb4 --collation-server=utf8mb4_unicode_ci >/dev/null
for i in $(seq 1 40); do
  if docker exec "$NAME" mariadb -uroot -pspike_root_only -e 'select 1' >/dev/null 2>&1; then echo "MariaDB ready on 127.0.0.1:$PORT"; exit 0; fi
  sleep 1
done
echo "MariaDB did not start" >&2; exit 1
