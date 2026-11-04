/** 生成 describe.json：内容与 `pnpm check:extension` 从代码重新生成的一致。 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exportDescribe } from 'cortico/extensions/describe-export.ts';
import definition from '../src/index.ts';

const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scratchDir = mkdtempSync(join(tmpdir(), 'weather-describe-'));
try {
  const file = await exportDescribe('world', definition, {
    scratchDir,
    packageDir: pkgDir,
    repoRoot: pkgDir,
    language: 'en',
  });
  if (!file) throw new Error('World definition has no describe.');
  writeFileSync(join(pkgDir, 'describe.json'), `${JSON.stringify(file, null, 2)}\n`, 'utf8');
  console.log(
    `Wrote describe.json: tools ${file.tools?.length ?? 0}, events ${file.events?.length ?? 0}, prompts ${file.prompts?.length ?? 0}.`,
  );
} finally {
  rmSync(scratchDir, { recursive: true, force: true });
}
