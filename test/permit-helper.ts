import type { BackupService, StartOptions } from '../electron/engine/service';

/**
 * 按当前写入契约发起备份。
 *
 * 写入许可判定为「需人工确认」（卷级健康无法判定——没有卷级探测能力的平台上
 * 恒为此结论）时，真实用户必须先勾选确认；测试同样要模拟这一步：
 * 把回执（许可修订号）带上，主进程会强制校验它。
 *
 * 许可为放行时无需回执，行为与旧版一致。
 */
export function startWithPermit(
  service: BackupService,
  options: Omit<StartOptions, 'acknowledgeRisk'>,
): Promise<void> {
  const permit = service.getState().writePermits[options.targetRoot];
  return service.start({
    ...options,
    acknowledgeRisk: permit?.verdict === 'confirm' ? permit.revision : undefined,
  });
}
