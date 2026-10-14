'use strict';

// Clear NODE_OPTIONS before a fresh process so inherited preloads cannot instrument the POC.
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const env = { ...process.env };
for (const key of Object.keys(env)) {
  if (key.startsWith('OTEL_') || ['NODE_OPTIONS', 'NODE_PATH', 'DEBUG', 'NODE_DEBUG', 'NODE_DEBUG_NATIVE'].includes(key)) {
    delete env[key];
  }
}
const result = spawnSync(process.execPath, [path.join(__dirname, 'repro.cjs'), ...process.argv.slice(2)], {
  env,
  stdio: 'inherit',
});
process.exitCode = result.status ?? 1;
