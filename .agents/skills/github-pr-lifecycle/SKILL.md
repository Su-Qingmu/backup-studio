---
name: github-pr-lifecycle
description: 在 Backup Studio 仓库完成 GitHub Pull Request 的完整生命周期管理——PR 发现、远程同步检查、Diff 审查、风险分级、CI 基线分析、Sub-agent 动态调度、正式 Review 提交、修复协调、合并门禁、合并执行与合并后验证。适用于缺陷修复、功能开发、UI/UX 改动、架构调整、重构、性能优化、安全修复、CI/Actions 改动、依赖升级与文档改动；不用于一次性脚本化的 PR 处理，也不用于非本仓库的 PR。
---

# GitHub PR 生命周期管理规范

本 Skill 是 **Backup Studio 仓库长期使用的 GitHub 协作规范**，不是一次性的 PR 审查脚本。

它的目标：让 Agent 在处理本仓库的 PR 时，能**按任务风险自主组织审查**、**按需调用指定模型的 Sub-agent**、**做出有代码证据支撑的 Review 判断**，并在**得到用户明确授权后**安全完成审批与合并。

贯穿全篇的两条铁律：

1. **每次任务都必须重新检查远程仓库**——不得沿用上一次任务的检查结果或审查结论。
2. **内部结论、正式 Review、正式审批是三件事**——Agent 的内部审查结论永远不能冒充 GitHub 上的正式审批。

---

## 0. 执行前必读

### 0.1 本仓库事实基线

下列事实已实测确认（2026-11-23）。**每个新任务仍需重新核实关键项**，但不必从零发现环境。

| 项 | 事实 |
| --- | --- |
| 仓库 | `https://github.com/Su-Qingmu/backup-studio`（公开仓库，`private=false`） |
| 默认分支 | `main` |
| 分支保护 | **无**。`GET /branches/main/protection` 返回 `404 Branch not protected`，因此没有 Required Checks、没有 required reviews、没有强制推送限制 |
| 合并选项 | `allow_squash_merge` / `allow_merge_commit` / `allow_rebase_merge` 均为 `true`；`delete_branch_on_merge` 为 `false` |
| CI 工作流 | `.github/workflows/ci.yml`；步骤序：`checkout` → `setup-node`(Node 22, npm cache) → `npm ci` → `npm run typecheck` → `npm run build:renderer` → `npm run build:electron` → `npm test` |
| Release 工作流 | `.github/workflows/release.yml`（tag `v*.*.*`）、`.github/workflows/release-demo.yml`（tag `v0.1demo`） |
| 本地验证命令 | `npm run typecheck`、`npm run build:renderer`、`npm run build:electron`、`npm test`（**8 套**：engine / auto-sync / write-gate / recycle / transaction-recovery / dup / reveal-authority / recycle-crash） |
| GitHub 身份 | 主账号 `Su-Qingmu`（凭据在 Git Credential Manager，键 `git:https://github.com`） |
| 模块布局 | 引擎 `electron/engine/`、主进程 IPC、渲染层 `src/`、共享契约 `shared/`、测试 `test/` |

**当前工作区存在未提交改动**（审查 PR #16 期间临时停用自动触发）：

- `.github/workflows/ci.yml`：`push` / `pull_request` 触发器被注释，只保留 `workflow_dispatch`。
- `.github/workflows/release.yml`、`.github/workflows/release-demo.yml`：tag 触发器同样被注释，只保留 `workflow_dispatch`。

后果：**push 与 PR 不会自动触发 CI 与 Release**，只有手动 `workflow_dispatch` 能跑。按规范默认**不修改、不恢复、不删除**这些配置；也不得把「未触发」描述成「CI 通过」。

### 0.2 工具调用路径

GitHub 平台操作（PR 查询、Review、合并、CI 状态）**优先使用 `gh` CLI**；**仅当本机未安装 `gh` CLI 时**，回退到本 Skill 原有的 REST API 规则。

- `gh` 位于 `C:\Program Files\GitHub CLI\gh.exe`（v2.105.0）；当前 PowerShell 会话 PATH 未刷新时用全路径调用。
- `gh` 未登录：用 `git credential-manager get` 取 token（输入 `protocol=https\nhost=github.com\n`），经 `$env:GH_TOKEN` 与 `$env:GITHUB_TOKEN` 注入后调用 `gh`（现成封装见 `D:\My file\桌面\backup-studio-automation\ghx.ps1`，该目录已删除则按同模式自写）；**token 值不得打印到 stdout、日志或报告**。
- 代码推送：新建 PR 用 `gh pr create`（会自动推送 head 分支）；向既有分支推送提交用 `git push`（代理写法见 [合并与门禁策略](./references/merge-policy.md)）。安全红线不变：不得向 `main` 直接推送、不得强制推送。

