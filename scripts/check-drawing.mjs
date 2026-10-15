/**
 * 도면 파일 점검 CLI.
 *
 *   node scripts/check-drawing.mjs <파일경로> [--dump-dxf <출력경로>] [--space <배치이름>]
 *
 * 브라우저와 똑같은 경로(DWG → DXF → 파서 → 평탄화)를 Node 에서 돌려 보고,
 * 무엇이 읽혔고 무엇이 빠졌는지 요약한다. 브라우저를 열기 전에 파일이
 * 문제인지 뷰어가 문제인지 가르는 용도.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { loadLib } from './load-lib.mjs';

const require = createRequire(import.meta.url);

function usage() {
  console.error('사용법: node scripts/check-drawing.mjs <파일경로> [--dump-dxf <출력경로>] [--space <배치이름>]');
  process.exit(2);
}

const args = process.argv.slice(2);
if (args.length === 0) usage();
const inputPath = args[0];
const dumpIndex = args.indexOf('--dump-dxf');
const dumpPath = dumpIndex >= 0 ? args[dumpIndex + 1] : null;
if (dumpIndex >= 0 && !dumpPath) usage();
const spaceIndex = args.indexOf('--space');
const space = spaceIndex >= 0 ? args[spaceIndex + 1] : null;
if (spaceIndex >= 0 && !space) usage();

function looksLikeDwg(bytes) {
  return bytes.length >= 6 && bytes[0] === 0x41 && bytes[1] === 0x43 && bytes[2] >= 0x30 && bytes[2] <= 0x39;
}

async function dwgToDxf(bytes) {
  const entry = require.resolve('@mlightcad/libredwg-web');
  const wasmDir = join(dirname(entry), '..', 'wasm');
  const mod = await import(pathToFileURL(join(dirname(entry), 'libredwg-web.js')).href).catch(
    () => import('@mlightcad/libredwg-web'),
  );
  const lib = await mod.LibreDwg.create(wasmDir);
  const out = lib.dwg_write_dxf(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  if (!out || out.byteLength === 0) {
    throw new Error('LibreDWG 가 DWG → DXF 변환에 실패했습니다 (버전 미지원이거나 손상된 파일).');
  }
  return Buffer.from(out);
}

function table(rows) {
  const w = Math.max(...rows.map(([k]) => k.length));
  for (const [k, v] of rows) console.log(`  ${k.padEnd(w)}  ${v}`);
}

async function main() {
  const { parseDxf, flattenDocument } = await loadLib();

  let bytes = await readFile(inputPath);
  const isDwg = looksLikeDwg(bytes) || inputPath.toLowerCase().endsWith('.dwg');
  console.log(`\n파일: ${inputPath}  (${bytes.length.toLocaleString()} bytes)`);
  console.log(`시그니처: ${JSON.stringify(bytes.subarray(0, 6).toString('latin1'))}  → ${isDwg ? 'DWG 로 판단' : 'DXF 로 판단'}`);

  if (isDwg) {
    const t = Date.now();
    bytes = await dwgToDxf(bytes);
    console.log(`\n[DWG→DXF] ${bytes.length.toLocaleString()} bytes, ${Date.now() - t} ms`);
    if (dumpPath) {
      await writeFile(dumpPath, bytes);
      console.log(`[DWG→DXF] 변환 결과 저장: ${dumpPath}`);
    }
  }

  const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const t0 = Date.now();
  const doc = parseDxf(ab);
  const t1 = Date.now();
  const scene = flattenDocument(doc, { darkBackground: true, space });
  const t2 = Date.now();

  const byType = {};
  for (const e of doc.entities) byType[e.type] = (byType[e.type] ?? 0) + 1;

  console.log('\n[파싱]');
  table([
    ['형식', doc.source],
    ['버전', doc.version || '(없음)'],
    ['레이어', String(doc.layers.size)],
    ['선종류', String(doc.lineTypes.size)],
    ['블록', String(doc.blocks.size)],
    ['엔티티', String(doc.entities.length)],
    ['공간', doc.layouts.map((l) => (l.isModelSpace ? `${l.name}(모형)` : l.name)).join(', ') || '(없음)'],
    ['소요', `${t1 - t0} ms`],
  ]);
  console.log('\n  엔티티 종류:', JSON.stringify(byType));
  const skipped = Object.keys(doc.skipped);
  console.log('  건너뜀:', skipped.length ? JSON.stringify(doc.skipped) : '(없음)');

  console.log(`\n[평탄화]  공간: ${space ?? '모형'}`);
  table([
    ['경로', scene.paths.length.toLocaleString()],
    ['문자', scene.texts.length.toLocaleString()],
    ['채움', scene.fills.length.toLocaleString()],
    ['선분', scene.stats.segments.toLocaleString()],
    ['범위', scene.bounds ? `X ${scene.bounds.minX.toFixed(1)} … ${scene.bounds.maxX.toFixed(1)}  Y ${scene.bounds.minY.toFixed(1)} … ${scene.bounds.maxY.toFixed(1)}` : '(없음)'],
    ['잘림', scene.stats.truncated ? '예 — 상한 초과' : '아니오'],
    ['소요', `${t2 - t1} ms`],
  ]);

  if (!scene.bounds) {
    console.log('\n⚠ 그릴 것이 없습니다 — 뷰어에서도 빈 화면이 나옵니다.');
    process.exitCode = 1;
  } else if (scene.texts.length) {
    console.log('\n  문자 예시:', scene.texts.slice(0, 5).map((t) => t.text.replace(/\n/g, ' / ')));
  }
  console.log();
}

main().catch((err) => {
  console.error('\n실패:', err.message);
  process.exitCode = 1;
});
