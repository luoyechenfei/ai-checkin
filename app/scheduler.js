'use strict';
/**
 * 定时调度器：
 * 1. 每日定时签到：按每个账号设置的 checkin_time 执行（轮询比对，天然支持动态增删改）
 * 2. 授权到期登出：授权满 7 天自动登出（清除凭据）并发送通知提示重新授权
 * 3. 每日清理过期 Web 登录会话
 */
const config = require('./config');
const { db, getSetting, getNow, notify } = require('./db');
const { purgeExpiredSessions } = require('./security');
const { runCheckin } = require('./platforms');

let timer = null;
let lastSweepDay = null;

function tick() {
  try {
    const now = getNow();                 // 'YYYY-MM-DD HH:MM:SS'（按设置的时区）
    const today = now.slice(0, 10);
    const hhmm = now.slice(11, 16);

    // 1) 平台授权到期 → 自动登出并提示
    const expired = db.prepare(`
      SELECT * FROM accounts
      WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at <= ?`).all(now);
    for (const acc of expired) {
      db.prepare(`UPDATE accounts SET status = 'expired', credentials = '{}' WHERE id = ?`).run(acc.id);
      notify(acc.user_id, 'session_expired',
        `「${acc.name}」授权到期，已自动登出`,
        `该平台授权已保持满 7 天，系统已自动登出并清除本地凭据。如需继续签到，请前往「平台账号」重新授权。`);
    }

    // 2) 每日定时签到（成功后当天不再执行；失败按冷却时间自动重试）
    const accounts = db.prepare(`SELECT * FROM accounts WHERE status = 'active'`).all();
    const todayStart = today + ' 00:00:00';
    const nowMs = Date.parse(now.replace(' ', 'T') + 'Z');
    for (const acc of accounts) {
      const t = acc.checkin_time || '08:00';
      if (hhmm < t) continue;
      const last = db.prepare(
        `SELECT success, created_at FROM logs WHERE account_id = ? AND created_at >= ? ORDER BY id DESC LIMIT 1`
      ).get(acc.id, todayStart);
      if (last && last.success === 1) continue;
      if (last) {
        const lastMs = Date.parse(last.created_at.replace(' ', 'T') + 'Z');
        if (nowMs - lastMs < config.RETRY_MINUTES * 60000) continue;
      }
      runCheckin(acc, 'scheduled').catch(err => console.error('[scheduler] 签到异常:', err.message));
    }

    // 3) 每日清理过期 Web 会话
    if (lastSweepDay !== today) {
      lastSweepDay = today;
      purgeExpiredSessions();
    }
  } catch (err) {
    console.error('[scheduler] tick error:', err.message);
  }
}

function start() {
  timer = setInterval(tick, config.TICK_SECONDS * 1000);
  setTimeout(tick, 1500); // 启动即执行一次，处理停机期间到期的授权/漏签
  console.log(`[scheduler] 已启动，每 ${config.TICK_SECONDS}s 轮询一次`);
}

function stop() {
  if (timer) clearInterval(timer);
}

module.exports = { start, stop };
