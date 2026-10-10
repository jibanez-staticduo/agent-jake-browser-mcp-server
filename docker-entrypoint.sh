#!/usr/bin/env sh
set -eu

# HTTP and stdio entry points are compiled by the product build.
exec "$@"
