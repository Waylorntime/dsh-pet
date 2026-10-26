/**
 * 休息提醒调度器的单元测试：钉住「开启计时 / 关闭立即停 / 改间隔重排 / 反复 rearm 不叠加 /
 * dispose 清理 / 到点写固定文案」这几条需求。用 node:test 的假时钟，不跑真实 25 分钟。
 *
 * 跑法：node --experimental-strip-types --test src/host/rest-reminder.test.ts
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createRestReminderScheduler,
  REST_REMINDER_TEXT,
  restReminderIntervalMs,
  restReminderIntervalValid,
  type RestReminderSnapshot,
} from './rest-reminder.ts';

const MIN = 60_000;

/** 造一份可变的配置快照；测试里直接改字段模拟「设置页保存」。 */
function snapshot(): RestReminderSnapshot {
  return { enabled: true, intervalMin: 25, petIds: ['main'] };
}

test('固定文案与间隔换算：0.5 分钟 = 30 秒，非法值被拒', () => {
  assert.equal(REST_REMINDER_TEXT, '起来活动一下');
  assert.equal(restReminderIntervalMs(25), 25 * MIN);
  assert.equal(restReminderIntervalMs(0.5), 30_000);
  // 下限 1 秒：防止极小值把定时器变成忙循环
  assert.equal(restReminderIntervalMs(0.0001), 1000);
  for (const bad of [0, -1, -0.5, Number.NaN, Number.POSITIVE_INFINITY, null, undefined, 'abc']) {
    assert.equal(restReminderIntervalValid(bad), false, String(bad));
  }
  for (const ok of [25, 0.5, '30', 0.001]) {
    assert.equal(restReminderIntervalValid(ok), true, String(ok));
  }
});

test('开启后到点提醒一次，并按同一间隔继续；不会提前触发', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const said: Array<[string, string]> = [];
  const source = snapshot();
  const scheduler = createRestReminderScheduler({
    readSnapshot: () => source,
    say: (petId, text) => said.push([petId, text]),
  });
  scheduler.rearm();
  assert.equal(scheduler.isArmed(), true);

  t.mock.timers.tick(25 * MIN - 1);
  assert.deepEqual(said, [], '提前 1ms 不得触发');
  t.mock.timers.tick(1);
  assert.deepEqual(said, [['main', REST_REMINDER_TEXT]], '到点恰好触发一次，文案固定');

  t.mock.timers.tick(25 * MIN - 1);
  assert.equal(said.length, 1, '第二拍同样不得提前');
  t.mock.timers.tick(1);
  assert.equal(said.length, 2, '触发后自动按同一间隔排下一拍');
  scheduler.dispose();
  t.mock.timers.reset();
});

test('反复 rearm（反复保存配置）永远只有一个定时器', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const said: string[] = [];
  const source = snapshot();
  const scheduler = createRestReminderScheduler({
    readSnapshot: () => source,
    say: (petId) => said.push(petId),
  });
  for (let i = 0; i < 8; i += 1) scheduler.rearm();
  assert.equal(scheduler.isArmed(), true);

  t.mock.timers.tick(25 * MIN);
  assert.equal(said.length, 1, '8 次 rearm 只能留下一个定时器；若叠加会一次串出 8 条');
  t.mock.timers.tick(25 * MIN);
  assert.equal(said.length, 2);
  scheduler.dispose();
  t.mock.timers.reset();
});

test('同一间隔的再次保存不重置倒计时（只改别的设置不影响休息提醒）', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const said: string[] = [];
  const source = snapshot();
  const scheduler = createRestReminderScheduler({
    readSnapshot: () => source,
    say: (petId) => said.push(petId),
  });
  scheduler.rearm();
  t.mock.timers.tick(20 * MIN);
  // 只改了别的全局开关：休息提醒字段原样提交，间隔没变 → 保留已走过的 20 分钟。
  source.intervalMin = 25;
  scheduler.rearm();
  t.mock.timers.tick(5 * MIN - 1);
  assert.equal(said.length, 0, '同一间隔的保存不得把倒计时重置回 25 分钟');
  t.mock.timers.tick(1);
  assert.equal(said.length, 1, '仍应按原定时刻触发');
  scheduler.dispose();
  t.mock.timers.reset();
});

test('关闭立即停止计时，之后经过完整间隔也不再提醒', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const said: string[] = [];
  const source = snapshot();
  const scheduler = createRestReminderScheduler({
    readSnapshot: () => source,
    say: (petId) => said.push(petId),
  });
  scheduler.rearm();
  t.mock.timers.tick(10 * MIN);
  assert.equal(said.length, 0);

  source.enabled = false;
  scheduler.rearm();
  assert.equal(scheduler.isArmed(), false, '关闭后不得留下定时器');
  t.mock.timers.tick(100 * MIN);
  assert.deepEqual(said, [], '关闭后不得补发任何提醒');
  scheduler.dispose();
  t.mock.timers.reset();
});

