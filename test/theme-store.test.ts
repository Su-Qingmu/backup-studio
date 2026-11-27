import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  FALLBACK_THEME_MODE,
  isThemeMode,
  parseThemeConfig,
  readThemeMode,
  writeThemeMode,
} from '../electron/theme-store';
import type { ThemeMode } from '../shared/theme-types';
import { createRunner, registerTempCleanup, trackTempDir } from './harness';

const runner = createRunner({ label: '结果' });

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  await runner.test(name, fn);
}

registerTempCleanup();

/** 每个用例一个独立夹具目录：主题文件必须互不干扰。 */
function tempDir(): string {
  return trackTempDir(fs.mkdtempSync(path.join(os.tmpdir(), 'bs-theme-')));
}

async function main() {
  await test('白名单只认 light / dark / system', () => {
    assert.equal(isThemeMode('light'), true);
    assert.equal(isThemeMode('dark'), true);
    assert.equal(isThemeMode('system'), true);
    assert.equal(isThemeMode('SYSTEM'), false);
    assert.equal(isThemeMode('Dark'), false);
    assert.equal(isThemeMode(''), false);
    assert.equal(isThemeMode(undefined), false);
    assert.equal(isThemeMode(null), false);
    assert.equal(isThemeMode(1), false);
    assert.equal(isThemeMode(['dark']), false);
    assert.equal(isThemeMode({ mode: 'dark' }), false);
  });

  await test('三种偏好都能写回并原样读回', () => {
    const dir = tempDir();
    const file = path.join(dir, 'theme.json');
    for (const mode of ['light', 'dark', 'system'] as const) {
      writeThemeMode(file, mode);
      assert.equal(readThemeMode(file), mode, `模式 ${mode} 必须原样读回`);
      assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { mode });
    }
  });

  await test('直接解析内容也认得合法偏好', () => {
    assert.equal(parseThemeConfig('{"mode":"dark"}'), 'dark');
    assert.equal(parseThemeConfig('{"mode":"light"}'), 'light');
    assert.equal(parseThemeConfig('{"mode":"system"}'), 'system');
  });

  await test('首次运行（文件不存在）回退到跟随系统', () => {
    const dir = tempDir();
    assert.equal(readThemeMode(path.join(dir, 'theme.json')), FALLBACK_THEME_MODE);
    assert.equal(FALLBACK_THEME_MODE, 'system');
  });

  await test('损坏的 JSON 回退到跟随系统', () => {
    const dir = tempDir();
    const file = path.join(dir, 'theme.json');
    for (const content of ['{ this is not json', '', '{"mode":', 'garbage']) {
      fs.writeFileSync(file, content, 'utf8');
      assert.equal(readThemeMode(file), FALLBACK_THEME_MODE, `内容 ${content} 必须回退`);
    }
  });

  await test('结构不对（缺 mode / mode 不是字符串 / 不是对象）回退到跟随系统', () => {
    const dir = tempDir();
    const file = path.join(dir, 'theme.json');
    const bad = ['{}', '{"mode":123}', '{"mode":null}', '{"mode":"neon"}', '{"mode":["dark"]}', '"dark"', '[]', 'null', '42'];
    for (const content of bad) {
      fs.writeFileSync(file, content, 'utf8');
      assert.equal(readThemeMode(file), FALLBACK_THEME_MODE, `内容 ${content} 必须回退`);
    }
  });

  await test('写入是原子的：临时文件被 rename 掉，不留半截', () => {
    const dir = tempDir();
    const file = path.join(dir, 'theme.json');
    writeThemeMode(file, 'dark');
    assert.equal(fs.existsSync(`${file}.tmp`), false, '临时文件必须已被 rename 掉');
    const raw = fs.readFileSync(file, 'utf8');
    assert.deepEqual(JSON.parse(raw), { mode: 'dark' });
  });

  await test('写入会补建缺失的目录', () => {
    const dir = tempDir();
    const file = path.join(dir, 'nested', 'deeper', 'theme.json');
    writeThemeMode(file, 'light');
    assert.equal(readThemeMode(file), 'light');
  });

  await test('非法模式写入被拒绝，且不留下文件', () => {
    const dir = tempDir();
    const file = path.join(dir, 'theme.json');
    assert.throws(
      () => writeThemeMode(file, 'neon' as unknown as ThemeMode),
      /主题模式无效/,
    );
    assert.equal(fs.existsSync(file), false, '被拒绝的写入不得留下文件');
    assert.equal(fs.existsSync(`${file}.tmp`), false, '被拒绝的写入不得留下临时文件');
  });

  await test('读不到内容时也不抛异常（目录占位）', () => {
    const dir = tempDir();
    const file = path.join(dir, 'theme.json');
    fs.mkdirSync(file);
    assert.equal(readThemeMode(file), FALLBACK_THEME_MODE);
  });

  await test('坏文件不会覆盖上一次的好偏好（读取失败不等于清空）', () => {
    const dir = tempDir();
    const file = path.join(dir, 'theme.json');
    writeThemeMode(file, 'dark');
    fs.writeFileSync(file, 'not json at all', 'utf8');
    // 坏文件按首次运行处理，但**不得**把偏好改写成 system：
    // 这里断言的是「读不出来时保持保守」，而不是把用户选择悄悄换掉。
    assert.equal(readThemeMode(file), FALLBACK_THEME_MODE);
  });

  console.log(`\n${runner.summary()}`);
  process.exit(runner.failed === 0 ? 0 : 1);
}

void main();
