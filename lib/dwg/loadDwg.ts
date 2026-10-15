/**
 * DWG → DXF 변환.
 *
 * LibreDWG 를 WebAssembly 로 빌드한 `@mlightcad/libredwg-web` 을 동적으로 불러와
 * DWG 바이트를 DXF 바이트로 바꾼다. 그 뒤는 DXF 경로와 완전히 같으므로
 * 렌더링 코드는 DWG 를 따로 알 필요가 없다.
 *
 * 주의: LibreDWG 는 GPL-3.0 이다. 이 모듈은 필요할 때만 동적 import 되므로
 * DXF 만 쓰는 번들에는 포함되지 않는다.
 */

/** public/ 아래에 복사된 wasm 위치 (scripts/copy-wasm.mjs 가 복사한다). */
const WASM_BASE = '/libredwg';

type LibreDwgLike = {
  dwg_write_dxf(content: ArrayBuffer): Uint8Array | null;
};

let instancePromise: Promise<LibreDwgLike> | null = null;

async function getLibreDwg(): Promise<LibreDwgLike> {
  if (!instancePromise) {
    instancePromise = (async () => {
      const mod = await import('@mlightcad/libredwg-web');
      // locateFile 이 `${base}/libredwg-web.wasm` 을 찾는다.
      return (await mod.LibreDwg.create(WASM_BASE)) as unknown as LibreDwgLike;
    })().catch((err) => {
      instancePromise = null;
      throw err;
    });
  }
  return instancePromise;
}

export class DwgConversionError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'DwgConversionError';
  }
}

/** DWG 바이트를 DXF 바이트로 변환한다. */
export async function dwgToDxf(buffer: ArrayBuffer): Promise<ArrayBuffer> {
  let lib: LibreDwgLike;
  try {
    lib = await getLibreDwg();
  } catch (err) {
    throw new DwgConversionError(
      'DWG 변환 모듈(LibreDWG WASM)을 불러오지 못했습니다. public/libredwg/ 에 wasm 파일이 있는지 확인하세요.',
      err,
    );
  }

  let dxf: Uint8Array | null;
  try {
    dxf = lib.dwg_write_dxf(buffer);
  } catch (err) {
    throw new DwgConversionError('DWG 파일을 읽는 중 오류가 발생했습니다.', err);
  }

  if (!dxf || dxf.byteLength === 0) {
    throw new DwgConversionError(
      'DWG를 DXF로 변환하지 못했습니다. 지원되지 않는 버전이거나 손상된 파일일 수 있습니다.',
    );
  }
  // 전송 가능한 독립 버퍼로 복사.
  const out = new Uint8Array(dxf.byteLength);
  out.set(dxf);
  return out.buffer;
}

/** 파일 시그니처로 DWG 인지 판별한다 ("AC10xx"). */
export function looksLikeDwg(buffer: ArrayBuffer): boolean {
  const b = new Uint8Array(buffer, 0, Math.min(6, buffer.byteLength));
  if (b.length < 6) return false;
  return b[0] === 0x41 && b[1] === 0x43 && b[2] >= 0x30 && b[2] <= 0x39; // 'A','C',digit
}
