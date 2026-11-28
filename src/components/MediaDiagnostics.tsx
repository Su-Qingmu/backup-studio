import { useState } from 'react';
import '../styles/media-diagnostics.css';
import type { CapabilityRow, EvidenceItem, EvidenceScope, EvidenceStatus, HealthReport, TargetKind, WritePermit } from '../../shared/types';
import type { BackupAPI } from '../lib/api';

const labels: Record<HealthReport['condition'], string> = { unreachable: '目标目录不可达', 'filesystem-repair': '文件系统需人工检查', 'media-unavailable': '介质层不可用或已隔离', verified: '分层校验通过', uncertain: '证据不足' };

/**
 * 证据状态的人话说明。
 *
 * 「查过没有」「发现了没有」「查不了」「压根不适用」必须分开说：
 * 一律显示成「能力缺失」时，用户会把「应用无法检测」误读成「目标介质异常」。
 */
const statusLabels: Record<EvidenceStatus, string> = {
  ok: '已检查，正常',
  warning: '已检查，有发现',
  error: '已检查，发现异常',
  unavailable: '本应适用，但当前不可用（权限或系统接口缺失）',
  'not-applicable': '当前平台 / 文件系统 / 挂载类型不适用',
};

/** 证据按作用域分组渲染：平台无关的证据始终显示，卷级证据只在适用时显示 */
const scopeTitles: { scope: EvidenceScope; title: string }[] = [
  { scope: 'target', title: '目标目录' },
  { scope: 'index', title: '备份集与索引' },
  { scope: 'io', title: 'I/O 与校验' },
  { scope: 'volume', title: '卷级健康' },
  { scope: 'filesystem', title: '文件系统' },
  { scope: 'device', title: '介质与设备' },
];

const kindLabels: Record<TargetKind, string> = {
  'local-disk': '本机磁盘',
  network: '网络挂载',
  fuse: '用户态挂载（FUSE）',
  memory: '内存文件系统',
  virtual: '虚拟 / 容器文件系统',
  unknown: '未知',
};

function groupEvidence(evidence: EvidenceItem[]): { groups: { title: string; items: EvidenceItem[] }[]; notApplicable: EvidenceItem[] } {
  const applicable: EvidenceItem[] = [];
  const notApplicable: EvidenceItem[] = [];
  for (const item of evidence) {
    if (item.status === 'not-applicable') notApplicable.push(item);
    else applicable.push(item);
  }
  const groups = scopeTitles
    .map(({ scope, title }) => ({ title, items: applicable.filter((item) => item.scope === scope) }))
    .filter((group) => group.items.length > 0);
  return { groups, notApplicable };
}