本机未安装 `gh` CLI 时，回退到内置助手：

```powershell
node .agents/skills/github-pr-lifecycle/scripts/gh-api.mjs get repos/Su-Qingmu/backup-studio/pulls/16 --fields state,merged,head.sha
node .agents/skills/github-pr-lifecycle/scripts/gh-api.mjs post repos/Su-Qingmu/backup-studio/pulls/16/reviews --body '{"event":"COMMENT","body":"..."}'
```

- 凭据由脚本内部从 Git Credential Manager 读取，**不会打印到 stdout**。
- 退出码：`0` 成功 / `2` 凭据不可用 / `3` 网络失败 / `4` GitHub 返回错误状态码 / `5` 参数错误。**非 0 时不得声称操作成功。**
- 需要绕过助手直接调用时：凭据用 `git credential-manager get`（注意 `git credential fill` 在本机会报 `refusing to work with credential missing protocol field`，不可用）；`curl` 需要 `--ssl-no-revoke`（schannel 的 `CRYPT_E_NO_REVOCATION_CHECK` 会让 curl 以 exit 35 失败）；系统代理 `127.0.0.1:3067`（Karing）**可能处于关闭状态**，探测端口在监听再决定是否走代理。
- `git push` 的代理写法与两条合并路径的选择见 [合并与门禁策略](./references/merge-policy.md)。

### 0.3 按需读取的参考文档

核心流程在本文件，细则按任务加载，不必每次全量读取。

| 当前任务 | 必读参考 | 核心产出 |
| --- | --- | --- |
| 审查 Diff、定级、判是否阻止合并 | [审查清单](./references/review-checklist.md) | 分级后的发现清单、阻断判定 |
| 决定是否派 Sub-agent、派谁、用哪个模型 | [Sub-agent 调度策略](./references/subagent-policy.md) | 派工单、角色/模型映射、复核清单 |
| 判断能否 Approve / 提交正式 Review / 能否合并 | [审批与授权策略](./references/approval-policy.md) | 模式选择、授权判定、Review 提交边界 |
| 执行合并、判门禁、做合并后验证 | [合并与门禁策略](./references/merge-policy.md) | 12 条门禁结论、合并路径、合并后核实 |

---

## 1. 操作模式

四种模式决定 Agent 可以做什么。**用户没明说模式时，先按 Mode A 执行，只做审查并给出建议。**

| 模式 | 允许 | 禁止 | 额外要求 |
| --- | --- | --- | --- |
| **A · Review Only** | 只审查，产出结论与建议 | 不提交正式 Review、不改代码、不合并 | 无 |
| **B · Review and Fix** | 在 PR 来源分支做必要修复 | 不直接推 main、不强制推送、不覆盖用户已有工作 | 提交前检查远程；修复后重新审查 |
| **C · Review and Approve** | 按用户明确授权提交正式 GitHub Review | 不得把内部结论当授权 | 须有用户对**本次 PR** 的明确授权 |
| **D · Review and Merge** | 完成门禁后执行合并 | 不得绕过分支保护或 Required Checks | 须有用户对**本次 PR 当前版本**的明确合并授权 |

模式可以叠加升级（A → B → C → D），但**不得跳级**。判定细则见 [审批与授权策略](./references/approval-policy.md)。

---

## 2. 第 0 步：强制远程同步检查

> **每次开始新的 PR 任务，都必须重新执行本节。** 不能依赖上一次任务的检查结果。

### 2.1 检查清单

1. `git remote -v` —— 远程地址是否为本仓库。
2. `git status --short --branch` —— 工作区是否干净（**有未提交改动要如实报告**，不得覆盖用户修改）。
3. `git branch -vv` —— 当前分支跟踪的是哪个远程分支。
4. `git fetch origin --prune` —— 获取最新远程状态（注意代理可能不可用，先探测）。
5. 本地 HEAD SHA。
6. 远程跟踪分支 HEAD SHA。
7. 本地相对远程的 ahead / behind 数量。
8. PR 当前 Head SHA / Base SHA / 状态 / 是否已合并或关闭。
9. 是否存在新的提交、Review 或 CI 结果。

