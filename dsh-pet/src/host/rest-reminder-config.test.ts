/**
 * 休息提醒配置层的单元测试：钉住内置默认（关闭 / 25 分钟）、用户层覆盖、非法值回退，
 * 以及设置页保存（PUT /config 的 saveUserConfig）对开关 / 间隔的校验与归一化。
 *
 * 走完整的 readAllConfig 管线（与生产同一条路径），临时目录隔离真实文件；
 * 跑法：node --experimental-strip-types --test src/host/rest-reminder-config.test.ts
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { readAllConfig, saveUserConfig, type ConfigPaths } from './config.ts';

const PET = {
  id: 'main',
  name: '主宠',
  size: 462,
  balanceEnabled: false,
  display: 'web',
  position: { corner: 'top-right', marginX: 24, marginY: 100 },
};

/** 内置默认的最小形态：只保留休息提醒与一只宠物（读取管线不校验 base，和真实 assets 同一语义）。 */
const BASE = {
  restReminderEnabled: false,
  restReminderIntervalMin: 25,
  pets: [PET],
};

/** 一套临时配置路径；调用方负责 cleanup。 */
function pathsInTemp(): { paths: ConfigPaths; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-pet-rest-reminder-'));
  const paths: ConfigPaths = {
    defaultFile: join(dir, 'default.jsonc'),
    userFile: join(dir, 'main-config.jsonc'),
    petDir: join(dir, 'pet'),
  };
  writeFileSync(paths.defaultFile, JSON.stringify(BASE));
  return { paths, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('新安装 / 用户层没写：默认关闭，间隔 25 分钟', () => {
  const { paths, cleanup } = pathsInTemp();
  try {
    const merged = readAllConfig(paths);
    assert.equal(merged.main.restReminderEnabled, false);
    assert.equal(merged.main.restReminderIntervalMin, 25);
  } finally {
    cleanup();
  }
});

test('用户层写合法开关 / 间隔：原样生效（0.5 分钟 = 30 秒也合法）', () => {
  const { paths, cleanup } = pathsInTemp();
  try {
    writeFileSync(
      paths.userFile,
      JSON.stringify({ restReminderEnabled: true, restReminderIntervalMin: 0.5, pets: [PET] }),
    );
    const merged = readAllConfig(paths);
    assert.equal(merged.main.restReminderEnabled, true);
    assert.equal(merged.main.restReminderIntervalMin, 0.5);
  } finally {
    cleanup();
  }
});

test('用户层写非法开关 / 间隔：回退内置默认，不让 0 / 负数 / 字符串进运行时', () => {
  const { paths, cleanup } = pathsInTemp();
  try {
    writeFileSync(
      paths.userFile,
      JSON.stringify({ restReminderEnabled: 'yes', restReminderIntervalMin: 0, pets: [PET] }),
    );
    let merged = readAllConfig(paths);
    assert.equal(merged.main.restReminderEnabled, false);
    assert.equal(merged.main.restReminderIntervalMin, 25);

    writeFileSync(
      paths.userFile,
      JSON.stringify({ restReminderEnabled: true, restReminderIntervalMin: -5, pets: [PET] }),
    );
    merged = readAllConfig(paths);
    assert.equal(merged.main.restReminderEnabled, true);
    assert.equal(merged.main.restReminderIntervalMin, 25, '负间隔回退默认 25，不回退开关');
  } finally {
    cleanup();
  }
});

test('保存：布尔开关 + 正数间隔写入白名单，数字字符串归一化为 number', () => {
  const saved = saveUserConfig({
    pets: [PET],
    restReminderEnabled: true,
    restReminderIntervalMin: '30',
  });
  assert.ok(saved);
  assert.equal(saved.restReminderEnabled, true);
  assert.equal(saved.restReminderIntervalMin, 30);
  assert.equal(typeof saved.restReminderIntervalMin, 'number');

  const half = saveUserConfig({ pets: [PET], restReminderEnabled: true, restReminderIntervalMin: 0.5 });
  assert.ok(half);
  assert.equal(half.restReminderIntervalMin, 0.5);
});

test('保存：0 / 负数 / NaN / Infinity / 非数字串 / 非布尔开关一律整包拒绝（null）', () => {
  for (const bad of [0, -1, -0.5, Number.NaN, Number.POSITIVE_INFINITY, 'abc', '', null]) {
    assert.equal(saveUserConfig({ pets: [PET], restReminderIntervalMin: bad }), null, `间隔 ${String(bad)} 必须被拒`);
  }
  for (const bad of ['true', 1, 0, null]) {
    assert.equal(saveUserConfig({ pets: [PET], restReminderEnabled: bad }), null, `开关 ${String(bad)} 必须被拒`);
  }
});

test('保存：未传休息提醒字段时走 existing 透传，不凭空造值也不抹掉用户手写值', () => {
  const existing = {
    restReminderEnabled: true,
    restReminderIntervalMin: 40,
    memes: { 用户图: '用户描述' },
  };
  const saved = saveUserConfig({ pets: [PET] }, existing);
  assert.ok(saved);
  assert.equal(saved.restReminderEnabled, true);
  assert.equal(saved.restReminderIntervalMin, 40);
  assert.deepEqual(saved.memes, { 用户图: '用户描述' });

  const fresh = saveUserConfig({ pets: [PET] });
  assert.ok(fresh);
  assert.equal('restReminderEnabled' in fresh, false, '没传就不写该字段，读取侧用内置默认');
  assert.equal('restReminderIntervalMin' in fresh, false);
});

test('保存 → 落盘 → readAllConfig：开关与间隔完整往返', () => {
  const { paths, cleanup } = pathsInTemp();
  try {
    const saved = saveUserConfig({ pets: [PET], restReminderEnabled: true, restReminderIntervalMin: 0.5 });
    assert.ok(saved);
    mkdirSync(join(paths.userFile, '..'), { recursive: true });
    writeFileSync(paths.userFile, JSON.stringify(saved));
    assert.equal(existsSync(paths.userFile), true);

    const merged = readAllConfig(paths);
    assert.equal(merged.main.restReminderEnabled, true);
    assert.equal(merged.main.restReminderIntervalMin, 0.5);
  } finally {
    cleanup();
  }
});
