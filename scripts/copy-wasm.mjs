/**
 * LibreDWG 의 wasm 바이너리를 public/libredwg/ 로 복사한다.
 *
 * emscripten 글루 코드는 런타임에 `${base}/libredwg-web.wasm` 을 fetch 하므로
 * 번들러가 아니라 정적 파일로 서빙돼야 한다. predev/prebuild 에서 실행된다.
 */
import { createRequire } from 'node:module';
import { copyFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);

const FILES = ['libredwg-web.wasm'];
const DEST = join(process.cwd(), 'public', 'libredwg');

async function main() {
  let wasmDir;
  try {
    // 패키지의 exports 맵이 ./package.json 을 막아 두므로 진입점에서 거슬러 올라간다.
    // (dist/libredwg-web.umd.cjs → 패키지 루트 → wasm/)
    const entry = require.resolve('@mlightcad/libredwg-web');
    wasmDir = join(dirname(entry), '..', 'wasm');
    if (!existsSync(wasmDir)) wasmDir = join(dirname(entry), 'wasm');
  } catch {
    console.warn('[copy-wasm] @mlightcad/libredwg-web 가 설치돼 있지 않습니다. DWG 지원 없이 진행합니다.');
    return;
  }

  await mkdir(DEST, { recursive: true });
  for (const file of FILES) {
    const src = join(wasmDir, file);
    if (!existsSync(src)) {
      console.warn(`[copy-wasm] 찾을 수 없음: ${src}`);
      continue;
    }
    await copyFile(src, join(DEST, file));
    console.log(`[copy-wasm] ${file} → public/libredwg/`);
  }
}

main().catch((err) => {
  console.error('[copy-wasm] 실패:', err);
  process.exitCode = 1;
});
