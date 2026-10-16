'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type * as THREE from 'three';

import DrawingCanvas, { type DrawingCanvasHandle } from './DrawingCanvas';
import LayerPanel, { type LayerRow } from './LayerPanel';
import type { FlatScene } from '@/lib/dxf/flatten';
import {
  type BuildOptions,
  type SketchStyle,
  STYLE_TOKENS,
  buildSketchScene,
} from '@/lib/three/sketchScene';
import type { ParseResponse, ParseSuccess } from '@/lib/worker/parse.worker';

type Info = ParseSuccess['info'];

const STYLE_LABELS: Record<SketchStyle, string> = {
  cad: 'CAD (어두운 배경)',
  paper: '제도지',
  blueprint: '청사진',
  sketch: '손그림 스케치',
};

const SAMPLE_URL = '/samples/apartment.dxf';

function formatNumber(n: number): string {
  return n.toLocaleString('ko-KR');
}

export default function CadViewer() {
  const canvasRef = useRef<DrawingCanvasHandle>(null);
  const workerRef = useRef<Worker | null>(null);
  const requestId = useRef(0);

  const [scene, setScene] = useState<FlatScene | null>(null);
  const [info, setInfo] = useState<Info | null>(null);
  /** 지금 그리고 있는 공간. null = 모형 공간 */
  const [space, setSpace] = useState<string | null>(null);
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  const [zoomLabel, setZoomLabel] = useState('');

  const [style, setStyle] = useState<SketchStyle>('cad');
  const [monochrome, setMonochrome] = useState(false);
  const [jitter, setJitter] = useState(0.5);
  const [showText, setShowText] = useState(true);
  const [showFills, setShowFills] = useState(true);
  const [showHatchPattern, setShowHatchPattern] = useState(true);
  const [showLineWeights, setShowLineWeights] = useState(true);
  const [paperBorder, setPaperBorder] = useState(true);
  const [hiddenLayers, setHiddenLayers] = useState<Set<string>>(new Set());

  // ---- 워커 ----
  useEffect(() => {
    const worker = new Worker(new URL('../lib/worker/parse.worker.ts', import.meta.url), {
      type: 'module',
    });
    worker.onmessage = (event: MessageEvent<ParseResponse>) => {
      const res = event.data;
      // 뒤늦게 도착한 이전 요청의 결과는 버린다.
      if (res.id !== requestId.current) return;
      if (res.ok) {
        setScene(res.scene);
        setInfo(res.info);
        setSpace(res.space);
        setStatus('ready');
        setError(null);
      } else {
        setScene(null);
        setInfo(null);
        setStatus('error');
        setError(res.error);
      }
    };
    worker.onerror = (event) => {
      setStatus('error');
      setError(event.message || '파싱 워커에서 오류가 발생했습니다.');
    };
    workerRef.current = worker;
    return () => {
      worker.terminate();
      workerRef.current = null;
    };
  }, []);

  const loadBuffer = useCallback((buffer: ArrayBuffer, fileName: string) => {
    const worker = workerRef.current;
    if (!worker) return;
    setStatus('loading');
    setError(null);
    setHiddenLayers(new Set());
    const id = ++requestId.current;
    // 버퍼는 워커로 넘겨 버린다(detach). 공간을 바꿀 때는 파일을 다시 보내는
    // 대신 워커가 들고 있는 문서를 재사용하므로 사본이 필요 없다.
    worker.postMessage({ kind: 'parse', id, fileName, buffer, darkBackground: true }, [buffer]);
  }, []);

  /** 모형 ↔ 배치 전환 — 워커가 캐시해 둔 문서를 다시 평탄화한다. */
  const selectSpace = useCallback(
    (next: string | null, border = paperBorder) => {
      const worker = workerRef.current;
      if (!worker) return;
      setStatus('loading');
      setError(null);
      const id = ++requestId.current;
      worker.postMessage({
        kind: 'space',
        id,
        space: next,
        darkBackground: true,
        paperBorder: border,
      });
    },
    [paperBorder],
  );

  const loadFile = useCallback(
    async (file: File) => {
      try {
        const buffer = await file.arrayBuffer();
        loadBuffer(buffer, file.name);
      } catch (err) {
        setStatus('error');
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [loadBuffer],
  );

  const loadSample = useCallback(async () => {
    setStatus('loading');
    try {
      const res = await fetch(SAMPLE_URL);
      if (!res.ok) throw new Error(`예제 파일을 불러오지 못했습니다 (${res.status})`);
      loadBuffer(await res.arrayBuffer(), 'apartment.dxf');
    } catch (err) {
      setStatus('error');
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [loadBuffer]);

  // ---- three.js 오브젝트 빌드 ----
  const buildOptions = useMemo<Partial<BuildOptions>>(
    () => ({
      style,
      monochrome,
      jitter,
      showText,
      showFills,
      showHatchPattern,
      showLineWeights,
      hiddenLayers,
    }),
    [style, monochrome, jitter, showText, showFills, showHatchPattern, showLineWeights, hiddenLayers],
  );

  const [object, setObject] = useState<THREE.Object3D | null>(null);
  const [buildStats, setBuildStats] = useState({ segments: 0, texts: 0 });

  useEffect(() => {
    if (!scene) {
      setObject(null);
      return;
    }
    const built = buildSketchScene(scene, buildOptions);
    setObject(built.group);
    setBuildStats({ segments: built.segmentCount, texts: built.textCount });
    return () => built.dispose();
  }, [scene, buildOptions]);

  // 새 도면이 올라오면 화면에 맞춘다.
  useEffect(() => {
    if (scene?.bounds) canvasRef.current?.fit(scene.bounds);
  }, [scene]);

  // ---- 레이어 목록 ----
  const layers = useMemo<LayerRow[]>(() => {
    if (!info) return [];
    const counts = scene?.layerCounts ?? {};
    return info.layers
      .map((l) => ({ ...l, count: counts[l.name] ?? 0 }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'ko'));
  }, [info, scene]);

  const toggleLayer = useCallback((name: string) => {
    setHiddenLayers((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }, []);

  const setAllLayers = useCallback(
    (visible: boolean) => {
      setHiddenLayers(visible ? new Set() : new Set(layers.map((l) => l.name)));
    },
    [layers],
  );

  // ---- 드래그 앤 드롭 ----
  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const file = e.dataTransfer.files?.[0];
      if (file) void loadFile(file);
    },
    [loadFile],
  );

  const onViewChange = useCallback((upp: number) => {
    setZoomLabel(upp > 0 ? `1 px ≈ ${upp.toPrecision(3)} 단위` : '');
  }, []);

  const onCursorMove = useCallback((x: number, y: number) => {
    setCursor({ x, y });
  }, []);

  const exportPng = useCallback(() => {
    const url = canvasRef.current?.toPNG();
    if (!url) return;
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(info?.fileName ?? 'drawing').replace(/\.[^.]+$/, '')}-sketch.png`;
    a.click();
  }, [info]);

  const tokens = STYLE_TOKENS[style];

  return (
    <div
      className="viewer"
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
    >
      <aside className="sidebar">
        <header className="brand">
          <h1>DWG / DXF 스케치 뷰어</h1>
          <p className="muted">three.js 로 그리는 2D CAD 도면 뷰어</p>
        </header>

        <section className="panel">
          <h2>파일</h2>
          <label className="file-button">
            <input
              type="file"
              accept=".dxf,.dwg,application/dxf,image/vnd.dwg"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void loadFile(file);
                e.target.value = '';
              }}
            />
            <span>파일 선택…</span>
          </label>
          <button type="button" className="ghost" onClick={() => void loadSample()}>
            예제 도면 열기
          </button>
          <p className="hint">창 아무 곳에나 파일을 끌어다 놓아도 됩니다.</p>

          {info && info.spaces.length > 1 && (
            <label className="field">
              <span>공간</span>
              <select
                value={space ?? ''}
                onChange={(e) => selectSpace(e.target.value === '' ? null : e.target.value)}
              >
                {info.spaces.map((sp) => (
                  <option key={sp.name} value={sp.isModelSpace ? '' : sp.name}>
                    {sp.isModelSpace ? `모형 (${sp.name})` : `배치 · ${sp.name}`}
                  </option>
                ))}
              </select>
            </label>
          )}

          {space !== null && (
            <label className="check">
              <input
                type="checkbox"
                checked={paperBorder}
                onChange={(e) => {
                  setPaperBorder(e.target.checked);
                  selectSpace(space, e.target.checked);
                }}
              />
              용지 테두리 표시
            </label>
          )}
        </section>

        <section className="panel">
          <h2>표현</h2>
          <label className="field">
            <span>스타일</span>
            <select value={style} onChange={(e) => setStyle(e.target.value as SketchStyle)}>
              {(Object.keys(STYLE_LABELS) as SketchStyle[]).map((s) => (
                <option key={s} value={s}>
                  {STYLE_LABELS[s]}
                </option>
              ))}
            </select>
          </label>

          {style === 'sketch' && (
            <label className="field">
              <span>떨림 {Math.round(jitter * 100)}%</span>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={jitter}
                onChange={(e) => setJitter(Number(e.target.value))}
              />
            </label>
          )}

          <label className="check">
            <input
              type="checkbox"
              checked={monochrome}
              onChange={(e) => setMonochrome(e.target.checked)}
            />
            단색 잉크로 그리기
          </label>
          <label className="check">
            <input type="checkbox" checked={showText} onChange={(e) => setShowText(e.target.checked)} />
            문자 표시
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={showHatchPattern}
              onChange={(e) => setShowHatchPattern(e.target.checked)}
            />
            해치 패턴 표시
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={showFills}
              onChange={(e) => setShowFills(e.target.checked)}
            />
            솔리드 채움 표시
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={showLineWeights}
              onChange={(e) => setShowLineWeights(e.target.checked)}
            />
            선굵기 표시
          </label>
        </section>

        <section className="panel grow">
          <h2>레이어</h2>
          <LayerPanel
            layers={layers}
            hidden={hiddenLayers}
            onToggle={toggleLayer}
            onAll={setAllLayers}
          />
        </section>

        {info && (
          <section className="panel">
            <h2>도면 정보</h2>
            <dl className="info">
              <dt>파일</dt>
              <dd title={info.fileName}>{info.fileName}</dd>
              <dt>형식</dt>
              <dd>
                {info.format.toUpperCase()}
                {info.version ? ` · ${info.version}` : ''}
              </dd>
              <dt>공간</dt>
              <dd>{space ?? '모형'}</dd>
              <dt>엔티티</dt>
              <dd>{formatNumber(info.entityCount)}</dd>
              <dt>블록</dt>
              <dd>{formatNumber(info.blockCount)}</dd>
              <dt>선분</dt>
              <dd>{formatNumber(buildStats.segments)}</dd>
              <dt>문자</dt>
              <dd>{formatNumber(buildStats.texts)}</dd>
              <dt>해석 시간</dt>
              <dd>{info.parseMs} ms</dd>
            </dl>
            {Object.keys(info.skipped).length > 0 && (
              <p className="hint">
                지원하지 않아 건너뛴 엔티티:{' '}
                {Object.entries(info.skipped)
                  .map(([k, v]) => `${k}(${v})`)
                  .join(', ')}
              </p>
            )}
            {scene?.stats.truncated && (
              <p className="warn">도면이 너무 커서 일부만 표시했습니다.</p>
            )}
          </section>
        )}
      </aside>

      <main className="stage">
        <div className="toolbar">
          <button type="button" onClick={() => canvasRef.current?.fit(scene?.bounds)}>
            전체 보기
          </button>
          <button type="button" onClick={() => canvasRef.current?.zoomBy(1.4)}>
            확대
          </button>
          <button type="button" onClick={() => canvasRef.current?.zoomBy(1 / 1.4)}>
            축소
          </button>
          <button type="button" onClick={exportPng} disabled={!scene}>
            PNG 저장
          </button>
          <span className="spacer" />
          <span className="readout">
            {cursor ? `X ${cursor.x.toFixed(2)}  Y ${cursor.y.toFixed(2)}` : ''}
          </span>
          <span className="readout">{zoomLabel}</span>
        </div>

        <div className="canvas-wrap">
          <DrawingCanvas
            ref={canvasRef}
            object={object}
            background={tokens.background}
            onCursor={onCursorMove}
            onViewChange={onViewChange}
          />

          {status === 'idle' && (
            <div className="overlay">
              <div className="overlay-card">
                <h2>DXF 또는 DWG 파일을 열어 보세요</h2>
                <p>파일을 끌어다 놓거나 왼쪽에서 선택하세요.</p>
                <button type="button" onClick={() => void loadSample()}>
                  예제 도면 열기
                </button>
              </div>
            </div>
          )}

          {status === 'loading' && (
            <div className="overlay">
              <div className="overlay-card">
                <div className="spinner" aria-hidden />
                <p>도면을 읽는 중…</p>
              </div>
            </div>
          )}

          {status === 'ready' && scene && !scene.bounds && (
            <div className="overlay">
              <div className="overlay-card">
                <h2>그릴 수 있는 2D 요소가 없습니다</h2>
                <p>
                  파일은 정상적으로 읽혔지만 {space === null ? '모형 공간' : `배치 "${space}"`}에
                  선·문자·면이 없습니다.
                  {Object.keys(info?.skipped ?? {}).length > 0 && (
                    <>
                      {' '}3D 전용 엔티티만 들어 있는 도면일 수 있습니다:{' '}
                      {Object.entries(info?.skipped ?? {})
                        .map(([k, v]) => `${k}(${v})`)
                        .join(', ')}
                    </>
                  )}
                </p>
              </div>
            </div>
          )}

          {status === 'error' && (
            <div className="overlay">
              <div className="overlay-card error">
                <h2>열지 못했습니다</h2>
                <p>{error}</p>
                <button type="button" onClick={() => setStatus('idle')}>
                  닫기
                </button>
              </div>
            </div>
          )}

          {dragOver && (
            <div className="overlay drop">
              <div className="overlay-card">여기에 놓으세요</div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
