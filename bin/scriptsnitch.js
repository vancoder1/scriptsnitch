#!/usr/bin/env node
// The scriptsnitch command line. See src/cli.js.
import { runCli } from '../src/cli.js';

process.exitCode = await runCli(process.argv.slice(2));
