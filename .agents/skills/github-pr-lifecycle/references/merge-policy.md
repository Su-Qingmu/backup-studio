# 合并门禁、策略与合并后验证

本文件是 [SKILL.md](../SKILL.md) 的执行细则。每次真正合并前都要重新核对远程状态；历史观察不能代替当前门禁。**每次开始新的 PR 任务，都必须重新检查本地与远程仓库状态**——不得沿用上一次任务的检查结果。以下命令以仓库根目录为起点，`$n` 是目标 PR 编号，`$reviewedSha` 是完成审查时记录的完整 Head SHA。`scripts/gh-api.mjs` 指本 Skill 的 `../scripts/gh-api.mjs`，从仓库根目录调用时用 `node .\.agents\skills\github-pr-lifecycle\scripts\gh-api.mjs`。只对已确认的 `Su-Qingmu/backup-studio` 目标执行操作。

## 合并前强制门禁

先回读 `GET /repos/Su-Qingmu/backup-studio/pulls/{n}`、评论、Review、Checks、分支和仓库配置，在执行合并的紧邻时刻再次跑完下表全部 12 条。示例只读调用：`node .\.agents\skills\github-pr-lifecycle\scripts\gh-api.mjs get "repos/Su-Qingmu/backup-studio/pulls/$n" --pretty`。合并请求必须带审查过的 Head SHA（见下文）。

| # | 检查什么 | 怎么检查（只读） | 不通过时的阻塞原因描述 | 解决建议 |
| --- | --- | --- | --- | --- |
| 1 | PR 仍为 Open，未被关闭/合并 | `GET /pulls/{n}` 的 `state == open`、`merged == false`，确认编号与仓库 | `PR #n 已关闭/合并，不能再次合并` | 核对远程目标与关闭原因；需要新变更时走新 PR，重新审查授权 |
| 2 | 最新 Head SHA 等于审查版本 | `GET /pulls/{n}` 的 `head.sha` 对照 `$reviewedSha`；同时核对 `head.repo`、`head.ref` | `Head SHA 从 A 变为 B，已有审查失效` | 对新 SHA 重新审查、重跑相关门禁并重新确认授权；API 合并时传 `sha` 防竞态 |
| 3 | Base 分支正确 | `GET /pulls/{n}` 的 `base.repo.full_name` 和 `base.ref`；本仓库目标应为 `Su-Qingmu/backup-studio:main` | `Base 不是预期 main/仓库` | 先更正目标分支并重新评估 diff、CI 与授权 |
| 4 | 没有未解决 Critical / High | 读审查记录、`GET /pulls/{n}/comments`、`GET /issues/{n}/comments`，按[审查清单](./review-checklist.md)逐项确认 | `Critical/High 问题仍未解决：<定位>` | 修复或给出可验证的消解证据，必要时重新审查 |
| 5 | 所有必要 Review 已完成 | `GET /pulls/{n}/reviews`，按最新提交和[审批与授权策略](./approval-policy.md)核对所需 Review 与审批者 | `缺少 <所需 Review> / 审批不覆盖最新提交` | 请相应审查者完成 Review；变更后重新核对有效性 |
| 6 | 没有未解决的阻塞性 Review | `GET /pulls/{n}/reviews` 的最新有效 `CHANGES_REQUESTED`，并查未解决 review threads（GraphQL `pullRequest.reviewThreads` 的 `isResolved`） | `仍有请求修改/未解决阻塞线程` | 处理并由有权审查者确认；不可代替他人伪造 Review |
| 7 | CI 和 Required Checks 已核实 | `GET /repos/{owner}/{repo}/commits/{sha}/check-runs`、`GET /commits/{sha}/status`；核对当前 Head 的运行、结果、所需检查名称及适用规则 | `CI 未触发/待运行/失败/检查缺失，不能称通过` | 取得可核实的对应 SHA 结果，区分基线与新增失败；未满足的 Required Check 必须修复/等待，不得绕过 |
| 8 | 分支保护规则已检查 | `GET /repos/Su-Qingmu/backup-studio/branches/main/protection`，并核对适用 rulesets（`GET /repos/{owner}/{repo}/rules/branches/main`）及 Required Checks/Review | `保护/规则未知或受保护要求未满足` | 查明权限和适用规则，满足规则后重查；不能用 Admin Bypass 或修改规则消除红灯 |
| 9 | 无 Merge Conflict | `GET /pulls/{n}` 的 `mergeable`、`mergeable_state`；`mergeable == null` 时等待 GitHub 计算后重新查询 | `存在冲突或可合并状态未确定` | 在 PR 分支解决冲突并审查新 Head；不把 `null` 当成可合并 |
| 10 | 无未经处理的新提交或评论 | 对比已审查时间/记录与 `GET /pulls/{n}/commits`、`GET /issues/{n}/comments`、`GET /pulls/{n}/comments`、Reviews 和 threads 的时间与内容 | `审查后出现新提交/评论，尚未处理` | 阅读并回应实质变化，必要时重新审查、核对 SHA 与授权 |
| 11 | 合并策略符合仓库约定 | `GET /repos/Su-Qingmu/backup-studio` 的 `allow_*_merge` 与既有约定，核对拟用 `merge_method`、标题、提交信息 | `拟用方法或标题不符合约定/不可用` | 按仓库约定选可用方法并修订合并标题/提交信息 |
| 12 | 用户对**当前 PR、当前 Head、当前合并方式**的授权仍有效 | 对照用户针对 PR 的明确授权与[审批与授权策略](./approval-policy.md)，复核最新 SHA、base、方法和新增事实 | `没有合并授权/授权不覆盖当前版本或条件` | 请用户明确授权当前目标；条件变化后重新核对，不能从沉默推定授权 |