> **上游分支已被删除时的取值口径**：`git status --short --branch` 会显示 `[gone]`，此时 `git rev-parse '@{u}'` 与 `git rev-list --left-right --count '@{u}...HEAD'` **会直接报错**（`ambiguous argument '@{u}'`）。这属于「远程来源分支已不存在」，不是本地出错。改用以下方式取证，并在同步状态块中如实标注该状态：
>
> - 远程实际分支：`git ls-remote --heads origin`
> - PR 当前 Head / Base SHA：以 API `pulls/{n}` 的 `head.sha` / `base.sha` 为准
> - 本地与 PR 的差异：直接比较 `git rev-parse HEAD` 与 API 的 `head.sha`
>
> 本仓库当前就处于该状态：远程只剩 `main`，PR #16 仍为 `open` 且 Head SHA 与本地 HEAD 一致，但来源分支已不在远程。此时**无法直接用 GitHub 合并按钮合并**（先确认 `head.repo` 与 `head.ref`），需要先恢复来源分支或改走本地合并路径，并报告这一情况。

### 2.2 必须区分的四个 SHA

审查与合并前，必须分别确认这四个值，**不得混用**：

| 名称 | 含义 | 来源 |
| --- | --- | --- |
| 本地 HEAD | 本机工作副本当前提交 | `git rev-parse HEAD` |
| 远程来源分支 HEAD | 远程 PR 源分支的最新提交 | `git rev-parse <remote>/<branch>` |
| **PR Head SHA** | GitHub 上 PR 当前记录的提交 | API `pulls/{n}` → `head.sha` |
| **目标分支最新 HEAD** | 合并目标（如 `main`）的当前提交 | API `pulls/{n}` → `base.sha` |

只有确认**本地代码与远程 PR 版本一致**，才可使用之前的审查结论。**如果本地有尚未推送的合法修改，必须如实记录，不得简单认定代码一致。**

### 2.3 同步状态输出块

每次任务开始时输出：

```text
当前分支：<branch>
本地 HEAD：<sha>
远程 HEAD：<sha>
PR Head SHA：<sha>
PR Base SHA：<sha>
ahead / behind：<n> / <n>
工作区状态：<clean | 具体改动文件>
是否同步：<yes / no>
是否允许继续：<yes / no + 理由>
```

### 2.4 PR 出现新提交时

1. 重新获取最新代码。
2. 重新检查新增 Diff。
3. 重新评估受影响文件。
4. 对受影响部分重新测试。
5. **旧版本的审查结论不能直接用于新版本。**
6. **旧版本的 Approve 不能自动视为新版本已获批准。**
7. **旧版本的合并授权不能自动适用于新版本。**

发现无法解释的差异时，**立即停止审批和合并**，先报告。

### 2.5 绝对禁止

`git reset --hard`、强制推送、覆盖远程分支、删除用户提交、自动丢弃本地修改、未经检查直接切换到可能覆盖用户工作区的分支。

---

## 3. PR 发现与状态检查

- 用 API 列出 PR：`node scripts/gh-api.mjs get 'repos/Su-Qingmu/backup-studio/pulls?state=all&per_page=30'`。
- 对目标 PR 取 `state` / `merged` / `draft` / `mergeable` / `mergeable_state` / `head` / `base` / `commits` / `changed_files` / `additions` / `deletions`。
- 同时取 reviews、issue comments、inline comments、check-runs、workflow runs。
- **`closed` 不等于 `merged`**：本仓库历史 PR #1、#2 是本地合并后推送到 `main` 的，GitHub 上显示为 `closed` 而非 `merged`。判断「是否真的合入」**以目标分支是否包含合并提交为准**，不要只看 PR 的 `merged` 字段。详见 [合并与门禁策略](./references/merge-policy.md)。
- **注意来源分支可能已被删除**：PR 仍显示 open，但 `git ls-remote --heads origin` 只有 `main`——此时无法直接用 GitHub 合并按钮合并，需先恢复来源分支或走本地合并路径，并报告这一情况。

---

## 4. 代码审查

**必须以实际代码和 Diff 为依据**，而不是只看 PR 标题、描述或提交信息。

审查维度、风险分级、发现记录格式、复审要求见 [审查清单](./references/review-checklist.md)。核心结论：

