import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { animateSpring, SNAP_SPRING } from '../lib/spring';

const HANDLE = 10;
const MIN_RATIO = 0.24;
/**
 * 拖拽上限必须高于 COLLAPSE_RATIO，否则用户永远拖不到 82%，
 * 「左栏超过 82% 自动收起右栏」就成了不可达分支。
 */
const MAX_RATIO = 0.94;
/** 左栏超过 82% 自动收起右栏 */
const COLLAPSE_RATIO = 0.82;
const DEFAULT_RATIO = 0.56;

interface Props {
  containerRef: RefObject<HTMLDivElement>;
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
}

/**
 * 可拖拽分栏。
 *
 * 交互契约：
 *  - 拖拽中：右侧预览盖透明遮罩，1:1 跟手，零延迟
 *  - 松手越过 82%：右栏自动收起，弹簧零回弹咬死
 *  - 拖拽中按 Esc：恢复拖拽前的比例
 *  - 双击手柄：回到 50/50
 *  - 收起后：手柄本身常驻一个可见的展开把柄，点一下即恢复
 */
export function Splitter({ containerRef, collapsed, onCollapsedChange }: Props) {
  const [dragging, setDragging] = useState(false);
  const ratioRef = useRef(DEFAULT_RATIO);
  const dragRef = useRef({ active: false, startX: 0, startRatio: DEFAULT_RATIO, prevRatio: DEFAULT_RATIO });
  const animRef = useRef<(() => void) | null>(null);
  const collapsedRef = useRef(collapsed);

  /** 收起前的比例：展开把柄要用它把右栏放回原来的宽度，而不是 1（=全收起） */
  const restoreRatioRef = useRef(DEFAULT_RATIO);

  useEffect(() => {
    // 收起态下 ratioRef 保持 1 是刻意约定：拖拽起点、展开恢复都依赖
    // 「收起 == ratio 1」这个不变量，否则展开会把右栏又推回视口外。
    if (collapsed) restoreRatioRef.current = ratioRef.current;
    collapsedRef.current = collapsed;
  }, [collapsed]);

  /**
   * 只写「比例」这一个无量纲变量，宽度交给 CSS 按当前容器宽度现算。
   *
   * 旧实现把比例换算成绝对 px 写进 --left-w / --right-w：
   * 两列 px 之和是「最后拖动那一刻」的快照；窗口最大化后再还原时，
   * 右侧 1fr 已被绝对列宽吃掉，grid 内容就把 .workspace 撑得比视口宽，
   * 右栏连同分隔条被推到窗口外；同时容器自身被撑宽，container.clientWidth
   * 量到的是被撑大后的值而不是真实视口 —— 绝对像素既是症状也是自反馈循环的
   * 一环，所以这里彻底不再落像素。
   */
  const applyRatio = useCallback(
    (ratio: number) => {
      const container = containerRef.current;
      if (!container) return;
      const clamped = Math.min(1, Math.max(0, ratio));
      container.style.setProperty('--split-ratio', String(clamped));
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
          const ratio = from + (targetRatio - from) * t;
          ratioRef.current = ratio;
          applyRatio(ratio);
        },
        () => {
          animRef.current = null;
          ratioRef.current = targetRatio;
          applyRatio(targetRatio);
        },
      );
    },
    [applyRatio],
  );

  // 挂载时落地一次初始比例即可：列宽完全由 CSS 跟随容器宽度推导，
  // 窗口最大化/还原不再需要 JS 重算像素，也就没有「过期宽度」可留。
  useEffect(() => {
    applyRatio(ratioRef.current);
    return () => {
      animRef.current?.();
      animRef.current = null;
    };
  }, [applyRatio]);

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

    // 每次移动都读「此刻」的容器宽度，位移换算成比例，窗口中途缩放也不会漂
    const total = Math.max(1, container.clientWidth - HANDLE);
    const ratio = drag.startRatio + (event.clientX - drag.startX) / total;
    // 收起态的起点是 1，上限必须保持 1，否则第一帧就被夹回 0.94 而跳变
    const upper = collapsedRef.current ? 1 : MAX_RATIO;
    const clamped = Math.max(MIN_RATIO, Math.min(upper, ratio));
    ratioRef.current = clamped;
    applyRatio(clamped);
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

    const ratio = ratioRef.current;

    if (ratio >= COLLAPSE_RATIO) {
      springTo(1);
      if (!collapsedRef.current) onCollapsedChange(true);
      return;
    }
    if (collapsedRef.current) {
      onCollapsedChange(false);
      springTo(ratio);
      return;
    }
    // 常规松手：零延迟咬死在当前位置
    ratioRef.current = ratio;
    applyRatio(ratio);
  };

  const handleDoubleClick = () => {
    onCollapsedChange(false);
    springTo(0.5);
  };

  /** 收起态常驻展开入口：不依赖拖拽手势也能把右栏放回来 */
  const handleExpand = (event: React.SyntheticEvent) => {
    // 按钮上的按压不能再冒泡成「开始拖拽」，否则一点就被拖拽态吃掉
    event.stopPropagation();
    animRef.current?.();
    animRef.current = null;
    onCollapsedChange(false);
    // 恢复到收起前的比例；若那时正好在 1（拖满收起），退到 MAX_RATIO 保证右栏可见
    const target = restoreRatioRef.current >= MAX_RATIO ? 0.5 : restoreRatioRef.current;
    springTo(target);
  };

  return (
    <div
      className="splitter"
      role="separator"
      aria-orientation="vertical"
      aria-label="调整分栏比例"
      aria-expanded={!collapsed}
      data-dragging={dragging}
      data-collapsed={collapsed}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onDoubleClick={handleDoubleClick}
    >
      {/* 收起态才出现的常驻展开入口：状态驱动，避免用户找不到恢复方式 */}
      {collapsed ? (
        <button
          type="button"
          className="splitter-expand"
          aria-label="展开右侧栏"
          title="展开右侧栏"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={handleExpand}
        >
          ‹
        </button>
      ) : null}
      <span className="splitter-grip" />
    </div>
  );
}
