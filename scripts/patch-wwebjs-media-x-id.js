/**
 * Backport of upstream whatsapp-web.js #201923 (commit 064a3d5a5a, 2026-09-28):
 * "fix(media): drop __x_id before spreading mediaOptions into outgoing Msg".
 *
 * `window.WWebJS.sendMessage` builds the outgoing Msg by spreading `mediaOptions` (a MediaData
 * model) into a plain object. Current WhatsApp Web builds give MediaData an enumerable private
 * `__x_id` field that collides with Msg's internal id, so `getValidatedSender()` throws during Msg
 * initialization. The page error is minified, so every media send (image, video, audio, document)
 * reaches the caller as an opaque `t: t` / `500`, while text sends keep working. 1.34.7 (the
 * latest release) predates the fix.
 *
 * The transform is exact and self-disabling: an unknown shape fails instead of silently shipping
 * without the fix, matching the sibling patchers.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_WWJS = path.join(__dirname, '..', 'node_modules', 'whatsapp-web.js');
const UTILS_PATH = path.join('src', 'util', 'Injected', 'Utils.js');

const FIND = `            ...botOptions,
            ...extraOptions,
        };

        // Bot's won't reply if canonicalUrl is set (linking)`;

const REPLACE = `            ...botOptions,
            ...extraOptions,
        };

        // MediaData is a model whose private __x_id field collides with Msg's
        // internal id field when its enumerable properties are spread above,
        // breaking getValidatedSender() during Msg initialization.
        if (message.__x_id) {
            delete message.__x_id;
        }
        // Bot's won't reply if canonicalUrl is set (linking)`;

function applyMediaXIdPatch({ wwjsDir = DEFAULT_WWJS } = {}) {
  const file = path.join(wwjsDir, UTILS_PATH);
  if (!fs.existsSync(file)) {
    throw new Error(`whatsapp-web.js Injected/Utils.js not found at ${file}`);
  }
  const source = fs.readFileSync(file, 'utf8');
  if (source.includes('delete message.__x_id')) {
    return { applied: false };
  }
  if (!source.includes(FIND)) {
    throw new Error(`unexpected sendMessage() shape in ${UTILS_PATH}: refusing to patch blind`);
  }
  fs.writeFileSync(file, source.replace(FIND, REPLACE));
  return { applied: true };
}

function run() {
  const bestEffort = process.argv.includes('--best-effort');
  try {
    const { applied } = applyMediaXIdPatch();
    console.log(`patch-wwebjs-media-x-id: ${applied ? 'applied' : 'skipped (already present)'}`);
  } catch (error) {
    if (bestEffort) {
      console.warn(`patch-wwebjs-media-x-id: skipped, ${error.message}`);
      return;
    }
    console.error(`patch-wwebjs-media-x-id: ${error.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) run();

module.exports = { applyMediaXIdPatch, FIND, REPLACE, UTILS_PATH };
