'use strict';
/**
 * 平台适配器与签到引擎
 * - 内置平台：trae / workbuddy / codebuddy
 * - 通用平台：custom（任意平台，自行填写接口信息）
 *
 * 说明：各平台的签到接口可能随官方更新而变化。内置适配器均支持通过
 * “签到接口地址”字段覆盖默认值；也可直接使用“自定义平台”接入任意平台。
 */
const { db, notify, getNow } = require('./db');
const config = require('./config');
const { addDays } = require('./security');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

// ---------- 积分识别 ----------
/** 常见积分字段名（小写匹配） */
const POINT_KEYS = [
  'points', 'point', 'credit', 'credits', 'score', 'integral', 'integrals',
  'reward', 'rewards', 'coin', 'coins', 'balance', 'total_points', 'earned',
  '积分', '奖励'
];

function toNumber(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.round(v * 100) / 100;
  if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) {
    return Math.round(Number(v) * 100) / 100;
  }
  return null;
}

/** 按点分路径取值，如 data.points / result.reward.points */
function lookupPath(obj, path) {
  return String(path).split('.').reduce((cur, key) => (cur == null ? undefined : cur[key]), obj);
}

/** 在 JSON 中递归查找积分字段；优先常见字段名，最多 5 层 */
function findPoints(obj, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 5) return null;
  for (const key of Object.keys(obj)) {
    if (!POINT_KEYS.includes(key.toLowerCase())) continue;
    const direct = toNumber(obj[key]);
    if (direct !== null) return direct;
    if (obj[key] && typeof obj[key] === 'object') {
      const nested = findPoints(obj[key], depth + 1);
      if (nested !== null) return nested;
    }
  }
  for (const key of Object.keys(obj)) {
    const child = obj[key];
    if (child && typeof child === 'object') {
      const found = findPoints(child, depth + 1);
      if (found !== null) return found;
    }
  }
  return null;
}

/** 提取积分：优先自定义路径，其次自动识别；识别不到返回 null */
function extractPoints(json, cred) {
  if (!json) return null;
  if (cred && cred.points_path) {
    const v = toNumber(lookupPath(json, cred.points_path));
    if (v !== null) return v;
  }
  return findPoints(json);
}

function withPoints(baseMessage, points) {
  return points === null || points === 0 ? baseMessage : `${baseMessage}，获得 ${points} 积分`;
}

/** 解析适配器返回的响应体，尽量兼容常见 JSON 返回结构 */
function parseCommonBody(status, body) {
  if (status === 401 || status === 403) {
    return { success: false, authExpired: true, message: `授权已失效(HTTP ${status})，请重新登录授权` };
  }
  let json = null;
  try { json = JSON.parse(body); } catch (e) { /* 非 JSON */ }
  if (json && typeof json === 'object') {
    const code = json.code !== undefined ? json.code : json.errcode;
    const hasVerdict = code !== undefined || json.success !== undefined ||
                       json.status !== undefined || json.isSuccess !== undefined;
    // 有明确判定字段时按其结果；否则以 HTTP 状态码为准（避免 JSON 无 code 时被误判为失败）
    const ok = hasVerdict
      ? (code === 0 || code === '0' || code === 200 || code === '200' ||
         json.success === true || json.isSuccess === true ||
         json.status === 'success' || json.status === 'ok' ||
         json.status === 200 || json.status === '200')
      : (status >= 200 && status < 300);
    const msg = json.message || json.msg || (json.data && (json.data.message || json.data.msg)) || '';
    const points = ok ? extractPoints(json) : null;
    return {
      success: !!ok,
      points,
      message: msg ? withPoints(msg, points)
        : (ok ? withPoints('签到成功', points) : `签到失败：${JSON.stringify(json).slice(0, 200)}`)
    };
  }
  const ok = status >= 200 && status < 300;
  return { success: ok, points: null, message: ok ? '签到成功' : `签到失败：HTTP ${status}` };
}

/** 通用平台（custom）响应判定 */
function parseCustomBody(keyword, status, body, cred) {
  if (status === 401 || status === 403) {
    return { success: false, authExpired: true, message: `授权已失效(HTTP ${status})，请重新登录授权` };
  }
  const ok = status >= 200 && status < 300 && (!keyword || String(body).includes(keyword));
  let json = null;
  try { json = JSON.parse(body); } catch (e) { /* 非 JSON 响应 */ }
  const msg = (json && (json.message || json.msg)) || '';
  if (ok) {
    const points = extractPoints(json, cred);
    return { success: true, points, message: withPoints(msg ? `签到成功：${msg}` : '签到成功', points) };
  }
  return {
    success: false,
    message: `签到失败：HTTP ${status}${keyword && !msg ? ` 或未匹配关键字“${keyword}”` : ''}${msg ? `：${msg}` : ''}`
  };
}

