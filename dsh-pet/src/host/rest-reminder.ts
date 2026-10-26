/**
 * 休息提醒调度（宿主半侧）：按配置的固定间隔，用现有说话叶子 `pets.<id>.say` 弹一句固定文字。
 *
 * 为什么放宿主半侧而不是渲染端：桌面端与浏览器端可能同时显示同一只宠物，两端各自计时会在
 * 相近但不同的时刻各弹一次；宿主只有一个计时器，写一份状态，两端读到的时刻与内容天然一致。
 * 也正因为只有一个计时器，反复保存配置 / 反复开关不会叠加定时器。
 *
 * 计时语义（与需求逐条对应）：
 * - 关闭 = 不建定时器（rearm 时清掉旧的，不补发关闭期间的提醒）；
 * - 开启 = 从当前时刻起算完整间隔（首次 rearm 与重启后都是完整一拍，不追赶历史）；
 * - 改间隔 = 由调用方 rearm：先清旧定时器，再按新间隔重排，绝不并行；
 * - 销毁 = dispose 清掉唯一的定时器。
 *
 * 拍内重新读一次配置：手改 main-config.jsonc 后即使没有触发保存，也能在下一拍发现「已关闭 /
 * 间隔已改」；读不到配置（安装损坏）则停止重排，留给下一次保存或重启恢复，绝不空转刷日志。
 *
 * @module dsh-pet/src/host/rest-reminder
 */

/** 提醒气泡的固定文案（需求指定，不要加标点或改写）。 */
export const REST_REMINDER_TEXT = '起来活动一下';

/** 间隔下限（毫秒）：防止误配极小值变成忙循环，也让测试间隔稳定在可观察的量级。 */
const MIN_INTERVAL_MS = 1000;

/** 一次调度所需的配置快照：全局开关 + 间隔 + 需要弹气泡的宠物 id。 */
export interface RestReminderSnapshot {
  /** 是否开启休息提醒。 */
  enabled: boolean;
  /** 提醒间隔（分钟，正数；UI 允许小数，0.5 = 30 秒）。 */
  intervalMin: number;
  /** 本次要提醒的宠物实例 id（配置里的全部宠物；display=none 的实例写了也不会有人看，但保持与配置一致）。 */
  petIds: string[];
}

/** 间隔是否合法：有限数字且严格大于 0（0 / 负数 / NaN / Infinity / 非数字字符串都非法）。 */
export function restReminderIntervalValid(value: unknown): boolean {
  const minutes = Number(value);
  return Number.isFinite(minutes) && minutes > 0;
}

/** 分钟 → 毫秒；非法值不在这里兜底（调用方先校验），只做下限钳制。 */
export function restReminderIntervalMs(intervalMin: number): number {
  return Math.max(MIN_INTERVAL_MS, Math.round(intervalMin * 60_000));
}

/** 调度器对外句柄。 */
export interface RestReminderScheduler {
  /** 按最新配置校准：关闭 / 改间隔才清旧定时器并重排；同一间隔保留已走过的倒计时。
   *  可重复调用，永远只有一个定时器。 */
  rearm(): void;
  /** 插件卸载：清掉定时器并禁止后续再排。 */
  dispose(): void;
  /** 当前是否有一个待触发的定时器（排障与单测用）。 */
  isArmed(): boolean;
}

/** 制造休息提醒调度器。
 * @param options - `readSnapshot` 每拍读一份最新配置；`say` 把固定文案写给一只宠物；
 *   `log` 可选的日志出口（宿主传文件 logger，单测不传）。
 * @returns 可重排 / 可销毁的调度器；同一实例内计时器数量恒为 0 或 1。
 */
