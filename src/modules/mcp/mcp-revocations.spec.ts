import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { RevocationList } from './mcp-revocations';

describe('RevocationList', () => {
  let dir: string;
  const now = () => Math.floor(Date.now() / 1000);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mcp-revocations-'));
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('remembers a revocation across a restart', () => {
    const file = join(dir, 'nested', 'revocations.json');
    new RevocationList(file).add('grant:abc', now() + 3600);

    const reloaded = new RevocationList(file);
    expect(reloaded.has('grant:abc')).toBe(true);
    expect(reloaded.has('grant:other')).toBe(false);
  });

  it('keeps the file private to the server', () => {
    const file = join(dir, 'revocations.json');
    new RevocationList(file).add('jti:1', now() + 60);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('drops entries once what they block has expired', () => {
    const file = join(dir, 'revocations.json');
    writeFileSync(file, JSON.stringify({ 'grant:old': now() - 10, 'grant:live': now() + 600 }));

    const list = new RevocationList(file);
    expect(list.has('grant:old')).toBe(false);
    expect(list.has('grant:live')).toBe(true);
    list.add('jti:new', now() + 60);
    expect(Object.keys(JSON.parse(readFileSync(file, 'utf8'))).sort()).toEqual(['grant:live', 'jti:new']);
  });

  it('ignores an already-expired revocation and never shortens one', () => {
    const file = join(dir, 'revocations.json');
    const list = new RevocationList(file);
    list.add('jti:gone', now() - 1);
    expect(list.has('jti:gone')).toBe(false);
    expect(existsSync(file)).toBe(false);

    list.add('grant:x', now() + 3600);
    list.add('grant:x', now() + 60);
    expect(JSON.parse(readFileSync(file, 'utf8'))['grant:x']).toBeGreaterThan(now() + 3000);
  });

  it('starts empty from a damaged file instead of failing', () => {
    const file = join(dir, 'revocations.json');
    writeFileSync(file, '{not json');
    const list = new RevocationList(file);
    expect(list.size).toBe(0);
    list.add('grant:y', now() + 60);
    expect(new RevocationList(file).has('grant:y')).toBe(true);
  });

  it('works in memory when there is no file', () => {
    const list = new RevocationList(null);
    list.add('grant:z', now() + 60);
    expect(list.has('grant:z')).toBe(true);
  });
});