本仓库 `GET /branches/main/protection` 返回 **404**：`main` 当前无分支保护、Required Checks、required reviews，也没有分支保护提供的 forced push 限制。404 不是 CI 通过证明，也不是允许绕过规则的授权；仍须主动读取 Head SHA 对应的 CI、status 与检查名称，并查适用 rulesets。没有服务器强制检查时，Agent 仍按本表判定，不能自动判门禁 7/8 已满足。若 API 返回权限/网络错误，不能把它当作已确认的 404；门禁保持未核实。不得绕过分支保护或 Required Checks；Admin Bypass 仅在用户针对具体情况明确授权且仓库策略允许时才可能考虑，仍须说明偏差并完成其余门禁。

**来源分支已被删除时**：`git status --short --branch` 显示 `[gone]`，`git rev-parse '@{u}'` 会以 `ambiguous argument '@{u}'` 报错——这是远程来源分支不存在的正常表现，不是本地状态损坏。取证改用 `git ls-remote --heads origin` 与 API 的 `head.sha` / `head.ref` / `head.repo`，并把「来源分支缺失」作为门禁 2、门禁 12 的显式事实记录。此时 GitHub 合并路径通常不可用（需先恢复来源分支），改走本地路径必须另有明确授权，且不得因此降低其余门禁。

当前工作区 `.github/workflows/ci.yml` 的 `push` / `pull_request` 自动触发被**临时注释**，只保留 `workflow_dispatch`；`.github/workflows/release.yml` 的 `v*.*.*` tag 与 `.github/workflows/release-demo.yml` 的 `v0.1demo` tag 自动触发也被临时注释，只保留 `workflow_dispatch`。这些是未提交的本地改动，不得擅自恢复或删除；远程实际生效内容还须以远程分支文件核实。当前所见配置下 push/PR 不会自动触发 CI，tag 也不会自动触发 Release；**未触发不等于 CI 通过**。临时停用不等于永久取消 CI，恢复方式写在各文件注释中：删除临时注释段并还原对应触发器行（CI 的 push/pull_request，Release 的 tag push）。停用期间不得修改 Required Checks 或绕过保护消除红灯。若需手动运行 `workflow_dispatch`，必须先确认该写操作的目标 ref、权限与授权，结果必须对应被审查的 SHA；不能拿别的 SHA 的绿灯替代。

