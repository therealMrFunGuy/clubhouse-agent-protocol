#!/usr/bin/env node
/**
 * Vendor the pool engine out of the private Clubhouse repo into this package.
 *
 * The whole value of @goclubhouse/pool-sim is that it is byte-for-byte the engine
 * the server runs. That only stays true if vendoring is mechanical, so this
 * script is the ONLY sanctioned way to update src/engine — never hand-edit the
 * vendored files.
 *
 * It also records a content hash per file in manifest.json. `npm test` checks
 * the vendored bytes against those hashes, so a hand-edit or a partial sync
 * fails loudly instead of silently shipping an engine that disagrees with the
 * server.
 *
 *   node scripts/sync-from-core.mjs [--core /path/to/clubhouse]
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = resolve(HERE, '..');
const OUT = join(PKG, 'src', 'engine');

/** Files that make up the pure engine, in dependency order. */
const FILES = ['constants.ts', 'physics.ts', 'rack.ts', 'groups.ts', 'matchState.ts'];

/** Anything matching these means the file is not pure and must not be vendored. */
const IMPURITY = [
  [/\bDate\.now\s*\(/, 'Date.now()'],
  [/\bMath\.random\s*\(/, 'Math.random()'],
  [/\bnew Date\s*\(\s*\)/, 'new Date()'],
  [/from\s+['"]@\/lib\/(database|security|games\/store)/, 'server-only import'],
  [/\brequire\s*\(/, 'CommonJS require()'],
  [/\bprocess\.env\b/, 'process.env'],
];

function parseArgs() {
  const i = process.argv.indexOf('--core');
  const core = i !== -1 ? process.argv[i + 1] : process.env.CLUBHOUSE_CORE;
  return core ?? join(process.env.HOME ?? '', 'clubhouse');
}

const core = parseArgs();
const srcDir = join(core, 'lib', 'games', 'pool');

if (!existsSync(srcDir)) {
  console.error(
    `Cannot find the pool engine at ${srcDir}\n` +
      `Pass --core /path/to/clubhouse, or set CLUBHOUSE_CORE.`,
  );
  process.exit(1);
}

mkdirSync(OUT, { recursive: true });

const manifest = {};
let failed = false;

for (const file of FILES) {
  const from = join(srcDir, file);
  if (!existsSync(from)) {
    console.error(`  MISSING  ${file} — expected at ${from}`);
    failed = true;
    continue;
  }

  const original = readFileSync(from, 'utf8');

  // Purity gate. If the server engine ever gains a hidden clock or RNG, the
  // package's core promise ("same inputs, same outputs") is broken and we must
  // not ship it.
  for (const [pattern, label] of IMPURITY) {
    if (pattern.test(original)) {
      console.error(`  IMPURE   ${file} — contains ${label}; refusing to vendor`);
      failed = true;
    }
  }

  // Rewrite the app's path alias to relative imports so the package stands
  // alone, and add the .js extensions that Node16 ESM resolution requires.
  // The core is bundled by Next.js and can omit them; a published package
  // cannot. Note the extension is added to the *source* import specifier — TS
  // emits it verbatim, and it resolves against the compiled .js at runtime.
  const rewritten = original
    .replace(/from\s+['"]@\/lib\/games\/pool\/([a-zA-Z0-9_-]+)['"]/g, "from './$1.js'")
    .replace(/from\s+['"]\.\/([a-zA-Z0-9_-]+)(?<!\.js)['"]/g, "from './$1.js'");

  if (/@\/lib\//.test(rewritten)) {
    console.error(`  ALIAS    ${file} — unresolved @/lib import remains`);
    failed = true;
  }

  writeFileSync(join(OUT, file), rewritten);
  manifest[file] = {
    sha256: createHash('sha256').update(rewritten, 'utf8').digest('hex'),
    lines: rewritten.split('\n').length,
  };
  console.log(`  vendored ${file.padEnd(16)} ${manifest[file].lines} lines`);
}

if (failed) {
  console.error('\nSync failed. Nothing was published.');
  process.exit(1);
}

writeFileSync(
  join(PKG, 'manifest.json'),
  `${JSON.stringify({ source: 'lib/games/pool', files: manifest }, null, 2)}\n`,
);

console.log(`\nVendored ${FILES.length} files. manifest.json updated.`);
console.log('Run `npm test` to confirm the engine still reproduces the golden vectors.');
