'use client';

import { Canvas, useThree } from '@react-three/fiber';
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from 'react';
import * as THREE from 'three';

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface DrawingCanvasHandle {
  /** 도면 전체가 보이도록 맞춘다. */
  fit: (bounds?: Bounds | null) => void;
  /** 화면 중심 기준 배율 조정 (1보다 크면 확대). */
  zoomBy: (factor: number) => void;
  /** 현재 1픽셀이 몇 도면 단위인지 */
  unitsPerPixel: () => number;
  /** 화면을 PNG 로 내보낸다. */
  toPNG: () => string | null;
}

interface Props {
  /** 그릴 오브젝트. 바뀌면 이전 것을 떼고 새로 붙인다. */
  object: THREE.Object3D | null;
  background: number;
  /** 도면 좌표를 마우스로 훑을 때 */
  onCursor?: (x: number, y: number) => void;
  /** 뷰가 바뀔 때마다 (줌 배율 표시용) */
  onViewChange?: (unitsPerPixel: number) => void;
}

const MIN_UPP = 1e-7;
const MAX_UPP = 1e9;

/**
 * 굵은 선은 LineMaterial 이 셰이더에서 두께를 주는데, 그 계산에 캔버스의
 * 픽셀 크기가 필요하다. 내용이 바뀌거나 창 크기가 바뀔 때마다 넣어 준다.
 */
function syncLineResolution(root: THREE.Object3D | null, w: number, h: number) {
  if (!root) return;
  root.traverse((obj) => {
    const mat = (obj as THREE.Mesh).material;
    for (const m of Array.isArray(mat) ? mat : [mat]) {
      const lm = m as unknown as { isLineMaterial?: boolean; resolution?: THREE.Vector2 };
      if (lm?.isLineMaterial && lm.resolution) lm.resolution.set(w, h);
    }
  });
}

/**
 * 카메라와 마우스 조작을 맡는다.
 *
 * `<Canvas>` 안에서만 쓸 수 있다 — 카메라·렌더러·캔버스 크기를 `useThree` 로
 * 받아 쓴다. 2D 도면이라 직교 카메라의 프러스텀을 직접 계산하므로, R3F 가
 * 창 크기에 맞춰 프러스텀을 덮어쓰지 않도록 카메라에 `manual` 을 세워 둔다.
 */
interface ViewControllerProps {
  object: THREE.Object3D | null;
  onCursor?: (x: number, y: number) => void;
  onViewChange?: (unitsPerPixel: number) => void;
  /** 바깥(<Canvas> 밖)에서 쓸 조작을 넘겨준다. 떼어낼 때는 null 로 부른다. */
  onReady: (api: DrawingCanvasHandle | null) => void;
}

