#!/usr/bin/env node
// Exits 0 when its argument is a `COUNTRY` that `api`'s first boot takes (spec §6.3 "First boot"),
// 1 otherwise, by the same rule the seed applies. The api image ships it at /app/check-country.mjs
// for setup.sh, which checks the answer before it writes .env:
//
//   docker run --rm <api image> node check-country.mjs DE
import { isSupportedCountry } from '@zamfono/shared';

const UNSUPPORTED_EXIT_CODE = 1;

const [, , code = ''] = process.argv;
if (!isSupportedCountry(code)) {
  process.exitCode = UNSUPPORTED_EXIT_CODE;
}
