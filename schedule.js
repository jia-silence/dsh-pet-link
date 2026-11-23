/**
 * 健康提醒的钟点网格：每小时 :00 和 :40 各一次，全天一致。
 *
 * 纯函数、无副作用，可以单独跑自检：
 *   node schedule.js
 */

import { pathToFileURL } from 'node:url';

/** 每小时真正触发的那两分钟。 */
export const SLOT_MINUTES = [0, 40];

/** 段落说明，给状态信息用。 */
export const GRID_TEXT = '每小时 :00 / :40';

/** 三段：0–7 半夜、8–19 白天、20–23 夜间。分钟都是「当天第几分钟」。 */
export const SEGMENTS = [
  { key: 'late', pool: 'late', startMin: 0, endMin: 8 * 60, label: '半夜 00:00–07:59' },
  { key: 'day', pool: 'day', startMin: 8 * 60, endMin: 20 * 60, label: '白天 08:00–19:59' },
  { key: 'night', pool: 'night', startMin: 20 * 60, endMin: 24 * 60, label: '夜间 20:00–23:59' },
];

const MINUTE = 60_000;

/** 当天第几分钟（Date 已经按本地时区算好小时）。 */
function minuteOfDay(ms) {
  const d = new Date(ms);
  return d.getHours() * 60 + d.getMinutes();
}

/** 这个时刻属于哪一段。 */
export function segmentFor(nowMs) {
  const m = minuteOfDay(nowMs);
  return SEGMENTS.find((s) => m >= s.startMin && m < s.endMin) ?? SEGMENTS[SEGMENTS.length - 1];
}

/** 这个时刻该说哪一池的话。 */
export function poolFor(nowMs) {
  return segmentFor(nowMs).pool;
}

/** 段落标签，给状态信息用。 */
export function segmentLabel(nowMs) {
  return segmentFor(nowMs).label;
}

/**
 * 严格晚于 now 的下一个网格点（:00 或 :40）。
 * 23:40 → 次日 00:00；08:39:59 → 08:40；08:40 整 → 09:00。
 */
export function nextSlot(nowMs) {
  const d = new Date(nowMs);
  d.setSeconds(0, 0);
  const base = d.getTime();
  if (d.getMinutes() < 40) return base + (40 - d.getMinutes()) * MINUTE;
  const nextHour = new Date(base);
  nextHour.setMinutes(0, 0, 0);
  nextHour.setHours(nextHour.getHours() + 1);
  return nextHour.getTime();
}

/** 自检：边界、换池、一整天正好 48 个点。 */
export function selfTest() {
  const errors = [];
  const ok = (cond, msg) => {
    if (!cond) errors.push(msg);
  };
  const at = (h, m, s = 0) => new Date(2026, 10, 23, h, m, s, 0).getTime();

  ok(nextSlot(at(23, 40)) === at(24, 0), '23:40 → 次日 00:00');
  ok(nextSlot(at(23, 39, 59)) === at(23, 40), '23:39:59 → 23:40');
  ok(nextSlot(at(19, 40)) === at(20, 0), '19:40 → 20:00');
  ok(nextSlot(at(7, 40)) === at(8, 0), '07:40 → 08:00');
  ok(nextSlot(at(8, 0)) === at(8, 40), '08:00 → 08:40');
  ok(nextSlot(at(8, 40)) === at(9, 0), '08:40 → 09:00');

  ok(poolFor(at(7, 59)) === 'late', '07:59 属于半夜池');
  ok(poolFor(at(8, 0)) === 'day', '08:00 属于白天池');
  ok(poolFor(at(19, 59)) === 'day', '19:59 属于白天池');
  ok(poolFor(at(20, 0)) === 'night', '20:00 属于夜间池');
  ok(poolFor(at(23, 59)) === 'night', '23:59 属于夜间池');
  ok(poolFor(at(0, 0)) === 'late', '00:00 属于半夜池');

  // 从当天 00:00 起逐格走：00:00 之后到 23:40 应当正好 47 个点，全天 48 个。
  let t = at(0, 0);
  const day = [];
  while (day.length < 60) {
    t = nextSlot(t);
    const d = new Date(t);
    if (d.getDate() !== 23) break;
    day.push(d);
    ok(SLOT_MINUTES.includes(d.getMinutes()), `网格点分钟不是 :00/:40 → ${d.toLocaleString('zh-CN')}`);
  }
  ok(day.length === 47, `00:00 之后到当天结束应有 47 个点，实际 ${day.length}`);

  return { ok: errors.length === 0, pointsAfterMidnight: day.length, totalPerDay: day.length + 1, errors };
}

// 直接 `node schedule.js` 时跑自检；被 import 时什么也不做。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = selfTest();
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.ok ? 0 : 1;
}
