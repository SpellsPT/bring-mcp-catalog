import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from 'dotenv';

/**
 * Load settings from a `.env` file before anything reads `process.env`.
 *
 * `dotenv/config` only looks in the current working directory, and an MCP
 * client usually starts the server from somewhere else entirely - so a `.env`
 * sitting next to the install was silently ignored and the server started with
 * no credentials. Look in the install directory as well.
 *
 * Order: BRING_MCP_ENV_FILE if set, then the install directory, then the
 * working directory. Variables the client already passed in always win; a file
 * never overrides them.
 */
export function envFileCandidates(
  environment: NodeJS.ProcessEnv = process.env,
  baseDirectory = __dirname,
  cwd = process.cwd(),
): string[] {
  const candidates = [
    environment.BRING_MCP_ENV_FILE,
    resolve(baseDirectory, '../../.env'),
    resolve(baseDirectory, '../.env'),
    resolve(cwd, '.env'),
  ].filter((candidate): candidate is string => Boolean(candidate));
  return [...new Set(candidates)];
}

for (const path of envFileCandidates()) {
  if (existsSync(path)) {
    config({ path, quiet: true });
    break;
  }
}
