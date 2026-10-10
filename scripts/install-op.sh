#!/bin/sh
set -eu

fail() { printf '%s\n' "$*" >&2; exit 1; }
normalize_arch() {
  case "$1" in
    amd64|x86_64) printf '%s' amd64 ;;
    arm64|aarch64) printf '%s' arm64 ;;
    *) fail "Unsupported op architecture: $1" ;;
  esac
}

version=${1:-2.39.0}
target=${2:-}
destination=${3:-/usr/local/bin}
native=$(normalize_arch "$(uname -m)")
arch=$(normalize_arch "${target:-$native}")
[ "$native" = "$arch" ] || fail "op target architecture $arch differs from effective architecture $native"

# ZIP hashes computed after verifying op.sig against the official signing key
# 3FEF9748469ADBE15DA7CA80AC2D62742012EA22 (1password.dev/cli/verify).
# New versions require independently verified hashes before they can be built.
case "$version:$arch" in
  2.39.0:amd64) checksum=6fba7f376b6c6dec49f41b06408930a43ad064cce103c6a2ce5b3d0413a86434 ;;
  2.39.0:arm64) checksum=829baeff1c07e055cfa132031b1d9f2282ccdf5076258e482caf2fda70aea5d0 ;;
  *) fail "No verified op checksum for version $version and architecture $arch" ;;
esac

scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT HUP INT TERM
curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
  --output "$scratch/op.zip" \
  "https://cache.agilebits.com/dist/1P/op2/pkg/v${version}/op_linux_${arch}_v${version}.zip"
printf '%s  %s\n' "$checksum" "$scratch/op.zip" | sha256sum -c -
unzip -q "$scratch/op.zip" op -d "$scratch"
chmod 0755 "$scratch/op"
# Execute only the verified artifact; this also catches incompatible binaries.
[ "$("$scratch/op" --version)" = "$version" ] || fail "Unexpected op CLI version"
mkdir -p "$destination"
mv "$scratch/op" "$destination/op"
