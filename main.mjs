// Step entry point of the setup action. The runner hands inputs over as
// INPUT_<NAME> with hyphens kept, which bash cannot read, so this maps them to
// the names setup.sh reads and runs it. Node 20 built-ins only.
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const actionDir = dirname(fileURLToPath(import.meta.url));
const input = (name) => process.env[`INPUT_${name.toUpperCase()}`] ?? '';

const result = spawnSync('bash', [join(actionDir, 'setup.sh')], {
  stdio: 'inherit',
  env: {
    ...process.env,
    GITHUB_ACTION_PATH: actionDir,
    INPUT_SERVER: input('server'),
    INPUT_READ_TOKEN: input('read-token'),
    INPUT_LARGE_UPLOAD_THRESHOLD: input('large-upload-threshold'),
  },
});
if (result.error) {
  console.log(`::error::setup.sh could not run: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
