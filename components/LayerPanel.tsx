'use client';

import { aciToRgb } from '@/lib/dxf/colors';

export interface LayerRow {
  name: string;
  colorIndex: number;
  off: boolean;
  frozen: boolean;
  /** 화면에 그려진 엔티티 수 */
  count: number;
}

interface Props {
  layers: LayerRow[];
  hidden: ReadonlySet<string>;
  onToggle: (name: string) => void;
  onAll: (visible: boolean) => void;
}

export default function LayerPanel({ layers, hidden, onToggle, onAll }: Props) {
  if (layers.length === 0) {
    return <p className="muted">도면을 열면 레이어가 표시됩니다.</p>;
  }

  return (
    <div className="layer-panel">
      <div className="layer-actions">
        <button type="button" onClick={() => onAll(true)}>
          모두 켜기
        </button>
        <button type="button" onClick={() => onAll(false)}>
          모두 끄기
        </button>
      </div>
      <ul className="layer-list">
        {layers.map((layer) => {
          const [r, g, b] = aciToRgb(layer.colorIndex);
          const isHidden = hidden.has(layer.name);
          return (
            <li key={layer.name}>
              <label className={isHidden ? 'layer-row off' : 'layer-row'}>
                <input
                  type="checkbox"
                  checked={!isHidden}
                  onChange={() => onToggle(layer.name)}
                />
                <span
                  className="swatch"
                  style={{ background: `rgb(${r}, ${g}, ${b})` }}
                  aria-hidden
                />
                <span className="layer-name" title={layer.name}>
                  {layer.name}
                </span>
                <span className="layer-count">{layer.count || ''}</span>
              </label>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
