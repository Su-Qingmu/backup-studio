#!/usr/bin/env node
/**
 * Backup Studio — GitHub REST API helper.
 *
 * 本脚本是「本机未安装 `gh` CLI」时的回退路径（装有 `gh` 时优先用 `gh`，见 SKILL.md 0.2）。
 * 它封装了本机
 * 实测可用的调用方式：
 *
 *   * 凭据：Git Credential Manager（`git credential-manager get`），主账号 Su-Qingmu。
 *     凭据只在进程内使用，**不会**打印到 stdout / 报告 / 日志。
 *   * TLS：Node 自带 OpenSSL，不受 Windows schannel 吊销检查
 *     （CRYPT_E_NO_REVOCATION_CHECK）影响，无需额外参数。
 *   * 网络：系统代理 127.0.0.1:3067（Karing）可能处于关闭状态，Node fetch 不走系统代理；
 *     本机直连 api.github.com 可用。git push 的代理写法见 references/merge-policy.md。
 *
 * 用法：
 *   node scripts/gh-api.mjs get  <path> [--fields a,b] [--pretty]
 *   node scripts/gh-api.mjs post <path> --body '<json>'
 *
 * 示例：
 *   node scripts/gh-api.mjs get repos/Su-Qingmu/backup-studio/pulls/16
 *   node scripts/gh-api.mjs get repos/Su-Qingmu/backup-studio/pulls/16 --fields state,merged
 *   node scripts/gh-api.mjs post repos/Su-Qingmu/backup-studio/pulls/16/reviews \
 *        --body '{"event":"COMMENT","body":"..."}'
 *
 * <path> 可写相对仓库的 API 路径（不含前导斜杠），也可写完整 URL。
 *
 * 退出码：0 成功；2 凭据不可用；3 网络失败；4 GitHub 返回错误状态码；5 参数错误。
 */

import { execFileSync } from 'node:child_process';

const EXIT_OK = 0;
const EXIT_NO_CREDENTIAL = 2;
const EXIT_NETWORK = 3;
const EXIT_HTTP = 4;
const EXIT_USAGE = 5;

/** 从 Git Credential Manager 取 GitHub token；失败返回 null（绝不打印凭据值）。 */
function readToken() {
  try {
    const out = execFileSync('git', ['credential-manager', 'get'], {
      input: 'protocol=https\nhost=github.com\n\n',
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const match = out.match(/password=(.+)/);
    const token = match ? match[1].trim() : '';
    return token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

/**
 * 释放 undici 的 keep-alive 连接，避免进程退出阶段残留句柄。
 * 注意：不要用 process.exit() 强制结束——Node 24 在 Windows 上于显式退出、
 * 且仍有 async handle 存活时会触发 `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`。
 */
async function closeHttp() {
  try {
    const sym = Object.getOwnPropertySymbols(globalThis).find(
      (s) => s.description === 'undici.globalDispatcher.1'
    );
    if (sym) await globalThis[sym].close();
  } catch {
    /* 关闭失败不影响本次请求结果 */
  }
}

async function main() {
  const argv = process.argv.slice(2);

  if (argv.length === 0 || argv[0] === '-h' || argv[0] === '--help') {
    console.log(
      'Usage: node gh-api.mjs <get|post|put|patch|delete> <path> [--fields a,b] [--pretty] [--body <json>]'
    );
    return argv.length === 0 ? EXIT_USAGE : EXIT_OK;
  }

  const [methodRaw, pathArg, ...rest] = argv;
  const method = methodRaw.toLowerCase();
  if (!['get', 'post', 'put', 'patch', 'delete'].includes(method)) {
    console.error(`[gh-api] 不支持的 method: ${methodRaw}`);
    return EXIT_USAGE;
  }
  if (!pathArg) {
    console.error('[gh-api] 缺少 <path> 参数');
    return EXIT_USAGE;
  }

  let fields = '';
  let body = null;
  let pretty = false;
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === '--fields') {
      fields = rest[i + 1] ?? '';
      i += 1;
    } else if (arg === '--pretty') {
      pretty = true;
    } else if (arg === '--body') {
      body = rest[i + 1] ?? null;
      i += 1;
    } else if (arg.startsWith('--fields=')) {
      fields = arg.slice('--fields='.length);
    } else if (arg.startsWith('--body=')) {
      body = arg.slice('--body='.length);
    } else {
      console.error(`[gh-api] 未知参数: ${arg}`);
      return EXIT_USAGE;
    }
  }

  const token = readToken();
  if (!token) {
    console.error('[gh-api] 无法从 Git Credential Manager 取得 GitHub 凭据，未发出任何请求。');
    console.error(
      '[gh-api] 请确认 `git credential-manager get` 可用（输入 protocol=https / host=github.com）。'
    );
    return EXIT_NO_CREDENTIAL;
  }

  const url = /^https?:\/\//.test(pathArg)
    ? pathArg
    : `https://api.github.com/${pathArg.replace(/^\/+/, '')}`;

  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'backup-studio-agent',
  };
  if (body !== null) headers['Content-Type'] = 'application/json';

  let response;
  try {
    response = await fetch(url, {
      method: method.toUpperCase(),
      headers,
      body: body === null ? undefined : body,
    });
  } catch (err) {
    console.error(`[gh-api] 网络请求失败：${err?.message ?? err}`);
    return EXIT_NETWORK;
  }

  const text = await response.text();

  if (!response.ok) {
    console.error(
      `[gh-api] GitHub 返回 HTTP ${response.status} ${response.statusText}。目标操作未完成。`
    );
    if (text) console.error(text);
    return EXIT_HTTP;
  }

  let payload = text;
  try {
    payload = JSON.parse(text);
  } catch {
    /* 非 JSON 响应按原样输出 */
  }

  if (fields) {
    for (const key of fields.split(',').map((s) => s.trim()).filter(Boolean)) {
      const value = key.includes('.')
        ? key.split('.').reduce((acc, part) => (acc == null ? acc : acc[part]), payload)
        : payload?.[key];
      console.log(
        `${key}=${
          value === undefined
            ? '<null>'
            : typeof value === 'object'
              ? JSON.stringify(value)
              : value
        }`
      );
    }
  } else if (pretty) {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    console.log(typeof payload === 'string' ? payload : JSON.stringify(payload));
  }

  return EXIT_OK;
}

process.exitCode = await main();
await closeHttp();