CI 失败定位顺序：`checkout` → `setup-node`（Node 22、npm cache）→ `npm ci` → `npm run typecheck` → `npm run build:renderer` → `npm run build:electron` → `npm test`。本地对应质量命令依次是 `npm run typecheck`、`npm run build:renderer`、`npm run build:electron`、`npm test`。以审查时的 `package.json` 为准：当前 `npm test` 串联 **8 套**——engine / auto-sync / write-gate / recycle / transaction-recovery / dup / reveal-authority / recycle-crash；脚本前序失败时后续套件不算通过，不得虚构不存在的套件。

判定基线红灯须比较同一流程、同一失败点的 PR Head 与 Base，记录各自 SHA、run URL、失败测试和其余步骤，不得把基线失败说成 PR 新增，也不得把失败说成通过。例如 PR #16 Head `729ac88` 与 main Base `39f5796` 的两次 CI 均失败于 `Run all tests` 中 `test/dup.test.ts` 的 T13（还原成功后索引写失败）和 T26（存放路径是 UNC 网络路径），其余测试套通过：这是已有基线失败而非该 PR 引入。仍须如实报告 CI 红灯、Required Checks 是否因此阻塞，并按本次授权与门禁处理；不能据此跳过 Required Checks 或制造通过结果。

**任一门禁未满足：不得合并。**列出具体编号、远程证据/SHA/运行链接、阻塞原因和解决建议，等待条件满足；之后**重新跑完整 12 条门禁**，不能只补测失败的一条。工具不可用或状态未确定也按未满足处理。

## 合并策略与路径

先遵循仓库已有合并约定。本公开仓库默认分支 `main`，`allow_squash_merge`、`allow_merge_commit`、`allow_rebase_merge` 均为 `true`，`delete_branch_on_merge` 为 `false`。没有明确约定时默认推荐 **Squash and merge**：把已审查 PR 作为一个清晰的提交纳入 main，标题简洁并符合项目提交规范，提交正文保留有意义的 PR 描述与提交信息。协作者 PR 若按既有历史约定保留线性提交、提交本身有独立意义，且 Head 可快进、授权覆盖该方法，才优先考虑 FF；不能以“过去曾 FF”为理由跳过门禁。Merge commit / rebase 仅在仓库约定、审查后的提交身份与授权均匹配时使用。不得擅自删除来源分支或修改其他 PR。

- **默认优先路径 (a)：GitHub 合并按钮或 `PUT /repos/{owner}/{repo}/pulls/{number}/merge`。**在刚完成全部门禁后，确认仓库、PR 编号、base、Head SHA、merge_method，再提交带 `sha: <reviewedSha>` 的请求（如 `merge_method: squash`）；响应须回读验证。该路径由 GitHub 标记 PR `merged`，并记录 `merged_at` 与 `merge_commit_sha`。不执行未经授权的写请求。
- **历史路径 (b)：本地合并后推送 main。**本仓库该路径下 GitHub 将 PR 自动关闭为 `closed` 而非 `merged`。本仓库历史 PR #2 快进合入、零冲突；PR #1 因贡献者 rebase 后 force-push 使 Head 不在 base 历史中，GitHub 不认 merged，历史上又用 `git merge -s ours` 记录合并关系才被识别。此事实不是重复 force-push、`ours` 或直接推 main 的许可。路径 (b) 会绕开 PR 的 CI/Required Checks，风险更高；只有用户明确指定且常规门禁确实无法通过时才**考虑**，必须报告偏差。当前安全红线禁止直接向 main 推送、禁止绕过 Required Checks，因此在该约束仍有效时不得实际执行路径 (b)；应停下请求仓库政策与具体授权澄清，不得用本地路径偷渡红灯。

核实“真的合入”以目标分支是否包含**实际合并结果提交**为准，不能只看 PR 的 `merged` 字段。`merged` + main 包含结果为已合入；`closed` + main 包含该结果也为已合入；`closed` + main 不含结果为未合入。对于 squash/rebase，原 Head SHA 不一定成为 main 祖先，须比较合并结果 SHA、tree/diff 与 PR 变更，不能仅用 `git merge-base --is-ancestor <head> origin/main` 否定合入。状态与内容不一致时报告异常并暂停后续操作。

