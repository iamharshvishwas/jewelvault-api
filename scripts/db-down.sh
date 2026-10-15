#!/usr/bin/env bash
# -f stops it, -v removes its anonymous volumes (there are none: the data dir is tmpfs). Never touches other containers.
docker rm -fv jv-mariadb-spike
