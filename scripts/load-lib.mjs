/**
 * `lib/dxf` 의 TypeScript 를 Node 에서 쓸 수 있게 CommonJS 로 미리 컴파일한다.
 * 점검 CLI(`check-drawing.mjs`)와 테스트(`test-viewport.mjs`)가 함께 쓴다.
 */
import { createRequire } from 'node:module';
import { join } from 'node:path';

const require = createRequire(import.meta.url);

export async function loadLib() {
  const outDir = join(process.cwd(), '.check-build');
  const tsc = join(process.cwd(), 'node_modules', 'typescript', 'bin', 'tsc');
  const { spawnSync } = await import('node:child_process');
  const res = spawnSync(
    process.execPath,
    [
      tsc,
      'lib/dxf/parser.ts',
      'lib/dxf/flatten.ts',
      'lib/dxf/lexer.ts',
      'lib/dxf/colors.ts',
      'lib/dxf/types.ts',
      '--module', 'commonjs',
      '--moduleResolution', 'node',
      '--target', 'es2020',
      '--skipLibCheck',
      '--outDir', outDir,
      '--rootDir', 'lib',
    ],
    { stdio: 'inherit' },
  );
  if (res.status !== 0) throw new Error('lib 컴파일 실패');
  const flatten = require(join(outDir, 'dxf', 'flatten.js'));
  return {
    parseDxf: require(join(outDir, 'dxf', 'parser.js')).parseDxf,
    flattenDocument: flatten.flattenDocument,
    stripMTextFormatting: flatten.stripMTextFormatting,
  };
}
