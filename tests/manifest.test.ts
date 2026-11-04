/**
 * 发布前检查（`pnpm check:extension`）在部分机器上跑不动：它经 tsx 转译并 spawn 子进程。
 * 这里直接调用同一批函数——manifest 解析、干装载、自描述比对——把检查留在测试里。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EXTENSION_API_VERSIONS, parseExtensionManifest } from 'cortico/extensions/manifest.ts';
import { checkDescribe } from 'cortico/extensions/describe-export.ts';
import { WEATHER } from '../src/definition.ts';

const pkgDir = process.cwd();
const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as Record<string, unknown>;

let scratchDir: string;
beforeEach(() => {
  scratchDir = mkdtempSync(join(tmpdir(), 'weather-check-'));
});
afterEach(() => rmSync(scratchDir, { recursive: true, force: true }));

describe('扩展契约', () => {
  it('manifest 认得出是 world，契约版本与框架一致', () => {
    const parsed = parseExtensionManifest(pkg, 'en');
    if (!parsed.ok) throw new Error(`manifest 不合法：${parsed.reasons.join('；')}`);
    expect(parsed.manifest.kind).toBe('world');
    expect(parsed.manifest.api).toBe(EXTENSION_API_VERSIONS.world);
  });

  it('包的 id 与定义一致', () => {
    expect(WEATHER.id).toBe('weather');
    expect(pkg.name).toBe('cortico-world-weather');
  });

  it('describe.json 与代码里的自描述逐字相同', async () => {
    const report = await checkDescribe('world', WEATHER, 'describe.json', {
      scratchDir,
      packageDir: pkgDir,
      repoRoot: pkgDir,
      language: 'en',
    });
    expect(report.failures).toEqual([]);
  });

  it('describe.json 会随包发布', () => {
    expect(pkg.files).toContain('describe.json');
  });

  it('面板产物会随包发布', () => {
    const block = pkg.cortico as Record<string, unknown>;
    expect(block.webUiClient).toBe('dist/webui.js');
    expect(pkg.files).toContain('dist');
  });
});