function ViewController({ object, onCursor, onViewChange, onReady }: ViewControllerProps) {
  const camera = useThree((s) => s.camera) as THREE.OrthographicCamera;
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const invalidate = useThree((s) => s.invalidate);
  const width = useThree((s) => s.size.width);
  const height = useThree((s) => s.size.height);

  /** 화면 중심의 도면 좌표와 픽셀당 도면 단위 — 뷰 상태 전부. */
  const view = useRef({ cx: 0, cy: 0, upp: 1 });
  /** 캔버스 크기. 핸들러 안에서 최신 값이 필요해 ref 로도 들고 있는다. */
  const size = useRef({ w: 1, h: 1 });
  /** 마지막으로 맞춘 도면 범위. 사용자가 뷰를 건드리기 전까지 리사이즈 때 다시 맞춘다. */
  const fitBounds = useRef<Bounds | null>(null);
  const userMoved = useRef(false);
  /**
   * 드래그 상태. 핸들러 바깥(ref)에 둔다 — 안에 두면 입력 핸들러를 다시 붙일 때
   * 드래그 중이라는 사실이 통째로 날아가 화면 이동이 중간에 끊긴다.
   */
  const drag = useRef({ active: false, pointerId: -1, lastX: 0, lastY: 0 });

  /**
   * 콜백은 ref 로 들고 있는다. 부모가 다시 렌더될 때마다 새 함수가 내려와도
   * 입력 핸들러를 떼었다 붙이지 않기 위해서다. onCursor 는 포인터가 움직일
   * 때마다 부모 상태를 바꾸므로, 이걸 의존성에 두면 드래그 도중에 핸들러가
   * 갈아끼워져 이동량이 뚝뚝 끊긴다.
   */
  const onCursorRef = useRef(onCursor);
  const onViewChangeRef = useRef(onViewChange);
  useEffect(() => {
    onCursorRef.current = onCursor;
    onViewChangeRef.current = onViewChange;
  });

  const applyCamera = useCallback(() => {
    const { cx, cy, upp } = view.current;
    const halfW = (size.current.w * upp) / 2;
    const halfH = (size.current.h * upp) / 2;
    camera.left = cx - halfW;
    camera.right = cx + halfW;
    camera.top = cy + halfH;
    camera.bottom = cy - halfH;
    camera.updateProjectionMatrix();
    invalidate();
  }, [camera, invalidate]);

  const fit = useCallback(
    (bounds?: Bounds | null) => {
      if (!bounds || !Number.isFinite(bounds.minX)) return;
      fitBounds.current = bounds;
      userMoved.current = false;
      const w = Math.max(bounds.maxX - bounds.minX, 1e-9);
      const h = Math.max(bounds.maxY - bounds.minY, 1e-9);
      const pad = 1.08;
      view.current.cx = (bounds.minX + bounds.maxX) / 2;
      view.current.cy = (bounds.minY + bounds.maxY) / 2;
      view.current.upp = Math.max(
        MIN_UPP,
        Math.max(w / Math.max(size.current.w, 1), h / Math.max(size.current.h, 1)) * pad,
      );
      applyCamera();
      onViewChangeRef.current?.(view.current.upp);
    },
    [applyCamera],
  );

  // ---- 캔버스 크기 ----
  useEffect(() => {
    // R3F 가 창 크기에 맞춰 프러스텀을 덮어쓰지 않게 한다.
    (camera as THREE.OrthographicCamera & { manual?: boolean }).manual = true;
    size.current = { w: Math.max(1, width), h: Math.max(1, height) };
    syncLineResolution(object, size.current.w, size.current.h);
    // 사용자가 아직 뷰를 움직이지 않았다면 새 크기에 맞춰 다시 맞춘다.
    // (로드 직후 창 크기가 바뀌는 경합을 막는다.)
    if (!userMoved.current && fitBounds.current) fit(fitBounds.current);
    else applyCamera();
  }, [camera, width, height, object, fit, applyCamera]);

  // ---- 바깥에서 쓸 수 있는 조작들 ----
  useEffect(() => {
    const api: DrawingCanvasHandle = {
      fit,
      zoomBy: (factor) => {
        userMoved.current = true;
        view.current.upp = Math.min(MAX_UPP, Math.max(MIN_UPP, view.current.upp / factor));
        applyCamera();
        onViewChangeRef.current?.(view.current.upp);
      },
      unitsPerPixel: () => view.current.upp,
      toPNG: () => {
        // 요청이 있을 때만 그리는(frameloop="demand") 설정이라 직전에 한 번 더 그린다.
        gl.render(scene, camera);
        return gl.domElement.toDataURL('image/png');
      },
    };
    onReady(api);
    return () => onReady(null);
  }, [fit, applyCamera, gl, scene, camera, onReady]);

  // ---- 입력 ----
  useEffect(() => {
    const host = gl.domElement;

    const toWorld = (clientX: number, clientY: number) => {
      const rect = host.getBoundingClientRect();
      const px = clientX - rect.left;
      const py = clientY - rect.top;
      const { cx, cy, upp } = view.current;
      return {
        x: cx + (px - rect.width / 2) * upp,
        y: cy - (py - rect.height / 2) * upp,
      };
    };

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      userMoved.current = true;
      const before = toWorld(e.clientX, e.clientY);
      // 트랙패드와 휠의 delta 크기 차이를 흡수한다.
      const step = Math.sign(e.deltaY) * Math.min(Math.abs(e.deltaY) / 100, 1);
      const factor = Math.exp(step * 0.22);
      view.current.upp = Math.min(MAX_UPP, Math.max(MIN_UPP, view.current.upp * factor));
      const after = toWorld(e.clientX, e.clientY);
      // 커서 아래 좌표가 그대로 머물도록 중심을 보정.
      view.current.cx += before.x - after.x;
      view.current.cy += before.y - after.y;
      applyCamera();
      onViewChangeRef.current?.(view.current.upp);
    };

    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 0 && e.button !== 1) return;
      const d = drag.current;
      d.active = true;
      d.pointerId = e.pointerId;
      d.lastX = e.clientX;
      d.lastY = e.clientY;
      userMoved.current = true;
      try {
        host.setPointerCapture(e.pointerId);
      } catch {
        // 이미 놓인 포인터면 캡처가 거부된다 — 이동 자체에는 지장이 없다.
      }
      host.style.cursor = 'grabbing';
    };

    const onPointerMove = (e: PointerEvent) => {
      const d = drag.current;
      if (d.active && e.pointerId === d.pointerId) {
        const dx = e.clientX - d.lastX;
        const dy = e.clientY - d.lastY;
        d.lastX = e.clientX;
        d.lastY = e.clientY;
        view.current.cx -= dx * view.current.upp;
        view.current.cy += dy * view.current.upp;
        applyCamera();
      }
      const report = onCursorRef.current;
      if (report) {
        const p = toWorld(e.clientX, e.clientY);
        report(p.x, p.y);
      }
    };

    const endDrag = (e: PointerEvent) => {
      const d = drag.current;
      if (e.pointerId !== d.pointerId) return;
      d.active = false;
      d.pointerId = -1;
      if (host.hasPointerCapture(e.pointerId)) host.releasePointerCapture(e.pointerId);
      host.style.cursor = 'grab';
    };

    const onContextMenu = (e: Event) => e.preventDefault();

    host.addEventListener('wheel', onWheel, { passive: false });
    host.addEventListener('pointerdown', onPointerDown);
    host.addEventListener('pointermove', onPointerMove);
    host.addEventListener('pointerup', endDrag);
    host.addEventListener('pointercancel', endDrag);
    host.addEventListener('contextmenu', onContextMenu);
    host.style.cursor = 'grab';

    return () => {
      host.removeEventListener('wheel', onWheel);
      host.removeEventListener('pointerdown', onPointerDown);
      host.removeEventListener('pointermove', onPointerMove);
      host.removeEventListener('pointerup', endDrag);
      host.removeEventListener('pointercancel', endDrag);
      host.removeEventListener('contextmenu', onContextMenu);
    };
    // applyCamera 는 고정이라 이 효과는 한 번만 돈다 — 콜백은 위의 ref 로 받는다.
  }, [applyCamera, gl]);

  return null;
}