## 推送与网络

本机 `git` 未配置 `http.proxy`；直连 `github.com:443` 有时超时或连接重置。Karing 系统代理 `127.0.0.1:3067` 可能未运行；先用 `Test-NetConnection 127.0.0.1 -Port 3067` 探测 `TcpTestSucceeded`，端口未监听时不可盲目指定代理（会 `Connection refused`），直连可用时直接连接。仅在**其他独立授权操作**确需推送且不触犯禁止直推 main 时，实测命令形式为 `git -c http.proxy=http://127.0.0.1:3067 -c http.version=HTTP/1.1 -c http.sslBackend=openssl push origin main`；其中 `push origin main` 在本 Skill 的安全红线下**不得执行**，这里只记录网络诊断写法，不构成执行许可。`http.sslBackend=openssl` 可避免 schannel 的 `server closed abruptly (missing close_notify)`，但若报 `unable to get local issuer certificate`，改回默认 schannel；不得关闭证书验证。`--force`、`--force-with-lease` 均不得作为常规流程，安全红线明确禁止强制推送。

GitHub 平台操作**优先使用 `gh` CLI**（GCM token 注入方式见 [SKILL.md 0.2](../SKILL.md)；`gh` 命令退出码非 0 或输出异常时同样不得声称操作成功）。**仅当本机未安装 `gh` CLI 时**，使用仓库现有 `scripts/gh-api.mjs`（Node 脚本，`node .\.agents\skills\github-pr-lifecycle\scripts\gh-api.mjs <method> <path> [--fields a,b] [--pretty] [--body '<json>']`）：它从 `git credential-manager get` 取主账号 `Su-Qingmu` 的 40 字符 token，在进程内使用，不得把 token 值打印到终端报告或日志；走 Node 自带的 OpenSSL，不受 Windows schannel 吊销检查（`CRYPT_E_NO_REVOCATION_CHECK` / curl exit 35）影响，且保持证书校验。退出码：`0` 成功 / `2` 凭据不可用 / `3` 网络失败 / `4` GitHub 返回错误状态码 / `5` 参数错误，**非 0 时不得声称操作成功**。若绕过该脚本直接用 `curl.exe`，必须补 `--ssl-no-revoke`，同样不得关闭证书校验。检查凭据时只确认账号、可用性和长度，绝不输出 token、请求 Authorization header 或完整凭据响应。每项对外 GitHub 操作都须先确认仓库、PR、分支、提交 SHA 和授权；写接口返回后再回读。

## GitHub 操作安全红线

严格禁止以下行为：

1. **未经授权直接合并**：即使所有 CI 绿灯也必须有当前 PR 的有效合并授权。
2. **强制推送**：不得用 `--force` / `--force-with-lease` 改写协作者或 main 历史。
3. **直接向 main 推送修改**：PR 合并应走授权的 GitHub 合并路径；历史本地合并不是当前许可。
4. **删除用户提交**：不能为消除冲突/红灯而丢弃用户已有提交。
5. **删除其他人的分支**：`delete_branch_on_merge: false`，尤其不得清理贡献者来源分支。
6. **修改无关 PR**：只操作本次确认编号、仓库和 SHA 的 PR。
7. **伪造 Review**：不得代审查者提交 `APPROVE`、伪称已完成必要 Review。
8. **绕过分支保护**：不能因保护接口 404 或有管理员权限就绕过现有或新增规则。
9. **删除或禁用测试以制造通过结果**：不得改 `npm test` 或 CI 步骤掩盖 T13/T26 等失败。
10. **将未运行的 CI 描述成通过**：当前仅手动触发时，缺失检查应报告“未触发/未核实”。
11. **未检查远程状态就提交或合并**：执行前必须回读 PR、Head SHA、base、checks、保护/规则与授权。

