/**
 * 分栏布局的纯逻辑（无 DOM 依赖，可直接单测）。
 *
 * 契约：JS 只写无量纲的比例（--split-ratio），列宽由 CSS 按容器宽度现算。
 *
 * 一旦把比例换算成绝对像素写进轨道，网格的最小内容宽度就被钉死在
 * 「最大化那一刻」的像素总和上：窗口还原后工作区无法收缩，右栏与分隔条
 * 被顶到窗口之外，而且没有任何入口能把它拉回来（#4）。
 * 比例与像素之间的换算只在这里发生，便于用单测钉住这条契约。
 */

/** 分隔条宽度（px），与样式表中的固定轨道一致 */
export const HANDLE = 10;
export const MIN_RATIO = 0.24;
/**
 * 拖拽上限必须高于 COLLAPSE_RATIO，否则用户永远拖不到 82%，
 * 「左栏超过 82% 自动收起右栏」就成了不可达分支。
 */
export const MAX_RATIO = 0.94;
/** 左栏超过 82% 自动收起右栏 */
export const COLLAPSE_RATIO = 0.82;
export const DEFAULT_RATIO = 0.56;

/** 比例必须落在 [MIN_RATIO, upper] 内；收起态的上限是 1。 */
export function clampRatio(ratio: number, collapsed = false): number {
  const upper = collapsed ? 1 : MAX_RATIO;
  if (!Number.isFinite(ratio)) return collapsed ? 1 : DEFAULT_RATIO;
  return Math.min(upper, Math.max(MIN_RATIO, ratio));
}

/**
 * 拖拽位移换算成比例：位移量按可用宽度（容器宽度减去分隔条）折算，
 * 结果始终夹紧在合法区间内。窗口在拖拽途中缩放也不会漂。
 */
export function ratioFromPointer(
  startRatio: number,
  deltaX: number,
  containerWidth: number,
  collapsed = false,
): number {
  const total = Math.max(1, containerWidth - HANDLE);
  return clampRatio(startRatio + deltaX / total, collapsed);
}

export interface SplitWidths {
  /** 左栏宽度（px）：(容器宽度 - 分隔条) × 比例 */
  left: number;
  /** 右栏宽度（px）：剩余空间 */
  right: number;
}

/**
 * 按容器宽度换算两栏宽度：与样式表里的
 * `minmax(0, calc((100% - 10px) * var(--split-ratio))) 10px minmax(0, 1fr)`
 * 同口径。两栏之和恒等于「容器宽度 - 分隔条」，
 * 永远不会把工作区撑得比视口更宽。
 */
export function splitWidths(containerWidth: number, ratio: number): SplitWidths {
  const usable = Math.max(0, containerWidth - HANDLE);
  const clamped = Math.min(1, Math.max(0, ratio));
  const left = usable * clamped;
  return { left, right: usable - left };
}