- 风险分级：`Critical` / `High` / `Medium` / `Low` / `Informational`。
- 每条发现必须含：文件路径、行号或代码位置、问题描述、影响范围、复现条件、建议修复方式、是否阻止合并。
- **不得把个人编码偏好描述成 Bug。**
- 优先发现真实缺陷，不为了增加问题数量而制造意见；不要求与现有架构不一致的重构，不要求无关的代码风格调整。
- 不因文件数量少就降低审查标准；不因 PR 作者或贡献者身份改变审查标准。
- 证据不足的问题明确标记为**待确认**，不要写成确定结论。

**本仓库既有的复审惯例**（写进报告）：关键工作流采用**独立只读复审**，产出 `VERDICT: FAIL` / `VERDICT: PASS`，发现按 `C1` / `H1` / `M2` 编号；每个 Critical/High 修复必须有回归用例固定；修复后要**收窄范围复审**（只复核上一轮实际改动的那几处）；残余风险必须如实写明，不得宣称已关闭；「刻意不修的性能取舍」与「遗漏」必须显式区分。

---

## 5. CI 与测试基线分析

CI 失败必须先归类，再判断：

| 类别 | 判定方式 | 处理 |
| --- | --- | --- |
| PR 新引入的失败 | base 通过、head 失败，且失败项与本次 Diff 相关 | 阻止合并，要求修复 |
| main 基线已有的失败 | base 与 head **同样失败**，失败项一致 | 记录失败项、说明与本次 Diff 的关系、尽可能本地复现；**不得擅自改无关业务代码或测试来消除红灯**；若该失败影响本 PR 核心功能验证，仍需阻止合并或要求额外验证 |
| 环境/依赖/基础设施导致 | 失败特征与代码无关（网络、npm registry、runner 环境） | 标注为环境问题，必要时重跑 |
| 无法确认来源 | 证据不足 | 标记待确认，**不得默认安全** |

对比方式：**优先对比 PR Base SHA 与 PR Head SHA 两次 CI 运行**（base 通常是 `main` 上的 push 运行，head 是 `pull_request` 运行）。

CI 状态必须准确区分：`Success` / `Failure` / `Pending` / `Cancelled` / `Skipped` / `Neutral` / `Not run`。
**不得将 Skipped、Pending、Cancelled、Neutral 或 Not run 描述为 CI 通过，也不得把「未触发」描述成「通过」。**

> **本仓库的真实基线示例**：PR #16 的 head `729ac88` 与 base `39f5796`（main）两次 CI 运行**失败在同一处**——`Run all tests` 步骤中 `test/dup.test.ts` 的 **T13**（还原成功后索引写失败）与 **T26**（存放路径是 UNC 网络路径），其余 8 套测试全部通过。这属于**基线已有失败**，不是 PR 引入。

**CI 自动触发配置**：默认**不修改** `.github/workflows/` 的触发配置。若仓库已临时停用（当前即是），保留现状、如实说明哪些工作流不会自动触发、检查是否仍支持手动触发，**不得擅自恢复或删除**。若用户明确要求临时停用：只改自动触发配置、尽量保留 `workflow_dispatch`、保留原有 jobs/steps/测试命令与测试代码、不删测试、不注释业务代码或测试逻辑、记录原始触发配置与恢复方法。**不得通过修改 Required Checks 或绕过分支保护来消除红灯。**

---

## 6. Sub-agent 动态调度

这是 Skill 的正式组成部分，不是可选附加说明。

- **不要求每个 PR 都启动子代理**，但确有必要时应主动启动，而不是等待用户逐一指定。
- 适合：跨多个独立模块；架构/安全/数据一致性高风险改动；涉及 Electron/前端/后端多领域；CI 失败原因复杂需独立分析基线；需要独立审查者交叉验证；PR 规模大易遗漏；涉及 Actions/Release/Tag/Workflow。
- 不适合：极小文档修改；简单单文件低风险修复；没有可独立分配的任务；协调成本明显高于收益。
- **不得为了展示多代理能力而无意义地启动子代理。**

模型只允许从规格模型库中选取；调用前必须先确认平台实际支持的模型标识，不得假设别名可用；**模型不可用或代理启动失败时如实报告，不得虚构调用结果**。**Critical / High 风险 PR 至少应安排最高档模型做独立审查。**

角色选择有个硬约束：**纯取证用 `explore`，审计/复审/验收用 `verifier`**——角色选错会被运行时拒绝并零产出。

派工单要素、角色与模型映射、并行/串行规则、主代理复核清单见 [Sub-agent 调度策略](./references/subagent-policy.md)。

