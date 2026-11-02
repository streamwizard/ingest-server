#!/usr/bin/env bash
# Runs each test file in its own bun process.
#
# `bun test` normally runs every file in one process, and modules are loaded
# once per process. The streamwizard-api tests each point REST_API_URL at their
# own stub server before importing the client, so sharing a process would send
# the second file's requests to the first file's stub.
set -euo pipefail

failed=0

while IFS= read -r file; do
  echo "── $file"
  if ! bun test "$file"; then
    failed=1
  fi
done < <(find src -name '*.test.ts' | sort)

exit "$failed"
