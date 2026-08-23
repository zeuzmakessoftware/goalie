#!/usr/bin/env node

import { main } from './src/cli.js';

void main().catch(error => {
  process.stderr.write(`Goalie: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