**主代理始终对最终结果负责**：检查子代理实际输出、判断结论是否有代码证据支持、处理子代理之间的冲突、对重要问题独立验证。**不得把子代理意见直接视为事实，不得将内部审查冒充 GitHub 正式 Review，最终审批与合并决策必须由主代理作出。** 没有启动子代理时，在最终报告中说明原因。

---

## 7. Review 与 Approval

必须区分三件事：

| | 产生方 | 记在哪 | Agent 能否自行替代 |
| --- | --- | --- | --- |
| 内部审查结论 | Agent / Sub-agent | 本次会话报告 | —— |
| GitHub 正式 Review | 经授权后提交到 GitHub | PR 的 Reviews 列表 | 需用户授权 |
| 仓库保护规则要求的正式审批 | 仓库规则 / 有写权限的其他成员 | 分支保护 | 不能（也不得伪造） |

**Agent 不能把自己的审查结果伪装成其他真人或团队成员的批准。**

- **Approve**：审查完成、无未解决 Critical/High、重要 Medium 已修或理由可接受、符合项目架构、测试足以支撑变更、CI 已检查、**PR Head SHA 与审查依据一致**。
- **Request Changes**：存在 Critical/High、核心功能缺陷未修、明显安全问题、关键测试缺失、PR 修改不符合预期、需要作者修改后重新审查。Review 意见必须具体、可执行。
- **Comment**：有建议但不阻止合并、需作者确认设计选择、发现潜在问题但证据不足、需记录额外验证要求。

**正式提交 Review 的权限边界**：默认允许 Agent 自主完成审查并生成 Review 建议；但**正式提交 Approve / Request Changes / Comment 必须有用户当前授权**。若当前 GitHub 账号就是 PR 作者，或仓库规则禁止自审自批：不得尝试绕过、不得伪造他人审批、不得把普通评论冒充正式 Approve，应报告需要独立 Review 的原因。

细则与操作流程见 [审批与授权策略](./references/approval-policy.md)。

---

## 8. PR 修复协调

允许在 PR 来源分支上实施必要修复，但必须：优先最小化修改、遵循项目现有约定、**不做无关重构**、**不修改 main**、不覆盖用户已有工作、不强制推送、不擅自修改与 PR 无关的业务模块、提交前再次检查远程分支、修复后重新检查完整相关 Diff、修复后重新执行适用测试、修复后重新审查。

需要 Sub-agent 实施修改时，必须明确分配文件所有权，**不得让多个子代理同时修改同一文件**。修复范围明显超出 PR 原始目标时，先报告并等用户决定是否扩大范围。

**修复完成后，不能沿用修复前的 Approve 结论。**

---

## 9. 合并授权

**必须有用户对本次 PR 的明确合并授权。**

算明确授权：「合并 PR #16。」「按照你给出的条件，直接合并这个 PR。」「批准并合并当前这个 PR。」

不算明确授权：「看看这个 PR。」「帮我审查一下。」「准备合并。」「给我合并建议。」

授权只适用于**明确指定的 PR**和**当前审查版本**。授权后若 PR Head SHA 发生变化，原授权不再自动适用，必须重新审查，必要时重新请求确认。

合并过程中出现新的风险、CI 状态变化、分支冲突或审批失效，**立即停止**。

细则见 [审批与授权策略](./references/approval-policy.md)。

---

## 10. 合并前强制门禁

**每次真正执行 Merge 之前都必须重新检查这 12 条**（不是"之前查过就行"）：

1. PR 仍处于 Open 状态。
2. PR 最新 Head SHA 与审查版本一致。
3. Base 分支正确。
4. 没有未解决的 Critical / High 问题。
5. 所有必要 Review 已完成。
6. 没有未解决的阻塞性 Review。
7. CI 和 Required Checks 状态已经核实。
8. 分支保护规则已经检查。
9. 是否存在 Merge Conflict。
10. 是否有新的提交或评论。
11. 合并策略符合仓库约定。
12. 用户对当前 PR 的合并授权仍然有效。

任何一条不满足：**不得执行合并**，输出具体阻塞原因、给出解决建议、等待条件满足后重新检查（重新跑完整门禁，不是只补测那一条）。

**不得绕过分支保护或 Required Checks。不得使用 Admin Bypass，除非用户针对具体情况明确授权且仓库策略允许。**

> 本仓库 `main` **没有分支保护**，因此第 7、8 条拿不到平台强制保护——**必须由 Agent 主动读取并核对**，不能因为「没有分支保护」就认为门禁自动满足。

