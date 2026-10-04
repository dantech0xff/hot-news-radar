import { readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const testsRoot = dirname(fileURLToPath(import.meta.url));

async function findTests(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await findTests(path));
    else if (entry.name.endsWith('.test.js')) files.push(path);
  }
  return files;
}

const files = (await findTests(testsRoot)).sort();
if (files.length === 0) {
  throw new Error('No Node test files found');
}

const child = spawn(process.execPath, [
  '--test',
  '--import', join(testsRoot, 'helpers/deny-network.js'),
  ...files,
], { stdio: 'inherit' });

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
