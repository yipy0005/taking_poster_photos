#!/usr/bin/env bash
# scripts/compute-base-path.sh: prints "BASE_PATH=<value>" for $GITHUB_ENV. Input: GITHUB_REPOSITORY="owner/repo".
# Project sites are served from /<repo>/; a user/organisation site (repo named <owner>.github.io) is served from /.
# Compatible with bash 3.2 (macOS): no ${var,,}, so the comparison is lower-cased with tr.
set -euo pipefail
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY must be set to owner/repo}"
repo="${GITHUB_REPOSITORY#*/}"
lower="$(printf '%s' "$repo" | tr '[:upper:]' '[:lower:]')"
case "$lower" in
  *.github.io) echo "BASE_PATH=/" ;;
  *)           echo "BASE_PATH=/${repo}/" ;;
esac
