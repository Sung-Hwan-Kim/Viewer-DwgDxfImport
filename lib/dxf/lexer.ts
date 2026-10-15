import type { DxfPair } from './types';

/**
 * DXF 렉서: 파일 바이트를 (group code, value) 쌍의 배열로 변환한다.
 *
 * ASCII DXF와 Binary DXF("AutoCAD Binary DXF\r\n\x1a\x00" 시그니처) 두 가지를
 * 모두 처리한다. 인코딩은 UTF-8 우선, 실패 시 Windows-949/1252로 재시도한다
 * (구버전 DXF는 코드페이지 기반이라 한글 레이어명이 깨지는 것을 막기 위함).
 */

const BINARY_SENTINEL = 'AutoCAD Binary DXF\r\n\u001a\u0000';

export type DxfFlavor = 'dxf-ascii' | 'dxf-binary';

export interface LexResult {
  pairs: DxfPair[];
  flavor: DxfFlavor;
}

/** group code → 값 타입. DXF 사양의 코드 범위 표를 따른다. */
export function codeValueType(code: number): 'string' | 'number' | 'int' | 'bool' | 'binary' {
  if (code >= 0 && code <= 9) return 'string';
  if (code >= 10 && code <= 59) return 'number';
  if (code >= 60 && code <= 79) return 'int';
  if (code >= 90 && code <= 99) return 'int';
  if (code === 100 || code === 102 || code === 105) return 'string';
  if (code >= 110 && code <= 149) return 'number';
  if (code >= 160 && code <= 169) return 'int';
  if (code >= 170 && code <= 179) return 'int';
  if (code >= 210 && code <= 239) return 'number';
  if (code >= 270 && code <= 289) return 'int';
  if (code >= 290 && code <= 299) return 'bool';
  if (code >= 300 && code <= 309) return 'string';
  if (code >= 310 && code <= 319) return 'binary';
  if (code >= 320 && code <= 369) return 'string';
  if (code >= 370 && code <= 389) return 'int';
  if (code >= 390 && code <= 399) return 'string';
  if (code >= 400 && code <= 409) return 'int';
  if (code >= 410 && code <= 419) return 'string';
  if (code >= 420 && code <= 429) return 'int';
  if (code >= 430 && code <= 439) return 'string';
  if (code >= 440 && code <= 449) return 'int';
  if (code >= 450 && code <= 459) return 'int';
  if (code >= 460 && code <= 469) return 'number';
  if (code >= 470 && code <= 481) return 'string';
  if (code === 999) return 'string';
  if (code >= 1000 && code <= 1009) return 'string';
  if (code >= 1010 && code <= 1059) return 'number';
  if (code >= 1060 && code <= 1070) return 'int';
  if (code === 1071) return 'int';
  return 'string';
}

function looksBinary(bytes: Uint8Array): boolean {
  if (bytes.length < BINARY_SENTINEL.length) return false;
  for (let i = 0; i < BINARY_SENTINEL.length; i++) {
    if (bytes[i] !== BINARY_SENTINEL.charCodeAt(i)) return false;
  }
  return true;
}

/**
 * 바이트를 문자열로 디코딩한다. UTF-8로 읽어 U+FFFD가 많이 나오면
 * 레거시 코드페이지(cp949 → windows-1252)로 다시 시도한다.
 */
function decodeText(bytes: Uint8Array): string {
  const utf8 = new TextDecoder('utf-8').decode(bytes);
  const replacements = (utf8.match(/�/g) ?? []).length;
  // 1만 자당 1개 이상 깨졌으면 UTF-8이 아니라고 본다.
  if (replacements === 0 || replacements * 10000 < utf8.length) return utf8;

  for (const enc of ['windows-949', 'windows-1252']) {
    try {
      const decoded = new TextDecoder(enc, { fatal: false }).decode(bytes);
      if ((decoded.match(/�/g) ?? []).length < replacements) return decoded;
    } catch {
      // 브라우저가 해당 인코딩을 모르면 무시하고 다음 후보로.
    }
  }
  return utf8;
}

