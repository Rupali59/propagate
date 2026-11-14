#!/bin/bash
# Eval fixture for agent-doc-curator (#251). One doc with one stale statement, and the code that contradicts it.
# Also records where the scaffold ran: the scaffold's cwd and env are undocumented, so the first run measures them.
set -e
mkdir -p docs src
cat > docs/RELEASE.md <<'MD'
# Releasing

Run `npm run release` to publish. The release script retries a failed upload three times before giving up.

The changelog is written by hand.
MD
cat > src/release.mjs <<'JS'
// Uploads the package. A failed upload is NOT retried: it exits 1 so CI shows the failure at once.
export const MAX_UPLOAD_ATTEMPTS = 1;
export async function upload(push) {
  const ok = await push();
  if (!ok) process.exit(1);
}
JS
{ echo "pwd=$(pwd)"; echo "plugin_root=${CLAUDE_PLUGIN_ROOT:-unset}"; echo "home=$HOME"; } > .scaffold-probe
