#!/bin/bash
set -eux
OLD_VERSION="${1}"
NEW_VERSION="${2}"

# Do not tag and commit changes made by "npm version"
export npm_config_git_tag_version=false
npm version "${NEW_VERSION}"

# Keep the MCP server's advertised version (serverInfo.version) in sync with
# package.json — it's hardcoded in src/server.ts, so bump it here too or it drifts.
sed -i.bak -E "s/(version: \")[0-9]+\.[0-9]+\.[0-9]+(\")/\1${NEW_VERSION}\2/" src/server.ts
rm -f src/server.ts.bak
