#!/bin/sh
# Writes the API's OpenAPI document, generated from the operation registry, to
# src/lib/fields/apiOperations.json, condensed to each operation's input fields: the
# field-completeness test compares the mockup's field registry with it. Run after API changes: npm run snapshot:api
set -e

mockup_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
api_dir="$mockup_dir/../packages/api"
probe="$api_dir/src/lib/server/mockupSnapshot.test.ts"
snapshot="$mockup_dir/scripts/.openapi.snapshot.json"
out="$mockup_dir/src/lib/fields/apiOperations.json"

trap 'rm -f "$probe"' EXIT
cat > "$probe" <<'TS'
import { writeFileSync } from 'node:fs';
import { it } from 'vitest';

import { buildOpenApiDocument } from './openapi.js';

import './ops/index.js';

it('writes the OpenAPI snapshot for the mockup', () => {
  writeFileSync(
    process.env.MOCKUP_SNAPSHOT_OUT ?? '',
    `${JSON.stringify(buildOpenApiDocument(), null, 2)}\n`
  );
});
TS
(cd "$api_dir" && MOCKUP_SNAPSHOT_OUT="$snapshot" npx vitest run src/lib/server/mockupSnapshot.test.ts)
node "$mockup_dir/scripts/condense-openapi.mjs" "$snapshot" "$out"
