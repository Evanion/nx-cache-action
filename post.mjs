// Post step of the setup action, run at the end of the job. It stops the
// gateway and copies its "not cached" lines into this step's summary and the
// job log: a background process's own output reaches neither. Node 20
// built-ins only.
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.env.RUNNER_TEMP ?? '';
const read = (name) => {
  try {
    return readFileSync(join(dir, name), 'utf8');
  } catch {
    return null;
  }
};

const pid = Number(read('nx-cache-gateway.pid'));
if (Number.isSafeInteger(pid) && pid > 0) {
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    // Already gone.
  }
}

const lines = (read('nx-cache-gateway.log') ?? '')
  .split('\n')
  .filter((l) => / not cached: /.test(l));
for (const line of lines) console.log(`::warning::${line}`);
if (lines.length > 0 && process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    [
      '### Nx cache: artifacts not cached',
      '',
      ...lines.map((l) => `- \`${l.replace(/`/g, "'")}\``),
      '',
    ].join('\n'),
  );
}
