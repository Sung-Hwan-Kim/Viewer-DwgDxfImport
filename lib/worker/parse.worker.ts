/// <reference lib="webworker" />

import { type FlatScene, flattenDocument, listSpaces } from '../dxf/flatten';
import { parseDxf } from '../dxf/parser';
import type { DxfDocument } from '../dxf/types';

/**
 * 파싱 워커.
 *
 * 큰 도면은 파싱과 평탄화에 수 초가 걸릴 수 있어 메인 스레드에서 돌리면
 * UI 가 멈춘다. 여기서 끝내고 결과만 넘긴다.
 *
 * 공간(모형/배치)을 바꿀 때 파일을 다시 보내지 않도록 마지막으로 읽은
 * 문서를 여기에 들고 있는다. 메인 스레드가 ArrayBuffer 사본을 들고 있는
 * 것보다 싸고(버퍼는 그대로 transfer 로 넘겨 떼어낸다), 다시 파싱할
 * 필요도 없다.
 */

export interface ParseRequest {
  kind: 'parse';
  id: number;
  fileName: string;
  buffer: ArrayBuffer;
  darkBackground: boolean;
}

/** 이미 읽어 둔 도면에서 다른 공간을 다시 평탄화한다. */
export interface SpaceRequest {
  kind: 'space';
  id: number;
  /** null 이면 모형 공간 */
  space: string | null;
  darkBackground: boolean;
  /** 배치의 용지 테두리를 그릴지 */
  paperBorder: boolean;
}

export type WorkerRequest = ParseRequest | SpaceRequest;

export interface SpaceInfo {
  name: string;
  isModelSpace: boolean;
}

export interface ParseSuccess {
  id: number;
  ok: true;
  scene: FlatScene;
  /** 이 장면이 어느 공간인지. null = 모형 공간 */
  space: string | null;
  info: {
    fileName: string;
    format: 'dxf-ascii' | 'dxf-binary' | 'dwg';
    version: string;
    layers: { name: string; colorIndex: number; off: boolean; frozen: boolean }[];
    spaces: SpaceInfo[];
    blockCount: number;
    entityCount: number;
    skipped: Record<string, number>;
    parseMs: number;
  };
}

export interface ParseFailure {
  id: number;
  ok: false;
  error: string;
}

export type ParseResponse = ParseSuccess | ParseFailure;

/** 마지막으로 읽은 도면 — 공간 전환에 재사용한다. */
let cached: { doc: DxfDocument; info: Omit<ParseSuccess['info'], 'parseMs'> } | null = null;

async function handleParse(req: ParseRequest): Promise<ParseResponse> {
  const started = performance.now();
  try {
    // 새 파일을 읽기 전에 이전 문서를 놓아 준다 — 두 도면이 동시에 메모리에
    // 남지 않게.
    cached = null;

    let buffer = req.buffer;
    let format: 'dxf-ascii' | 'dxf-binary' | 'dwg' = 'dxf-ascii';

    const { looksLikeDwg, dwgToDxf } = await import('../dwg/loadDwg');
    const isDwg = looksLikeDwg(buffer) || req.fileName.toLowerCase().endsWith('.dwg');

    if (isDwg) {
      buffer = await dwgToDxf(buffer);
      format = 'dwg';
    }

    const doc = parseDxf(buffer);
    if (format !== 'dwg') format = doc.source;

    if (doc.entities.length === 0 && doc.blocks.size === 0) {
      return {
        id: req.id,
        ok: false,
        error: '도면 데이터를 찾지 못했습니다. DXF/DWG 파일이 맞는지 확인하세요.',
      };
    }

    const scene = flattenDocument(doc, { darkBackground: req.darkBackground, space: null });

    cached = {
      doc,
      info: {
        fileName: req.fileName,
        format,
        version: doc.version,
        layers: [...doc.layers.values()].map((l) => ({
          name: l.name,
          colorIndex: l.colorIndex,
          off: l.off,
          frozen: l.frozen,
        })),
        spaces: listSpaces(doc),
        blockCount: doc.blocks.size,
        entityCount: doc.entities.length,
        skipped: doc.skipped,
      },
    };

    return {
      id: req.id,
      ok: true,
      scene,
      space: null,
      info: { ...cached.info, parseMs: Math.round(performance.now() - started) },
    };
  } catch (err) {
    cached = null;
    return {
      id: req.id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function handleSpace(req: SpaceRequest): ParseResponse {
  const started = performance.now();
  if (!cached) {
    return { id: req.id, ok: false, error: '먼저 도면을 열어야 합니다.' };
  }
  try {
    const scene = flattenDocument(cached.doc, {
      darkBackground: req.darkBackground,
      space: req.space,
      paperBorder: req.paperBorder,
    });
    return {
      id: req.id,
      ok: true,
      scene,
      space: req.space,
      info: { ...cached.info, parseMs: Math.round(performance.now() - started) },
    };
  } catch (err) {
    return {
      id: req.id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

self.addEventListener('message', (event: MessageEvent<WorkerRequest>) => {
  const req = event.data;
  const result = req.kind === 'space' ? Promise.resolve(handleSpace(req)) : handleParse(req);
  void result.then((res) => {
    (self as unknown as Worker).postMessage(res);
  });
});
