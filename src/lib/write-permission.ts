import type { MediaAssessment } from '../../shared/types';

/**
 * 「开始备份」能不能点 —— 唯一的渲染层判断，且它不做任何安全推理。
 *
 * 这里只做三件事：确认这份判定是不是针对当前目标、把主进程的裁决翻译成界面状态、
 * 把「证据不足」降级成提示。**不重新推导阻断条件**：
 * 一旦渲染层自己拼条件，就会拼出第二个闸门，
 * 于是出现「界面可点、点下去被主进程拒绝」或「界面禁用、引擎其实会放行」的矛盾（Issue #9）。
 */
export interface WritePermissionView {
  /** 这份判定是否针对当前目标目录 */
  applies: boolean;
  /** 主进程明确阻断写入 */
  blocked: boolean;
  /** 判定没有经过主进程闸门（缺 blockers 字段）：按未判定处理，不得 fail-open */
  unknown: boolean;
  /** 给用户看的阻断原因（直接来自主进程） */
  reason: string | null;
  /** 证据不足但未被阻断：只提示，不禁用 */
  evidenceIncomplete: boolean;
}

export function resolveWritePermission(
  assessment: MediaAssessment | null | undefined,
  targetRoot: string,
): WritePermissionView {
  const applies = Boolean(assessment?.targetRoot && targetRoot && assessment.targetRoot === targetRoot);
  if (!applies) {
    // 目标换了，上一份判定不再适用：既不阻断，也不作为放行依据（放行由主进程在 start 时再判一次）。
    return { applies: false, blocked: false, unknown: false, reason: null, evidenceIncomplete: false };
  }
  const blockers = assessment?.blockers;
  if (blockers === undefined) {
    return {
      applies: true,
      blocked: true,
      unknown: true,
      reason: '未取得主进程写入许可，请重新检测介质后再开始备份',
      evidenceIncomplete: false,
    };
  }
  if (blockers.length > 0) {
    return {
      applies: true,
      blocked: true,
      unknown: false,
      reason: assessment?.blockReason ?? '写入闸门未放行',
      evidenceIncomplete: false,
    };
  }
  return {
    applies: true,
    blocked: false,
    unknown: false,
    reason: null,
    evidenceIncomplete: assessment?.writable === false,
  };
}
