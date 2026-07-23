#!/usr/bin/env node
import { buildAll } from '../build.js';

const clean = process.argv.includes('--clean');
buildAll({ clean }).catch(err => {
  console.error('[build] failed:', err);
  process.exit(1);
});
