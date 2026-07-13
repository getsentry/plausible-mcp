#!/bin/bash
set -eux
OLD_VERSION="${1}"
NEW_VERSION="${2}"

# Do not tag and commit changes made by "npm version"
export npm_config_git_tag_version=false
npm version "${NEW_VERSION}"

# Keep the MCP server's advertised version (serverInfo.version) in sync with
# package.json — it's hardcoded in src/server.ts, so bump it here too or it drifts.
# Match whatever is currently in the quotes (any SemVer, incl. pre-release suffixes),
# then verify the swap took so a missed match fails the release loudly instead of
# silently shipping a stale version.
sed -i.bak -E "s/(version: \")[^\"]*(\")/\1${NEW_VERSION}\2/" src/server.ts
rm -f src/server.ts.bak
grep -q "version: \"${NEW_VERSION}\"" src/server.ts || {
  echo "ERROR: failed to sync src/server.ts to ${NEW_VERSION}" >&2
  exit 1
}