function parseValue(code: number, raw: string): string | number | boolean {
  switch (codeValueType(code)) {
    case 'number': {
      const n = Number.parseFloat(raw);
      return Number.isFinite(n) ? n : 0;
    }
    case 'int': {
      const n = Number.parseInt(raw, 10);
      return Number.isFinite(n) ? n : 0;
    }
    case 'bool':
      return raw.trim() !== '0';
    default:
      return raw;
  }
}

function lexAscii(text: string): DxfPair[] {
  const pairs: DxfPair[] = [];
  // \r\n, \n, \r 모두 허용.
  const lines = text.split(/\r\n|\r|\n/);
  const n = lines.length;

  for (let i = 0; i + 1 < n; i += 2) {
    const codeRaw = lines[i].trim();
    if (codeRaw === '') {
      // 끝의 빈 줄. 한 칸만 밀어서 정렬을 되찾아 본다.
      i -= 1;
      continue;
    }
    const code = Number.parseInt(codeRaw, 10);
    if (!Number.isFinite(code)) {
      // 코드 자리가 깨졌다 — 한 줄 밀어 재동기화를 시도한다.
      i -= 1;
      continue;
    }
    const raw = lines[i + 1];
    if (code === 999) continue; // 주석
    pairs.push({ code, value: parseValue(code, raw) });
    if (code === 0 && raw.trim() === 'EOF') break;
  }
  return pairs;
}

function lexBinary(bytes: Uint8Array): DxfPair[] {
  const pairs: DxfPair[] = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let p = BINARY_SENTINEL.length;

  // R13 이후 바이너리 DXF는 그룹 코드가 2바이트(little endian)다.
  // R12는 1바이트지만, 0xFF 확장 규칙으로 구분한다.
  const readCode = (): number | null => {
    if (p >= bytes.length) return null;
    const first = bytes[p];
    if (first === 0xff) {
      if (p + 3 > bytes.length) return null;
      const code = view.getUint16(p + 1, true);
      p += 3;
      return code;
    }
    // 2바이트 코드로 읽는다 (R13+ 표준).
    if (p + 2 > bytes.length) return null;
    const code = view.getUint16(p, true);
    p += 2;
    return code;
  };

  const readString = (): string => {
    const start = p;
    while (p < bytes.length && bytes[p] !== 0) p++;
    const s = decodeText(bytes.subarray(start, p));
    p++; // NUL 건너뛰기
    return s;
  };

  while (p < bytes.length) {
    const code = readCode();
    if (code === null) break;

    switch (codeValueType(code)) {
      case 'number': {
        if (p + 8 > bytes.length) return pairs;
        pairs.push({ code, value: view.getFloat64(p, true) });
        p += 8;
        break;
      }
      case 'int': {
        // 60~79/170~179 등은 16bit, 90~99/420~429 등은 32bit, 160~169는 64bit.
        if (code >= 160 && code <= 169) {
          if (p + 8 > bytes.length) return pairs;
          pairs.push({ code, value: Number(view.getBigInt64(p, true)) });
          p += 8;
        } else if ((code >= 90 && code <= 99) || (code >= 420 && code <= 429) || (code >= 440 && code <= 459)) {
          if (p + 4 > bytes.length) return pairs;
          pairs.push({ code, value: view.getInt32(p, true) });
          p += 4;
        } else {
          if (p + 2 > bytes.length) return pairs;
          pairs.push({ code, value: view.getInt16(p, true) });
          p += 2;
        }
        break;
      }
      case 'bool': {
        if (p + 1 > bytes.length) return pairs;
        pairs.push({ code, value: bytes[p] !== 0 });
        p += 1;
        break;
      }
      case 'binary': {
        if (p + 1 > bytes.length) return pairs;
        const len = bytes[p];
        p += 1 + len;
        pairs.push({ code, value: '' });
        break;
      }
      default: {
        const s = readString();
        pairs.push({ code, value: s });
        if (code === 0 && s === 'EOF') return pairs;
        break;
      }
    }
  }
  return pairs;
}

export function lexDxf(buffer: ArrayBuffer): LexResult {
  const bytes = new Uint8Array(buffer);
  if (looksBinary(bytes)) {
    return { pairs: lexBinary(bytes), flavor: 'dxf-binary' };
  }
  return { pairs: lexAscii(decodeText(bytes)), flavor: 'dxf-ascii' };
}
