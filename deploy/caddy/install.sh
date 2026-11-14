#!/bin/sh
# nanana CLI installer.
#
#   curl -fsSL https://nanana.lat/install.sh | sh
#
# Environment:
#   NANANA_VERSION      install a specific version (e.g. 0.3.1) instead of the latest
#   NANANA_INSTALL_DIR  install into this directory
#   NANANA_REPO         override the releases repo (default erostalevi/nanana-releases)
#
# Downloads the archive from GitHub Releases, verifies its SHA-256 against the
# published checksums file, and installs the `nanana` binary.
set -eu

REPO="${NANANA_REPO:-erostalevi/nanana-releases}"
BIN="nanana"

say() { printf '%s\n' "$*"; }
err() { printf 'error: %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

# ---- detect platform ----------------------------------------------------------------
os="$(uname -s | tr '[:upper:]' '[:lower:]')"
case "$os" in
  linux) os="linux" ;;
  darwin) os="darwin" ;;
  msys* | mingw* | cygwin*) err "on Windows, download the .zip from https://github.com/${REPO}/releases/latest" ;;
  *) err "unsupported operating system: $os" ;;
esac

arch="$(uname -m)"
case "$arch" in
  x86_64 | amd64) arch="amd64" ;;
  arm64 | aarch64) arch="arm64" ;;
  *) err "unsupported architecture: $arch" ;;
esac

# ---- tools --------------------------------------------------------------------------
if have curl; then
  fetch() { curl -fsSL "$1" -o "$2"; }
  final_url() { curl -fsSL -o /dev/null -w '%{url_effective}' "$1"; }
elif have wget; then
  fetch() { wget -q -O "$2" "$1"; }
  final_url() { wget -q --max-redirect=5 -S --spider "$1" 2>&1 | sed -n 's/^ *Location: *//p' | tail -n1; }
else
  err "need curl or wget"
fi

if have sha256sum; then
  sha() { sha256sum "$1" | cut -d' ' -f1; }
elif have shasum; then
  sha() { shasum -a 256 "$1" | cut -d' ' -f1; }
else
  err "need sha256sum or shasum to verify the download"
fi
have tar || err "need tar"

# ---- resolve version -----------------------------------------------------------------
version="${NANANA_VERSION:-}"
if [ -z "$version" ]; then
  url="$(final_url "https://github.com/${REPO}/releases/latest")" || err "could not look up the latest release"
  tag="${url##*/}"
  [ -n "$tag" ] && [ "$tag" != "latest" ] || err "no releases found in ${REPO}"
  version="${tag#v}"
fi
version="${version#v}"
say "Installing ${BIN} ${version} (${os}/${arch})"

archive="${BIN}_${version}_${os}_${arch}.tar.gz"
base="https://github.com/${REPO}/releases/download/v${version}"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT INT TERM

fetch "${base}/${archive}" "${tmp}/${archive}" || err "download failed: ${base}/${archive}"
if ! fetch "${base}/${BIN}_${version}_checksums.txt" "${tmp}/checksums.txt" 2>/dev/null; then
  fetch "${base}/checksums.txt" "${tmp}/checksums.txt" || err "could not download the checksums file"
fi

# ---- verify -------------------------------------------------------------------------
expected="$(grep " ${archive}\$" "${tmp}/checksums.txt" | cut -d' ' -f1 | head -n1)"
[ -n "$expected" ] || err "no checksum listed for ${archive}"
actual="$(sha "${tmp}/${archive}")"
if [ "$expected" != "$actual" ]; then
  err "checksum mismatch for ${archive} (expected ${expected}, got ${actual})"
fi
say "Checksum OK"

tar -xzf "${tmp}/${archive}" -C "$tmp" "$BIN" 2>/dev/null || tar -xzf "${tmp}/${archive}" -C "$tmp"
[ -f "${tmp}/${BIN}" ] || err "archive did not contain ${BIN}"
chmod 0755 "${tmp}/${BIN}"

# ---- install ------------------------------------------------------------------------
dir="${NANANA_INSTALL_DIR:-}"
if [ -z "$dir" ]; then
  if [ -w /usr/local/bin ]; then
    dir="/usr/local/bin"
  elif [ "$(id -u)" -ne 0 ] && have sudo && [ -t 1 ] && [ -r /dev/tty ]; then
    dir="/usr/local/bin"
    use_sudo=1
  else
    dir="${HOME}/.local/bin"
  fi
fi

if [ "${use_sudo:-0}" = "1" ]; then
  say "Installing to ${dir} with sudo"
  sudo install -m 0755 "${tmp}/${BIN}" "${dir}/${BIN}"
else
  mkdir -p "$dir"
  install -m 0755 "${tmp}/${BIN}" "${dir}/${BIN}"
fi

say ""
say "Installed ${dir}/${BIN}"
case ":${PATH}:" in
  *":${dir}:"*) ;;
  *) say "Note: ${dir} is not on your PATH. Add it, e.g.:"
     say "  echo 'export PATH=\"${dir}:\$PATH\"' >> ~/.profile" ;;
esac

say ""
say "Next steps:"
say "  1. Create an endpoint at https://nanana.lat and copy its token."
say "  2. Tunnel it to a local port:"
say "       nanana -t=<token> -p=3000"
say "  3. Or sign in to manage endpoints from the terminal:"
say "       nanana login"
say "Docs: https://nanana.lat/docs"
