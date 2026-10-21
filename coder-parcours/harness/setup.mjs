#!/usr/bin/env node
// setup.mjs — installiert die Werkzeugkette: npm-Pakete (lockfile-genau) und Python-venv mit publicbrowser.
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { toolchainDir } from './participants.mjs';

const dir = toolchainDir();
const venv = join(dir, '.venv');
const python = process.env.CODER_PARCOURS_PYTHON || 'python3';

const run = (file, args) => {
  console.log(`$ ${file} ${args.join(' ')}`);
  const r = spawnSync(file, args, { stdio: 'inherit' });
  if (r.status !== 0) {
    console.error(`setup failed: ${file} exited with ${r.status ?? r.error?.message}`);
    process.exit(1);
  }
};

run('npm', ['ci', '--prefix', dir]);
run(python, ['-m', 'venv', venv]);
run(join(venv, 'bin', 'pip'), ['install', '-r', join(dir, 'requirements.txt')]);
console.log('toolchain ready; check with: node harness/doctor.mjs');