// ---------- 内置平台注册表 ----------
const REGISTRY = {
  trae: {
    id: 'trae',
    name: 'Trae',
    desc: 'Trae AI IDE（字节跳动）',
    fields: [
      { key: 'cookie', label: 'Cookie', type: 'textarea', required: true, placeholder: '登录 trae.cn 后，从浏览器开发者工具复制完整 Cookie' },
      { key: 'token', label: 'API Token（可选）', type: 'text', required: false, placeholder: 'Bearer Token，如平台需要' },
      { key: 'checkin_url', label: '签到接口地址（可选）', type: 'text', required: false, placeholder: '留空使用内置默认；官方接口变动时可在此覆盖' }
    ],
    defaultUrl: 'https://trae.cn/api/user/checkin',
    buildRequest(cred) {
      const headers = { 'User-Agent': UA, 'Content-Type': 'application/json' };
      if (cred.cookie) headers['Cookie'] = cred.cookie;
      if (cred.token) headers['Authorization'] = `Bearer ${cred.token}`;
      return { url: cred.checkin_url || this.defaultUrl, method: 'POST', headers, body: '{}' };
    },
    parseResponse: (status, body) => parseCommonBody(status, body)
  },

  workbuddy: {
    id: 'workbuddy',
    name: 'WorkBuddy',
    desc: 'WorkBuddy AI 工作台',
    fields: [
      { key: 'cookie', label: 'Cookie', type: 'textarea', required: true, placeholder: '登录后从浏览器开发者工具复制完整 Cookie' },
      { key: 'token', label: 'API Token（可选）', type: 'text', required: false, placeholder: 'Bearer Token，如平台需要' },
      { key: 'checkin_url', label: '签到接口地址（可选）', type: 'text', required: false, placeholder: '留空使用内置默认；官方接口变动时可在此覆盖' }
    ],
    defaultUrl: 'https://workbuddy.cn/api/checkin',
    buildRequest(cred) {
      const headers = { 'User-Agent': UA, 'Content-Type': 'application/json' };
      if (cred.cookie) headers['Cookie'] = cred.cookie;
      if (cred.token) headers['Authorization'] = `Bearer ${cred.token}`;
      return { url: cred.checkin_url || this.defaultUrl, method: 'POST', headers, body: '{}' };
    },
    parseResponse: (status, body) => parseCommonBody(status, body)
  },

  codebuddy: {
    id: 'codebuddy',
    name: 'CodeBuddy',
    desc: '腾讯云 CodeBuddy AI 编程助手',
    fields: [
      { key: 'cookie', label: 'Cookie', type: 'textarea', required: true, placeholder: '登录 codebuddy.ai 后，从浏览器开发者工具复制完整 Cookie' },
      { key: 'token', label: 'API Token（可选）', type: 'text', required: false, placeholder: 'Bearer Token，如平台需要' },
      { key: 'checkin_url', label: '签到接口地址（可选）', type: 'text', required: false, placeholder: '留空使用内置默认；官方接口变动时可在此覆盖' }
    ],
    defaultUrl: 'https://codebuddy.ai/api/user/checkin',
    buildRequest(cred) {
      const headers = { 'User-Agent': UA, 'Content-Type': 'application/json' };
      if (cred.cookie) headers['Cookie'] = cred.cookie;
      if (cred.token) headers['Authorization'] = `Bearer ${cred.token}`;
      return { url: cred.checkin_url || this.defaultUrl, method: 'POST', headers, body: '{}' };
    },
    parseResponse: (status, body) => parseCommonBody(status, body)
  },

  custom: {
    id: 'custom',
    name: '自定义平台',
    desc: '接入任意平台：自行填写接口、方法、凭据与成功判定',
    fields: [
      { key: 'url', label: '签到接口地址', type: 'text', required: true, placeholder: 'https://example.com/api/checkin' },
      { key: 'method', label: '请求方法', type: 'select', required: true, options: ['POST', 'GET', 'PUT'], placeholder: '' },
      { key: 'cookie', label: 'Cookie（可选）', type: 'textarea', required: false, placeholder: 'k1=v1; k2=v2' },
      { key: 'headers', label: '额外请求头（可选，JSON）', type: 'textarea', required: false, placeholder: '{"Authorization": "Bearer xxx"}' },
      { key: 'body', label: '请求体（可选）', type: 'textarea', required: false, placeholder: '{"action":"checkin"}' },
      { key: 'keyword', label: '成功关键字（可选）', type: 'text', required: false, placeholder: '响应中包含该关键字才视为成功，留空则 HTTP 2xx 即成功' },
      { key: 'points_path', label: '积分字段路径（可选）', type: 'text', required: false, placeholder: '如 data.reward.points；留空自动识别 points/credit/reward 等字段' }
    ],
    buildRequest(cred) {
      const headers = { 'User-Agent': UA };
      if (cred.cookie) headers['Cookie'] = cred.cookie;
      if (cred.headers) {
        try { Object.assign(headers, JSON.parse(cred.headers)); } catch (e) { /* 忽略非法 JSON */ }
      }
      const method = (cred.method || 'POST').toUpperCase();
      const body = method === 'GET' ? undefined : (cred.body || undefined);
      if (body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
      return { url: cred.url, method, headers, body };
    },
    parseResponse(status, body, cred) {
      return parseCustomBody(cred && cred.keyword, status, body, cred);
    }
  }
};

function platformOptions() {
  return Object.values(REGISTRY).map(p => ({ id: p.id, name: p.name, desc: p.desc }));
}

// ---------- 签到引擎 ----------
const inFlight = new Set();

function parseCredentials(account) {
  try { return JSON.parse(account.credentials || '{}'); } catch (e) { return {}; }
}

async function runCheckin(account, trigger) {
  const adapter = REGISTRY[account.platform];
  if (!adapter) return { success: false, message: `未知平台 ${account.platform}` };
  if (account.status !== 'active') return { success: false, message: '账号已过期或被停用，请先重新授权' };
  if (inFlight.has(account.id)) return { success: false, message: '该账号签到正在执行中' };
  inFlight.add(account.id);

  const now = getNow();
  const cred = parseCredentials(account);
  let result;
  try {
    const req = adapter.buildRequest(cred);
    if (!/^https?:\/\//i.test(req.url)) throw new Error('无效的接口地址：' + req.url);
    const res = await fetch(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body,
      redirect: 'follow',
      signal: AbortSignal.timeout(20000)
    });
    const body = await res.text();
    result = adapter.parseResponse(res.status, body, cred);
  } catch (err) {
    result = { success: false, message: '请求异常：' + (err && err.message ? err.message : String(err)) };
  } finally {
    inFlight.delete(account.id);
  }

  // 写日志并更新账号状态
  const points = result.success && typeof result.points === 'number' ? result.points : 0;
  const resultText = `${result.success ? '成功' : '失败'}（${trigger === 'manual' ? '手动' : '定时'}）${points > 0 ? ` +${points}积分` : ''}：${result.message}`;
  db.prepare('INSERT INTO logs(account_id, user_id, platform, success, message, points, created_at) VALUES(?,?,?,?,?,?,?)')
    .run(account.id, account.user_id, account.platform, result.success ? 1 : 0, result.message, points, now);
  db.prepare('UPDATE accounts SET last_checkin_at = ?, last_result = ? WHERE id = ?')
    .run(now, resultText, account.id);

  if (result.authExpired) {
    // 授权失效：立即登出（清除本地凭据）并提示
    db.prepare(`UPDATE accounts SET status = 'expired', credentials = '{}' WHERE id = ?`).run(account.id);
    notify(account.user_id, 'session_expired',
      `「${account.name}」授权已失效`,
      `${adapter.name} 的授权已失效（可能已在别处登出或凭证过期），系统已自动登出。请前往“平台账号”重新授权。`);
  } else if (!result.success) {
    notify(account.user_id, 'checkin_failed',
      `「${account.name}」签到失败`,
      `${adapter.name}：${result.message}`);
  }
  return result;
}

/** 新增/重新授权时刷新授权时间与到期时间（保持一周） */
function authorizeFields(credentials) {
  const now = getNow();
  return {
    credentials: JSON.stringify(credentials),
    authorized_at: now,
    expires_at: addDays(now, config.AUTH_KEEP_DAYS),
    status: 'active'
  };
}

module.exports = { REGISTRY, platformOptions, runCheckin, parseCredentials, authorizeFields };