若 GitHub API、权限、凭据或工具不可用，标明“未执行/未完成”，列出失败的接口、HTTP 状态或错误（不含 token），不得声称操作成功。给出准确后续步骤：例如从仓库根目录运行 `node .\.agents\skills\github-pr-lifecycle\scripts\gh-api.mjs get 'repos/Su-Qingmu/backup-studio/pulls/16' --fields state,merged,merged_at,merge_commit_sha` 核对状态；凭据失败由用户在交互终端检查 Git Credential Manager 的 `protocol=https` / `host=github.com`，权限不足由有权人处理，网络/TLS 失败先查代理监听与证书链。只在确认授权与全部门禁后才能由有权操作者执行写接口，不提供绕过门禁的替代命令。

## 合并后验证

**合并成功不等于任务结束。**执行合并后重新获取远程状态；若任一项无法核实，报告未核实项和原因，不得将其写成成功。

| # | 必须验证 | 具体验证手段与异常处理 |
| --- | --- | --- |
| 1 | PR 是否显示 Merged | 回读 `GET /pulls/{n}` 的 `state`、`merged`；路径 (b) 的 `closed` 需结合目标分支包含结果判定，不能单看状态 |
| 2 | GitHub 合并时间 | 读取 `merged_at`；历史路径无该值时明确记录缺失及远程提交时间，不伪造时间 |
| 3 | 合并提交 SHA | 读取 `merge_commit_sha` 与合并 API 响应的 `sha`；可能缺失时从 main 的实际提交定位并注明取证方式 |
| 4 | 目标分支包含合并结果 | 回读 `GET /repos/{owner}/{repo}/git/ref/heads/main`，检查合并结果提交的祖先关系或 squash 后的实际 diff/tree；不以原 Head 是否为祖先替代内容验证 |
| 5 | 远程 main 已更新 | 对照合并前后 `main` ref SHA 和结果提交；未变化或结果缺失则标为异常，不能宣称已合入 |
| 6 | 新的 CI 结果 | 查 `GET /repos/{owner}/{repo}/actions/runs?branch=main` 与结果 SHA 的 `check-runs` / `status`，记录是否有新运行、结论与 URL；自动触发停用时写“未触发”，不写“通过” |
| 7 | 合并后异常 | 检查 PR、合并 API 响应、主分支提交、CI 失败或状态不一致；报告可定位的异常并停止继续写操作 |
| 8 | 本地仓库是否需要同步 | 在获准且网络可用时 `git fetch origin main`，比较 `git rev-parse HEAD`、`git rev-parse origin/main` 和 `git rev-list --left-right --count HEAD...origin/main`；不能 fetch 则说明本地远程跟踪信息可能过期 |
| 9 | 未提交文件或意外修改 | `git status --short`，必要时只读 `git diff --stat`；记录现存修改与新出现的异常，不覆盖、不清理 |

本地同步失败时不得直接覆盖本地修改。先报告 `HEAD`、`origin/main`、远程 main 的实际 SHA、ahead/behind、未提交文件，以及失败原因；若 `fetch` 失败，不能把旧 `origin/main` 视为最新。安全路径是：先只读 `git fetch origin main` + 对比并暂不改工作树；让用户决定在保留现有修改前提下采用独立工作树/分支查看远程（额外磁盘占用）、提交当前工作到专用分支后再 merge/rebase（新增提交并可能冲突）、或经用户明确许可先 stash 再同步并恢复（暂存记录和恢复冲突风险）。任何写入式同步都要先确认工作树和用户选择，不把 `reset --hard` 或覆盖本地文件作为常规方案。

## 来源分支与文档衔接

不得自动删除 PR 来源分支，除非用户明确要求；本仓库 `delete_branch_on_merge: false` 与此默认一致。合并授权及有效范围见[审批与授权策略](./approval-policy.md)，Critical/High 的解决标准见[审查清单](./review-checklist.md)，独立审查分工见[Sub-agent 调度策略](./subagent-policy.md)，总流程入口见[SKILL.md](../SKILL.md)。