export function MediaDiagnostics({ api, root, disabled, permit }: { api: BackupAPI; root: string; disabled: boolean; permit?: WritePermit | null }) {
  const [report, setReport] = useState<HealthReport>();
  const [matrix, setMatrix] = useState<CapabilityRow[]>();
  const [platform, setPlatform] = useState('Windows');
  const [selected, setSelected] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  async function perform(action: () => Promise<void>) {
    setBusy(true);
    setStatus('');
    try { await action(); } catch (error) { setStatus(error instanceof Error ? error.message : '操作未完成'); } finally { setBusy(false); }
  }
  const inspect = (recheck: boolean) => perform(async () => {
    setConfirm(false); setAccepted(false); setSelected(''); setReport(undefined);
    setReport(await (recheck ? api.reenumerate(root) : api.health(root)));
  });
  const locked = busy || disabled || !root;
  const grouped = report ? groupEvidence(report.assessment.evidence) : { groups: [], notApplicable: [] };
  return <section className="media-diagnostics" aria-label="介质诊断">
    <h3 className="section-title">介质诊断</h3>
    <div className="media-diagnostics-actions">
      <button className="btn btn-sm" disabled={locked} onClick={() => void inspect(false)}>只读检查（不写入目标介质）</button>
      <button className="btn btn-sm" disabled={locked} onClick={() => void inspect(true)}>重新检测（刷新检测结果，不重置控制器）</button>
      <button className="btn btn-sm" disabled={locked} onClick={() => void perform(async () => {
        const result = await api.exportPartitionEvidence(root); setStatus(`证据编号 ${result.auditId}。${result.guidance}`);
      })}>导出分区证据（保存到本机诊断目录）</button>
    </div>
    {!root ? <p className="media-diagnostics-hint">未选择备份目标目录，诊断不可用。</p> : null}
    {report && <>
      {report.summary ? <p className="media-diagnostics-summary" role="status">{report.summary}</p> : null}
      {report.target ? <p className="media-diagnostics-target">目标类型：{kindLabels[report.target.kind]}；文件系统：{report.target.fileSystem ?? '未知'}{report.target.mountPoint ? `；挂载点：${report.target.mountPoint}` : ''}{report.target.readOnly === true ? '；挂载为只读' : ''}</p> : null}
      <p><strong>{report.assessment.level} / {labels[report.condition]}</strong>（置信度 {Math.round(report.assessment.confidence * 100)}%）</p>
      <p>{report.assessment.suggestion}</p>
      {permit && permit.targetRoot === root && permit.at >= report.assessment.at
        && permit.level === report.assessment.level && permit.condition === report.condition ? (
        <p role="status">
          <strong>写入许可：{permit.verdict === 'blocked' ? '已阻断' : permit.verdict === 'confirm' ? '需人工确认' : '允许写入'}</strong>
          {permit.reason ? `（${permit.reason}）` : ''}
        </p>
      ) : null}
      <details open><summary>分层证据</summary>
        {grouped.groups.map((group) => (
          <section key={group.title} className="media-evidence-group">
            <h4>{group.title}</h4>
            <dl>{group.items.map((item, i) => <div key={`${item.kind}-${i}`}><dt>{item.kind}<span className="media-evidence-status" data-status={item.status}>{statusLabels[item.status]}</span></dt><dd>{item.detail}</dd></div>)}</dl>
          </section>
        ))}
        {grouped.notApplicable.length ? (
          <details>
            <summary>{grouped.notApplicable.length} 项与当前平台 / 文件系统 / 挂载类型无关（不适用）</summary>
            <dl>{grouped.notApplicable.map((item, i) => <div key={`${item.kind}-${i}`}><dt>{item.kind}</dt><dd>{item.detail}</dd></div>)}</dl>
          </details>
        ) : null}
      </details>
      {report.condition === 'filesystem-repair' && report.volume && <fieldset disabled={locked || !report.permission}>
        <legend>人工修复预检与镜像演练</legend>
        <label>作用分区 <select value={selected} onChange={(e) => { setSelected(e.target.value); setConfirm(false); setAccepted(false); }}><option value="">请选择</option><option>{report.volume}</option></select></label>
        {!report.permission && <p>权限不足，只能查看或导出证据。</p>}
        {!confirm ? <button className="btn btn-sm" disabled={!selected} onClick={() => setConfirm(true)}>确认作用分区</button> : <>
          <p>系统修复可能影响同卷其他文件。本次只保存关键扇区到本机，不运行写修复；请先确认拥有可用副本。</p>
          <label><input type="checkbox" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} /> 我了解风险并接受免责提示</label>
          <div className="media-diagnostics-actions"><button className="btn btn-sm" onClick={() => { setConfirm(false); setAccepted(false); }}>取消</button><button className="btn btn-sm btn-primary" disabled={!accepted} onClick={() => void perform(async () => {
            setConfirm(false); setAccepted(false);
            const result = await api.repairDryRun(root, { volume: selected, confirmed: true, confirmedAgain: true, disclaimerAccepted: true });
            setStatus(`审计编号 ${result.auditId}。${result.guidance}`);
          })}>二次确认并生成镜像</button></div>
        </>}
      </fieldset>}
    </>}
    <details onToggle={(e) => { if (e.currentTarget.open && !matrix) void api.capabilities().then(setMatrix).catch(() => setStatus('未能读取能力矩阵')); }}>
      <summary>跨平台能力矩阵</summary>
      <label>平台 <select value={platform} onChange={(e) => setPlatform(e.target.value)}>{['Windows', 'Linux', 'macOS'].map((name) => <option key={name}>{name}</option>)}</select></label>
      <p>加密容器、VHD、压缩包内文件系统不支持直接 fsck。</p>
      {matrix && <div className="media-capability-table" tabIndex={0} aria-label="可滚动的能力矩阵"><table><thead><tr><th>接口</th><th>文件系统</th><th>检测</th><th>应用备份集</th><th>直接修复</th></tr></thead><tbody>{matrix.filter((row) => row.platform === platform).map((row) => <tr key={`${row.interface}-${row.filesystem}`}><td>{row.interface}</td><td>{row.filesystem}</td><td>{row.detection}</td><td>{row.backupSet}</td><td>{row.directRepair}</td></tr>)}</tbody></table></div>}
    </details>
    <p role="status">{busy ? '正在处理，请稍候。' : status}</p>
  </section>;
}
