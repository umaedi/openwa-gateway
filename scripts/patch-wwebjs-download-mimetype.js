/**
 * Forward the message mimetype to WhatsApp Web's media download (OpenWA #1739, wwebjs #201908).
 *
 * whatsapp-web.js 1.34.7's `Message#downloadMedia()` calls
 * `WAWebDownloadManager.downloadManager.downloadAndMaybeDecrypt({...})` without a `mimetype`.
 * Current WhatsApp Web builds default the missing value to `application/octet-stream`, and their
 * media type check rejects the download with `InvalidMediaFileType`, which surfaces minified as
 * `t: t`. Every uncached inbound image/video/sticker/voice note therefore fails to download (the
 * webhook carries no media), while media the page already decrypted is served from a hash-keyed
 * cache and still succeeds. Upstream OpenWA shipped the same one-field fix in v0.24.0.
 *
 * The transform is exact and self-disabling: an unknown shape fails instead of silently shipping
 * without the fix, matching the sibling patchers.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_WWJS = path.join(__dirname, '..', 'node_modules', 'whatsapp-web.js');
const MESSAGE_PATH = path.join('src', 'structures', 'Message.js');

const FIND = `                        mediaKeyTimestamp: msg.mediaKeyTimestamp,
                        type: msg.type,
                        signal: new AbortController().signal,`;

const REPLACE = `                        mediaKeyTimestamp: msg.mediaKeyTimestamp,
                        type: msg.type,
                        mimetype: msg.mimetype,
                        signal: new AbortController().signal,`;

function applyDownloadMimetypePatch({ wwjsDir = DEFAULT_WWJS } = {}) {
  const file = path.join(wwjsDir, MESSAGE_PATH);
  if (!fs.existsSync(file)) {
    throw new Error(`whatsapp-web.js Message.js not found at ${file}`);
  }
  const source = fs.readFileSync(file, 'utf8');
  if (source.includes(REPLACE)) {
    return { applied: false };
  }
  if (!source.includes(FIND)) {
    throw new Error(`unexpected downloadMedia() shape in ${MESSAGE_PATH}: refusing to patch blind`);
  }
  fs.writeFileSync(file, source.replace(FIND, REPLACE));
  return { applied: true };
}

function run() {
  const bestEffort = process.argv.includes('--best-effort');
  try {
    const { applied } = applyDownloadMimetypePatch();
    console.log(`patch-wwebjs-download-mimetype: ${applied ? 'applied' : 'skipped (already present)'}`);
  } catch (error) {
    if (bestEffort) {
      console.warn(`patch-wwebjs-download-mimetype: skipped, ${error.message}`);
      return;
    }
    console.error(`patch-wwebjs-download-mimetype: ${error.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) run();

module.exports = { applyDownloadMimetypePatch, FIND, REPLACE, MESSAGE_PATH };
