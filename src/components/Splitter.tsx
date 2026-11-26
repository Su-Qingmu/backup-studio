import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { animateSpring, SNAP_SPRING } from '../lib/spring';
import {
  COLLAPSE_RATIO,
  ratioFromPointer,
  trackSizes,
} from '../lib/splitter-layout';
import { IconChevronRight } from './Icons';

interface Props {
  containerRef: RefObject<HTMLDivElement>;
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
  /** 当前分栏比例：由上层持有，工作区切换后重新挂载也能恢复 */
  ratio: number;
  /** 比例稳定下来后回报给上层（回报的是「展开后」的比例） */
  onRatioChange: (ratio: number) => void;
}

/**
 * 可拖拽分栏。
 *
 * 交互契约：
 *  - 拖拽中：右侧预览盖透明遮罩，1:1 跟手，零延迟
 *  - 松手越过 82%：右栏自动收起，弹簧零回弹咬死
 *  - 拖拽中按 Esc：恢复拖拽前的比例
 *  - 双击手柄：回到 50/50
 *  - 收起后右缘常驻展开入口：右栏宽度为 0 时必须还有办法把它拉回来
 *
 * 轨道一律以 fr 表达（见 lib/splitter-layout）：固定像素的轨道会把工作区的
 * 最小内容宽度钉死在最大化时的旧像素总和上，窗口还原后网格无法收缩，
 * 右栏与分隔条被顶到窗口之外（#4）。fr 轨道不依赖任何尺寸重算，
 * 容器怎么变都不会溢出。
 */