test('开启状态下改间隔：清旧计时器，从新间隔完整重新计时', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const said: string[] = [];
  const source = snapshot();
  const scheduler = createRestReminderScheduler({
    readSnapshot: () => source,
    say: (petId) => said.push(petId),
  });
  scheduler.rearm();
  t.mock.timers.tick(10 * MIN);

  // 改 0.5 分钟（30 秒）并保存：旧定时器必须被清掉，新间隔从此刻完整起算。
  source.intervalMin = 0.5;
  scheduler.rearm();
  t.mock.timers.tick(30_000 - 1);
  assert.equal(said.length, 0, '旧 25 分钟计时器必须已被清掉');
  t.mock.timers.tick(1);
  assert.equal(said.length, 1, '按新间隔 30 秒触发');
  t.mock.timers.tick(30_000);
  assert.equal(said.length, 2, '后续继续按新间隔');
  scheduler.dispose();
  t.mock.timers.reset();
});

test('重启 / 重新初始化：从完整间隔重新计时，不补发未运行期间', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const said: string[] = [];
  const source = snapshot();
  const first = createRestReminderScheduler({ readSnapshot: () => source, say: (petId) => said.push(petId) });
  first.rearm();
  t.mock.timers.tick(20 * MIN);
  // 模拟进程重启：旧实例被销毁，新实例启动时配置仍为开启。
  first.dispose();
  const restarted = createRestReminderScheduler({ readSnapshot: () => source, say: (petId) => said.push(petId) });
  restarted.rearm();
  t.mock.timers.tick(25 * MIN - 1);
  assert.deepEqual(said, [], '重启后必须重新等满一个完整间隔（不追赶重启前已过的 20 分钟）');
  t.mock.timers.tick(1);
  assert.equal(said.length, 1);
  restarted.dispose();
  t.mock.timers.reset();
});

test('dispose 清理定时器，之后不再触发', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const said: string[] = [];
  const source = snapshot();
  const scheduler = createRestReminderScheduler({
    readSnapshot: () => source,
    say: (petId) => said.push(petId),
  });
  scheduler.rearm();
  scheduler.dispose();
  assert.equal(scheduler.isArmed(), false);
  t.mock.timers.tick(100 * MIN);
  assert.deepEqual(said, []);
  // dispose 后再调用 rearm 也不得复活：插件卸载后不应再有计时器。
  scheduler.rearm();
  assert.equal(scheduler.isArmed(), false);
  t.mock.timers.tick(100 * MIN);
  assert.deepEqual(said, []);
  t.mock.timers.reset();
});

test('间隔非法 / 没有宠物时不建计时器', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const said: string[] = [];
  const bad: RestReminderSnapshot = { enabled: true, intervalMin: 0, petIds: ['main'] };
  const scheduler = createRestReminderScheduler({ readSnapshot: () => bad, say: (petId) => said.push(petId) });
  scheduler.rearm();
  assert.equal(scheduler.isArmed(), false, '0 分钟不得起计时器');
  t.mock.timers.tick(100 * MIN);
  assert.equal(said.length, 0);

  const empty: RestReminderSnapshot = { enabled: true, intervalMin: 25, petIds: [] };
  const emptyScheduler = createRestReminderScheduler({
    readSnapshot: () => empty,
    say: (petId) => said.push(petId),
  });
  emptyScheduler.rearm();
  assert.equal(emptyScheduler.isArmed(), false, '没有宠物时不起计时器');
  emptyScheduler.dispose();
  scheduler.dispose();
  t.mock.timers.reset();
});

test('到点前手改配置关闭：拍内复核后停止，不再排下一拍', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const said: string[] = [];
  const source = snapshot();
  const scheduler = createRestReminderScheduler({
    readSnapshot: () => source,
    say: (petId) => said.push(petId),
  });
  scheduler.rearm();
  t.mock.timers.tick(24 * MIN);
  // 模拟用户直接改 main-config.jsonc 但没有走保存：rearm 没被调用，到点这一拍自己复核。
  source.enabled = false;
  t.mock.timers.tick(MIN);
  assert.deepEqual(said, []);
  assert.equal(scheduler.isArmed(), false, '关闭后不得再排下一拍');
  scheduler.dispose();
  t.mock.timers.reset();
});

test('多只宠物同一拍各弹一次；单只写失败不影响其它宠物与后续计时', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const said: string[] = [];
  const source: RestReminderSnapshot = { enabled: true, intervalMin: 25, petIds: ['main', 'pet-2', 'pet-3'] };
  const scheduler = createRestReminderScheduler({
    readSnapshot: () => source,
    say: (petId) => {
      if (petId === 'pet-2') throw new Error('write failed');
      said.push(petId);
    },
  });
  scheduler.rearm();
  t.mock.timers.tick(25 * MIN);
  assert.deepEqual(said, ['main', 'pet-3']);
  assert.equal(scheduler.isArmed(), true, '单只写失败也必须继续计时');
  t.mock.timers.tick(25 * MIN);
  assert.deepEqual(said, ['main', 'pet-3', 'main', 'pet-3']);
  scheduler.dispose();
  t.mock.timers.reset();
});
