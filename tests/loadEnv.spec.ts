import { resolve } from 'node:path';
import { envFileCandidates } from '../src/loadEnv';

describe('envFileCandidates', () => {
  const buildDir = resolve('/opt/bring-mcp-catalog/build/src');

  it('looks next to the install before the working directory', () => {
    expect(envFileCandidates({}, buildDir, '/somewhere/else')).toEqual([
      resolve('/opt/bring-mcp-catalog/.env'),
      resolve('/opt/bring-mcp-catalog/build/.env'),
      resolve('/somewhere/else/.env'),
    ]);
  });

  it('puts an explicit BRING_MCP_ENV_FILE first', () => {
    const candidates = envFileCandidates({ BRING_MCP_ENV_FILE: '/etc/bring.env' }, buildDir, '/tmp');
    expect(candidates[0]).toBe('/etc/bring.env');
  });

  it('does not list the same file twice when started from the install directory', () => {
    const candidates = envFileCandidates({}, buildDir, '/opt/bring-mcp-catalog');
    expect(candidates).toHaveLength(2);
  });
});