export function createRestReminderScheduler(options: {
  readSnapshot: () => RestReminderSnapshot;
  say: (petId: string, text: string) => void;
  log?: (message: string) => void;
}): RestReminderScheduler {
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** 当前定时器对应的间隔（ms）；与配置算出的间隔相同 = 不必重置，保留已走过的倒计时。 */
  let armedMs: number | null = null;
  let disposed = false;
  /** 同一句日志不重复刷：保存配置时 rearm 可能连续触发多次。 */
  let lastLog = '';

  const info = (message: string): void => {
    if (message === lastLog) return;
    lastLog = message;
    options.log?.(message);
  };

  const clear = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    armedMs = null;
  };

  const arm = (intervalMin: number): void => {
    const ms = restReminderIntervalMs(intervalMin);
    timer = setTimeout(fire, ms);
    armedMs = ms;
    // 定时器不参与「进程是否该退出」的判断：DSH 关闭时不该被休息提醒拖住。
    (timer as unknown as { unref?: () => void }).unref?.();
  };

  function fire(): void {
    timer = null;
    armedMs = null;
    if (disposed) return;
    let snapshot: RestReminderSnapshot;
    try {
      snapshot = options.readSnapshot();
    } catch (error) {
      // 读配置抛错 = 内置默认缺失 / 损坏：重排没有意义（每一拍都会失败），停在这里等下次保存或重启。
      options.log?.(
        '[dsh-pet] 休息提醒读配置失败，计时已停止（保存配置或重启 DSH 后恢复）：' +
          (error instanceof Error ? error.message : String(error)),
      );
      return;
    }
    // 拍内复核：用户可能手改了配置文件但没经过保存（rearm 不会被调用）。关闭或间隔非法就安静停下。
    if (!snapshot.enabled || !restReminderIntervalValid(snapshot.intervalMin)) return;
    for (const petId of snapshot.petIds) {
      if (!petId) continue;
      try {
        options.say(petId, REST_REMINDER_TEXT);
      } catch (error) {
        // 单只宠物写失败不拖累其它宠物，也不打断计时。
        options.log?.(
          `[dsh-pet] 休息提醒写入气泡失败 pet=${petId}：` + (error instanceof Error ? error.message : String(error)),
        );
      }
    }
    info(`[dsh-pet] 休息提醒到点：已提醒 ${snapshot.petIds.length} 只宠物「${REST_REMINDER_TEXT}」`);
    arm(snapshot.intervalMin);
  }

  const scheduler: RestReminderScheduler = {
    rearm(): void {
      if (disposed) return;
      let snapshot: RestReminderSnapshot;
      try {
        snapshot = options.readSnapshot();
      } catch (error) {
        // 读配置失败（安装损坏）时连旧定时器一起清掉：留着一个到点也读不到配置的定时器没有意义。
        clear();
        options.log?.(
          '[dsh-pet] 休息提醒读配置失败，未启动计时（保存配置或重启 DSH 后恢复）：' +
            (error instanceof Error ? error.message : String(error)),
        );
        return;
      }
      if (!snapshot.enabled) {
        clear();
        info('[dsh-pet] 休息提醒已关闭');
        return;
      }
      if (!restReminderIntervalValid(snapshot.intervalMin)) {
        clear();
        options.log?.(`[dsh-pet] 休息提醒间隔非法（${String(snapshot.intervalMin)} 分钟），未启动计时`);
        return;
      }
      if (snapshot.petIds.length === 0) {
        clear();
        info('[dsh-pet] 休息提醒已开启，但配置里没有宠物，未启动计时');
        return;
      }
      // 同一间隔的保存（例如只改了别的全局开关）不重置倒计时——只有开关状态或间隔真的变化才重排。
      const intervalMs = restReminderIntervalMs(snapshot.intervalMin);
      if (timer !== null && armedMs === intervalMs) return;
      clear();
      arm(snapshot.intervalMin);
      info(
        `[dsh-pet] 休息提醒已开启：间隔 ${snapshot.intervalMin} 分钟，` +
          `提醒 ${snapshot.petIds.length} 只宠物「${REST_REMINDER_TEXT}」`,
      );
    },
    dispose(): void {
      disposed = true;
      clear();
    },
    isArmed(): boolean {
      return timer !== null;
    },
  };

  return scheduler;
}