合并策略、两条合并路径的选择与核实见 [合并与门禁策略](./references/merge-policy.md)。

---

## 11. 合并后验证

**成功执行合并后不能直接结束任务。** 必须重新获取远程状态并验证：

1. PR 是否显示 Merged。
2. GitHub 记录的合并时间。
3. 合并提交 SHA。
4. 目标分支是否包含合并结果。
5. 远程 main 是否已更新。
6. 是否存在新的 CI 结果。
7. 是否有合并后出现的异常。
8. 本地仓库是否需要同步。
9. 是否有未提交文件或意外修改。

**合并成功但本地同步失败时**：不得直接覆盖本地修改；报告本地与远程差异；给出安全同步方案。

**不得自动删除 PR 来源分支**，除非用户明确要求。

验证清单与安全同步方案见 [合并与门禁策略](./references/merge-policy.md)。

---

## 12. GitHub 操作安全红线

严格禁止：

- 未经授权直接合并。
- 强制推送。
- 直接向 main 推送修改。
- 删除用户提交。
- 删除其他人的分支。
- 修改无关 PR。
- 伪造 Review。
- 绕过分支保护。
- 删除或禁用测试以制造通过结果。
- 将未运行的 CI 描述成通过。
- 未检查远程状态就提交或合并。

所有具有外部影响的 GitHub 操作，必须确保目标 PR、分支和提交 SHA 正确。

**如果 GitHub API、权限或工具不可用**：明确说明操作未完成，**不得声称成功**，并提供准确的后续操作命令或步骤。

---

## 13. 最终报告规范

每次执行 Skill 后，必须输出结构化报告。

**Result**（总体结论，只能取其一，不得混用）：`Approved` / `Changes Requested` / `Ready to Merge` / `Merged` / `Blocked` / `Review Only`。
注意：`Ready to Merge` 不代表已经 `Merged`；`Approved` 是内部结论，不等于 GitHub 上已有正式 Approve。

1. **仓库同步状态** —— 当前分支、本地 HEAD、远程 HEAD、PR Head SHA、PR Base SHA、ahead/behind、工作区状态、是否与远程同步。
2. **PR 基本信息** —— 编号、标题、作者、来源分支、目标分支、修改文件数、Diff 规模、当前状态。
3. **审查结果** —— 主要问题、风险等级、文件路径与行号、是否阻止合并、修复建议。
4. **Sub-agent 调度结果** —— 表格列出「角色 / 模型 / 任务 / 结果（完成·部分完成·失败）」；未启动则说明原因。
5. **CI 与测试** —— Required Checks 状态、PR CI 结果、Base CI 结果、基线失败与新增失败的区分、本地测试结果、未验证项目。
6. **Review / Approval** —— 内部审查结论、是否提交正式 Review、Review 类型、GitHub 实际记录状态、是否需要独立审批。
7. **修改记录** —— 修改文件、修改内容、修改理由、提交 SHA、是否推送。
8. **合并状态** —— 是否具备合并资格、是否获得用户授权、使用的合并策略、是否执行 Merge、合并提交 SHA、合并后验证结果。
9. **后续建议** —— 只列真正需要处理的事项，不输出无关建议。

---

## 14. 本 Skill 的维护自检清单

修改本 Skill 后重新核对：

1. `SKILL.md` 格式符合平台规范（frontmatter 的 `name` 与 `description` 齐备）。
2. Skill 能被 Codex 正确发现（目录为 `.agents/skills/<name>/`，入口文件为 `SKILL.md`）。
3. 无重复或互相矛盾的规则。
4. 权限边界清晰（Mode A/B/C/D 与「内部结论 ≠ 正式 Review ≠ 正式审批」）。
5. Review 与 Merge 授权区分明确。
6. Sub-agent 模型选择写入正式规范，且标注了平台实际模型标识与不可用模型的处理方式。
7. 明确要求每次任务先检查远程仓库。
8. 覆盖 CI 基线失败。
9. 覆盖合并后验证。
10. **不存在无法执行或依赖不存在工具的要求**（GitHub 调用示例：本机装有 `gh` CLI 时优先用 `gh`；未安装时必须用 `scripts/gh-api.mjs` 或 REST API）。
11. 辅助文档被 `SKILL.md` 正确引用，链接路径真实可解析。

**不要为了验证本 Skill 而擅自执行真实 PR 合并。** 可以做静态检查与模拟流程检查。
