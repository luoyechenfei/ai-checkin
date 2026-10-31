'use strict';

/**
 * 按指定时区格式化给定时间，返回 'YYYY-MM-DD HH:MM:SS'
 * 使用 Intl 保证不受容器 TZ 环境变量影响
 */
function zonedFormat(tz, d) {
  const fmt = new Intl.DateTimeFormat('sv-SE', {
    timeZone: tz || 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false
  });
  return fmt.format(d); // 'sv-SE' 本地格式恰好是 YYYY-MM-DD HH:MM:SS
}

/** 当前时间的 zonedFormat 便捷封装 */
function zonedNow(tz) {
  return zonedFormat(tz, new Date());
}

function isValidTimezone(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch (e) {
    return false;
  }
}

/** 计算从 nowStr(YYYY-MM-DD HH:MM:SS) 到 expiresStr 的剩余整天天数 */
function daysLeft(nowStr, expiresStr) {
  const t1 = new Date(nowStr.replace(' ', 'T') + 'Z').getTime();
  const t2 = new Date(expiresStr.replace(' ', 'T') + 'Z').getTime();
  return Math.ceil((t2 - t1) / 86400000);
}

/** 校验 HH:MM 格式 */
function isValidHHMM(s) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(s || '');
}

module.exports = { zonedFormat, zonedNow, isValidTimezone, daysLeft, isValidHHMM };