const DrawingCanvas = forwardRef<DrawingCanvasHandle, Props>(function DrawingCanvas(
  { object, background, onCursor, onViewChange },
  ref,
) {
  /** <Canvas> 안쪽에서 등록해 주는 실제 조작들. */
  const inner = useRef<DrawingCanvasHandle | null>(null);
  /**
   * R3F 는 캔버스 크기를 잡은 뒤에야 자식을 붙이므로, 그 전에 들어온 fit 요청을
   * 받아 두었다가 준비되면 흘려보낸다. (도면을 열자마자 fit 이 날아온다.)
   */
  const pendingFit = useRef<Bounds | null | undefined>(undefined);

  const onReady = useCallback((api: DrawingCanvasHandle | null) => {
    inner.current = api;
    if (api && pendingFit.current !== undefined) {
      api.fit(pendingFit.current);
      pendingFit.current = undefined;
    }
  }, []);

  useImperativeHandle(
    ref,
    (): DrawingCanvasHandle => ({
      fit: (bounds) => {
        if (inner.current) inner.current.fit(bounds);
        else pendingFit.current = bounds ?? null;
      },
      zoomBy: (factor) => inner.current?.zoomBy(factor),
      unitsPerPixel: () => inner.current?.unitsPerPixel() ?? 1,
      toPNG: () => inner.current?.toPNG() ?? null,
    }),
    [],
  );

  return (
    <div className="canvas-host">
      <Canvas
        orthographic
        // 바뀔 때만 그린다 — 가만히 있는 도면에 GPU 를 쓰지 않는다.
        frameloop="demand"
        dpr={[1, 2]}
        gl={{ antialias: true, alpha: false, preserveDrawingBuffer: true }}
        camera={{ manual: true, position: [0, 0, 100], near: -10000, far: 10000 }}
        onCreated={({ gl }) => {
          // 뷰포트 안 문자를 창 모양으로 자르려면 머티리얼별 클리핑이 필요하다.
          gl.localClippingEnabled = true;
        }}
      >
        <color attach="background" args={[background]} />
        <ViewController
          object={object}
          onCursor={onCursor}
          onViewChange={onViewChange}
          onReady={onReady}
        />
        {/* 선·면·문자는 평탄화 결과로 한 번에 만들어 둔 그룹이라 통째로 붙인다.
            수십만 선분을 JSX 로 쪼개면 재조정 비용만 늘고 얻는 게 없다.
            수명은 만든 쪽(CadViewer)이 쥐고 있으므로 R3F 가 버리지 않게 한다. */}
        {object && <primitive object={object} dispose={null} />}
      </Canvas>
    </div>
  );
});

export default DrawingCanvas;