export function Splitter({ containerRef, collapsed, onCollapsedChange, ratio, onRatioChange }: Props) {
  const [dragging, setDragging] = useState(false);
  const ratioRef = useRef(ratio);
  // 收起前的比例：展开时恢复，用户不必每次重新拖。
  const expandedRatioRef = useRef(ratio);
  const dragRef = useRef({ active: false, startX: 0, startRatio: ratio, prevRatio: ratio });
  const animRef = useRef<(() => void) | null>(null);
  const collapsedRef = useRef(collapsed);

  useEffect(() => {
    collapsedRef.current = collapsed;
  }, [collapsed]);

  /**
   * 把比例写成两条 fr 轨道。
   *
   * 轨道份额之和恒为 1，因此无论容器多宽，网格都不会溢出容器，
   * 窗口还原后右栏必定回到可视区内。
   */
  const applyRatio = useCallback(
    (value: number) => {
      const container = containerRef.current;
      if (!container) return;
      // 拖拽与弹簧过程中按**实时比例**投影，右栏才跟手；
      // 只有「已收起且静止」时才投影成 1fr / 0fr。
      const live = dragRef.current.active || animRef.current !== null;
      const { left, right } = trackSizes(value, collapsedRef.current && !live);
      container.style.setProperty('--left-w', left);
      container.style.setProperty('--right-w', right);
    },
    [containerRef],
  );

  /** 弹簧吸附：零回弹，瞬间咬死 */
  const springTo = useCallback(
    (targetRatio: number) => {
      animRef.current?.();
      const from = ratioRef.current;
      animRef.current = animateSpring(
        0,
        1,
        SNAP_SPRING,
        (t) => {
          const value = from + (targetRatio - from) * t;
          ratioRef.current = value;
          applyRatio(value);
        },
        () => {
          animRef.current = null;
          ratioRef.current = targetRatio;
          applyRatio(targetRatio);
          onRatioChange(expandedRatioRef.current);
        },
      );
    },
    [applyRatio, onRatioChange],
  );

  /**
   * 收起/展开状态变化时重写轨道。
   *
   * 比例是唯一事实，轨道只是它的投影：状态一变就重新投影一次，
   * 不需要监听窗口尺寸——fr 轨道本身就随容器自动伸缩。
   */
  useEffect(() => {
    applyRatio(collapsed ? 1 : ratioRef.current);
  }, [collapsed, applyRatio]);

  // 上层保存的比例与本地不一致时以它为准：
  // 工作区切换会重新挂载本组件，收起前的比例必须跨挂载保留下来。
  useEffect(() => {
    if (ratio !== ratioRef.current) {
      ratioRef.current = ratio;
      expandedRatioRef.current = ratio;
      applyRatio(collapsed ? 1 : ratio);
    }
  }, [ratio, collapsed, applyRatio]);

  // 拖拽过程中的 Esc 复位
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !dragRef.current.active) return;
      event.preventDefault();
      const prev = dragRef.current.prevRatio;
      dragRef.current.active = false;
      containerRef.current?.classList.remove('is-resizing');
      document.body.style.cursor = '';
      setDragging(false);
      expandedRatioRef.current = prev;
      springTo(prev);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [containerRef, springTo]);

  // 指针抬起兜底：指针被移出窗口或捕获失效时，仍要正确结束拖拽态，
  // 否则分栏会永远停在「正在拖拽」状态，右侧遮罩撤不掉。
  useEffect(() => {
    const endDrag = () => {
      if (!dragRef.current.active) return;
      dragRef.current.active = false;
      containerRef.current?.classList.remove('is-resizing');
      document.body.style.cursor = '';
      setDragging(false);
    };
    window.addEventListener('pointerup', endDrag);
    window.addEventListener('pointercancel', endDrag);
    window.addEventListener('blur', endDrag);
    return () => {
      window.removeEventListener('pointerup', endDrag);
      window.removeEventListener('pointercancel', endDrag);
      window.removeEventListener('blur', endDrag);
    };
  }, [containerRef]);

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    const container = containerRef.current;
    if (!container) return;
    event.preventDefault();
    animRef.current?.();
    animRef.current = null;

    const startRatio = collapsedRef.current ? 1 : ratioRef.current;

    dragRef.current = {
      active: true,
      startX: event.clientX,
      startRatio,
      prevRatio: startRatio,
    };

    // 指针捕获在部分环境下会抛 InvalidPointerId，不能让它中断后续状态设置
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // 捕获失败时退化为常规事件流，功能不受影响
    }
    container.classList.add('is-resizing');
    document.body.style.cursor = 'col-resize';
    setDragging(true);
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    const container = containerRef.current;
    if (!drag.active || !container) return;

    const value = ratioFromPointer(drag.startRatio, event.clientX - drag.startX, container.clientWidth, collapsedRef.current);
    ratioRef.current = value;
    applyRatio(value);
  };

  const handlePointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    const container = containerRef.current;
    if (!drag.active) return;

    drag.active = false;
    container?.classList.remove('is-resizing');
    document.body.style.cursor = '';
    setDragging(false);
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // 指针捕获可能已失效
    }

    const value = ratioRef.current;

    if (value >= COLLAPSE_RATIO) {
      // 收起前记住当前比例，展开时恢复。
      if (!collapsedRef.current) expandedRatioRef.current = drag.startRatio;
      springTo(1);
      if (!collapsedRef.current) onCollapsedChange(true);
      onRatioChange(expandedRatioRef.current);
      return;
    }
    if (collapsedRef.current) {
      onCollapsedChange(false);
      // 收起态拖出来的位置就是用户想要的比例；没拖动（仍是 1）才回到收起前的比例。
      const target = value < 0.999 ? value : expandedRatioRef.current;
      expandedRatioRef.current = target;
      springTo(target);
      onRatioChange(target);
      return;
    }
    // 常规松手：零延迟咬死在当前位置
    expandedRatioRef.current = value;
    ratioRef.current = value;
    applyRatio(value);
    onRatioChange(value);
  };

  const handleDoubleClick = () => {
    expandedRatioRef.current = 0.5;
    onCollapsedChange(false);
    springTo(0.5);
  };

  return (
    <>
      <div
        className="splitter"
        role="separator"
        aria-orientation="vertical"
        aria-label="调整分栏比例"
        data-dragging={dragging}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onDoubleClick={handleDoubleClick}
      >
        <span className="splitter-grip" />
      </div>

      {/*
        收起后的展开入口：右栏宽度为 0 时它是唯一的出路，
        必须常驻在窗口右缘，不能随右栏一起消失。
        绝对定位让它脱离网格流，不会挤占分栏轨道；
        靠上摆放，避开分隔条中部的抓手与命中区。
      */}
      {collapsed ? (
        <button
          type="button"
          className="splitter-expand"
          aria-label="展开右侧栏"
          title="展开右侧栏"
          onClick={() => {
            onCollapsedChange(false);
            springTo(expandedRatioRef.current);
          }}
        >
          <IconChevronRight size={14} />
        </button>
      ) : null}
    </>
  );
}
