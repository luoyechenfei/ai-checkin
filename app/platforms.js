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

/** 生成 UUID（用于 ZCode x-request-id） */
function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
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
    help: '获取 Token：浏览器打开 www.trae.cn 并登录 → F12 开发者工具 → Network（网络）面板 → 过滤 api.trae.cn → 按 F5 刷新 → 点击 cn_credits_billing_status 等请求 → Headers → Request Headers → 复制 Authorization: Cloud-IDE-JWT 后面的整串。注意：Local Storage 中的 Cloud-IDE-Token 不可用；Token 有效期约 12 小时，失效后需重新获取。',
    fields: [
      { key: 'token', label: 'JWT Token', type: 'textarea', required: true, placeholder: '从 Trae 客户端提取的 Cloud-IDE-JWT Token' },
      { key: 'device_id', label: '设备 ID（可选）', type: 'text', required: false, placeholder: '设备 ID，部分接口可能需要' },
      { key: 'region', label: '用户区域（可选）', type: 'text', required: false, placeholder: '如 CN，部分接口可能需要' }
    ],
    defaultUrl: 'https://api.trae.cn/trae/api/v2/ug/checkin_credits/claim',
    statusUrl: 'https://api.trae.cn/trae/api/v2/ug/checkin_credits/status',
    // 领取接口不返回积分，签到成功后需再查状态接口获取当日积分
    pointsFromStatus: true,
    buildRequest(cred) {
      const headers = { 'User-Agent': UA, 'Content-Type': 'application/json', 'Origin': 'https://www.trae.cn', 'Referer': 'https://www.trae.cn/' };
      if (cred.token) headers['Authorization'] = `Cloud-IDE-JWT ${cred.token}`;
      if (cred.device_id) headers['x-device-id'] = cred.device_id;
      if (cred.region) headers['X-User-Region'] = cred.region;
      return { url: this.defaultUrl, method: 'POST', headers, body: '{"req_source":1}' };
    },
    buildStatusRequest(cred) {
      const headers = { 'User-Agent': UA, 'Content-Type': 'application/json', 'Origin': 'https://www.trae.cn', 'Referer': 'https://www.trae.cn/' };
      if (cred.token) headers['Authorization'] = `Cloud-IDE-JWT ${cred.token}`;
      if (cred.device_id) headers['x-device-id'] = cred.device_id;
      if (cred.region) headers['X-User-Region'] = cred.region;
      return { url: this.statusUrl, method: 'POST', headers, body: '{}' };
    },
    parseResponse: (status, body) => {
      if (status === 401 || status === 403) {
        return { success: false, authExpired: true, message: `授权已失效(HTTP ${status})，请重新登录授权` };
      }
      let json = null;
      try { json = JSON.parse(body); } catch (e) { /* 非 JSON */ }
      if (json && typeof json === 'object') {
        const code = json.code;
        const checkedIn = json.checked_in === true || json.checked_in === 'true';
        const credits = toNumber(json.credits) || toNumber(json.data?.credits) || 0;
        const extraCredits = toNumber(json.extra_credits) || toNumber(json.data?.extra_credits) || 0;
        const points = credits + extraCredits;
        
        if (code === 0 || checkedIn) {
          return { success: true, points, message: withPoints('签到成功', points) };
        }
        if (code === 9095 || code === 9004) {
          // 9004/9095：本设备当日已签过，视为今日已完成（不计为失败）
          return { success: true, alreadyCheckedIn: true, message: '今日已签到' };
        }
        const msg = json.message || json.msg || '';
        return { success: false, message: msg || `签到失败(code=${code})` };
      }
      return { success: false, message: `签到失败：HTTP ${status}` };
    },
    parseStatusResponse: (status, body) => {
      if (status !== 200) return { checked: null, error: `HTTP ${status}` };
      let json = null;
      try { json = JSON.parse(body); } catch (e) { return { checked: null, error: '非 JSON 响应' }; }
      const checked = json.checked_in === true || json.checked_in === 'true';
      return {
        checked,
        credits: toNumber(json.credits) || 0,
        extraCredits: toNumber(json.extra_credits) || 0,
        enable: json.enable === true,
        raw: json
      };
    }
  },

  workbuddy: {
    id: 'workbuddy',
    name: 'WorkBuddy',
    desc: '腾讯 WorkBuddy AI 编程助手（桌面端）',
    help: '获取 Access Token：WorkBuddy 是 Electron 应用，Token 加密保存在内存中，需抓包获取。①完全退出 WorkBuddy 客户端；②命令行带调试端口启动："D:\\WorkBuddy\\WorkBuddy.exe" --remote-debugging-port=9223（路径按实际安装位置）；③打开 http://127.0.0.1:9223 进入调试页（或用支持 CDP 的工具连接），开启 Network 监听后刷新/操作客户端，从任意 www.workbuddy.cn/v2 请求的 Headers 中复制 Authorization: Bearer 后面的整串填入。Token 为 Keycloak JWT，有效期约 28 天；用户 ID 即 JWT 载荷中的 sub 字段（99494ddb- 开头的 UUID），可不填。',
    fields: [
      { key: 'access_token', label: 'Access Token', type: 'password', required: true, placeholder: '从 WorkBuddy 客户端抓包获取的 Bearer Token' },
      { key: 'uid', label: '用户 ID（可选）', type: 'text', required: false, placeholder: 'JWT 载荷中的 sub 字段（UUID），一般可留空' },
      { key: 'domain', label: '域名（可选）', type: 'select', required: false, options: ['https://www.workbuddy.cn', 'https://www.codebuddy.cn'], placeholder: '默认 https://www.workbuddy.cn' }
    ],
    defaultUrl: 'https://www.workbuddy.cn/v2/billing/meter/daily-checkin',
    statusUrl: 'https://www.workbuddy.cn/v2/billing/meter/checkin-activity-status',
    domains: ['https://www.workbuddy.cn', 'https://www.codebuddy.cn'],
    buildRequest(cred) {
      const domain = cred.domain || this.domains[0];
      const headers = {
        'User-Agent': UA,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'X-Domain': domain.replace('https://', '')
      };
      if (cred.access_token) headers['Authorization'] = `Bearer ${cred.access_token}`;
      if (cred.uid) headers['X-User-Id'] = cred.uid;
      return {
        url: domain + '/v2/billing/meter/daily-checkin',
        method: 'POST',
        headers,
        body: '{}'
      };
    },
    buildStatusRequest(cred) {
      const domain = cred.domain || this.domains[0];
      const headers = {
        'User-Agent': UA,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'X-Domain': domain.replace('https://', '')
      };
      if (cred.access_token) headers['Authorization'] = `Bearer ${cred.access_token}`;
      if (cred.uid) headers['X-User-Id'] = cred.uid;
      return {
        url: domain + '/v2/billing/meter/checkin-activity-status',
        method: 'POST',
        headers,
        body: '{}'
      };
    },
    parseResponse: (status, body) => {
      if (status === 401 || status === 403) {
        return { success: false, authExpired: true, message: `授权已失效(HTTP ${status})，请重新登录授权` };
      }
      let json = null;
      try { json = JSON.parse(body); } catch (e) { /* 非 JSON */ }
      if (json && typeof json === 'object') {
        const code = json.code;
        const msg = json.message || json.msg || '';
        const data = json.data || {};
        const credit = toNumber(data.credit) || toNumber(data.todayCredit) || toNumber(data.today_credit) || 0;
        
        if (code === 0 || code === 10001 || msg.includes('已签到')) {
          return { success: true, points: credit, message: withPoints('签到成功', credit) };
        }
        if (code === 41000) {
          return { success: false, message: '签到活动未开始或已结束' };
        }
        return { success: false, message: msg || `签到失败(code=${code})` };
      }
      return { success: false, message: `签到失败：HTTP ${status}` };
    },
    parseStatusResponse: (status, body) => {
      if (status !== 200) return { checked: null, error: `HTTP ${status}` };
      let json = null;
      try { json = JSON.parse(body); } catch (e) { return { checked: null, error: '非 JSON 响应' }; }
      const data = json.data || json;
      const checked = data.todayCheckedIn === true || data.today_checked_in === true;
      return {
        checked,
        todayCredit: toNumber(data.todayCredit) || toNumber(data.today_credit) || 0,
        raw: data
      };
    }
  },

  codebuddy: {
    id: 'codebuddy',
    name: 'CodeBuddy',
    desc: '腾讯云 CodeBuddy AI 编程助手',
    fields: [
      { key: 'access_token', label: 'Access Token', type: 'password', required: true, placeholder: '从 CodeBuddy 获取的 accessToken（Bearer Token）' },
      { key: 'uid', label: '用户 ID（可选）', type: 'text', required: false, placeholder: '用户 ID，部分接口可能需要' }
    ],
    defaultUrl: 'https://www.codebuddy.cn/v2/billing/meter/daily-checkin',
    statusUrl: 'https://www.codebuddy.cn/v2/billing/meter/checkin-activity-status',
    buildRequest(cred) {
      const headers = {
        'User-Agent': UA,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'X-Domain': 'www.codebuddy.cn'
      };
      if (cred.access_token) headers['Authorization'] = `Bearer ${cred.access_token}`;
      if (cred.uid) headers['X-User-Id'] = cred.uid;
      return {
        url: this.defaultUrl,
        method: 'POST',
        headers,
        body: '{}'
      };
    },
    buildStatusRequest(cred) {
      const headers = {
        'User-Agent': UA,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'X-Domain': 'www.codebuddy.cn'
      };
      if (cred.access_token) headers['Authorization'] = `Bearer ${cred.access_token}`;
      if (cred.uid) headers['X-User-Id'] = cred.uid;
      return {
        url: this.statusUrl,
        method: 'POST',
        headers,
        body: '{}'
      };
    },
    parseResponse: (status, body) => {
      if (status === 401 || status === 403) {
        return { success: false, authExpired: true, message: `授权已失效(HTTP ${status})，请重新登录授权` };
      }
      let json = null;
      try { json = JSON.parse(body); } catch (e) { /* 非 JSON */ }
      if (json && typeof json === 'object') {
        const code = json.code;
        const msg = json.message || json.msg || '';
        const data = json.data || {};
        const credit = toNumber(data.credit) || toNumber(data.todayCredit) || toNumber(data.today_credit) || 0;
        
        if (code === 0 || code === 10001 || msg.includes('已签到')) {
          return { success: true, points: credit, message: withPoints('签到成功', credit) };
        }
        if (code === 41000) {
          return { success: false, message: '签到活动未开始或已结束' };
        }
        return { success: false, message: msg || `签到失败(code=${code})` };
      }
      return { success: false, message: `签到失败：HTTP ${status}` };
    },
    parseStatusResponse: (status, body) => {
      if (status !== 200) return { checked: null, error: `HTTP ${status}` };
      let json = null;
      try { json = JSON.parse(body); } catch (e) { return { checked: null, error: '非 JSON 响应' }; }
      const data = json.data || json;
      const checked = data.todayCheckedIn === true || data.today_checked_in === true;
      return {
        checked,
        todayCredit: toNumber(data.todayCredit) || toNumber(data.today_credit) || 0,
        raw: data
      };
    }
  },

  zcode: {
    id: 'zcode',
    name: 'ZCode',
    desc: '智谱 Z.ai 编程客户端',
    fields: [
      { key: 'jwt_token', label: 'JWT Token', type: 'textarea', required: true, placeholder: '从 ZCode 客户端提取的 JWT Token' },
      { key: 'device_mid', label: '设备 MID（可选）', type: 'text', required: false, placeholder: '设备 MID，部分接口可能需要' },
      { key: 'app_version', label: '应用版本（可选）', type: 'text', required: false, placeholder: '如 1.0.0，部分接口可能需要' }
    ],
    defaultUrl: 'https://zcode.z.ai/api/v1/zcode-plan/billing/claim',
    previewUrl: 'https://zcode.z.ai/api/v1/zcode-plan/billing/preview',
    buildRequest(cred) {
      const headers = {
        'User-Agent': 'ZCode/' + (cred.app_version || '1.0.0'),
        'X-Title': 'Z Code@electron',
        'X-ZCode-App-Version': cred.app_version || '1.0.0',
        'X-Platform': 'win32-x64',
        'X-Release-Channel': 'stable',
        'X-Client-Language': 'zh-CN',
        'X-Client-Timezone': 'Asia/Shanghai',
        'X-Os-Category': 'windows',
        'X-Os-Version': '10.0.19041',
        'x-request-id': generateUUID()
      };
      if (cred.jwt_token) headers['Authorization'] = `Bearer ${cred.jwt_token}`;
      if (cred.device_mid) headers['X-Device-Mid'] = cred.device_mid;
      return {
        url: this.defaultUrl,
        method: 'POST',
        headers,
        body: '{}'
      };
    },
    buildStatusRequest(cred) {
      const headers = {
        'User-Agent': 'ZCode/' + (cred.app_version || '1.0.0'),
        'X-Title': 'Z Code@electron',
        'X-ZCode-App-Version': cred.app_version || '1.0.0',
        'X-Platform': 'win32-x64',
        'X-Release-Channel': 'stable',
        'X-Client-Language': 'zh-CN',
        'X-Client-Timezone': 'Asia/Shanghai',
        'X-Os-Category': 'windows',
        'X-Os-Version': '10.0.19041',
        'x-request-id': generateUUID()
      };
      if (cred.jwt_token) headers['Authorization'] = `Bearer ${cred.jwt_token}`;
      if (cred.device_mid) headers['X-Device-Mid'] = cred.device_mid;
      return {
        url: this.previewUrl + '?app_version=' + (cred.app_version || '1.0.0') + '&platform=win32-x64',
        method: 'GET',
        headers
      };
    },
    parseResponse: (status, body) => {
      if (status === 401 || status === 403) {
        return { success: false, authExpired: true, message: `授权已失效(HTTP ${status})，请重新登录授权` };
      }
      let json = null;
      try { json = JSON.parse(body); } catch (e) { /* 非 JSON */ }
      if (json && typeof json === 'object') {
        const code = json.code;
        const msg = json.message || json.msg || '';
        const data = json.data || {};
        const plan = data.plan || {};
        
        if (code === 0) {
          const units = toNumber(plan.units) || toNumber(data.units) || 0;
          return { success: true, points: units, message: withPoints('领取成功', units) };
        }
        if (code === 1003) {
          return { success: false, message: '该套餐已领取过' };
        }
        if (code === 1005) {
          return { success: false, message: '名额已领完' };
        }
        if (code === 1002) {
          return { success: false, message: '该活动已结束' };
        }
        if (code === 1004) {
          return { success: false, message: '不符合领取条件' };
        }
        return { success: false, message: msg || `领取失败(code=${code})` };
      }
      return { success: false, message: `领取失败：HTTP ${status}` };
    },
    parseStatusResponse: (status, body) => {
      if (status !== 200) return { checked: null, error: `HTTP ${status}` };
      let json = null;
      try { json = JSON.parse(body); } catch (e) { return { checked: null, error: '非 JSON 响应' }; }
      const data = json.data || json;
      const plans = data.plans || data.list || [];
      const hasClaimable = plans.some(p => !p.claimed && !p.expired);
      return {
        checked: !hasClaimable,
        hasClaimable,
        plans: plans,
        raw: data
      };
    }
  },

  qoder: {
    id: 'qoder',
    name: 'Qoder',
    desc: '阿里 Qoder AI 编程 IDE',
    fields: [
      { key: 'token', label: 'Access Token', type: 'textarea', required: true, placeholder: '从 Qoder CN 客户端提取的 Access Token' },
      { key: 'refresh_token', label: 'Refresh Token（可选）', type: 'textarea', required: false, placeholder: 'Refresh Token，用于自动续期' }
    ],
    defaultUrl: 'https://openapi.qoder.com.cn/sash/api/v1/me/campaigns',
    buildHeaders(cred) {
      const headers = {
        'User-Agent': UA,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Origin': 'https://openapi.qoder.com.cn'
      };
      if (cred.token) headers['Authorization'] = `Bearer ${cred.token}`;
      return headers;
    },
    buildRequest(cred) {
      return {
        url: this.defaultUrl + '?forceRefresh=true',
        method: 'GET',
        headers: this.buildHeaders(cred)
      };
    },
    buildStatusRequest(cred) {
      return {
        url: this.defaultUrl + '?forceRefresh=true',
        method: 'GET',
        headers: this.buildHeaders(cred)
      };
    },
    // Qoder 自定义签到流程：先获取活动列表 → 找到可领取的 → 执行领取
    async customCheckin(cred, fetchFn) {
      const headers = this.buildHeaders(cred);
      // 1. 获取活动列表
      const listRes = await fetchFn(this.defaultUrl + '?forceRefresh=true', {
        method: 'GET',
        headers
      });
      const listBody = await listRes.text();
      if (listRes.status === 401 || listRes.status === 403) {
        return { success: false, authExpired: true, message: 'Qoder 登录已失效，请重新登录 Qoder CN 客户端' };
      }
      if (listRes.status !== 200) {
        return { success: false, message: `获取活动列表失败：HTTP ${listRes.status}` };
      }
      let listJson;
      try { listJson = JSON.parse(listBody); } catch (e) { return { success: false, message: '活动列表响应格式错误' }; }
      const data = listJson.data || listJson;
      const campaigns = data.campaigns || data.list || [];
      // 找今日可领取的活动（daily 且未领取）
      const target = campaigns.find(c => c.daily && !c.claimed && c.claimStatus !== 'CLAIMED');
      if (!target) {
        return { success: true, points: 0, message: '今日已领取或无活动可领' };
      }
      // 2. 执行领取
      const campaignId = target.campaignId || target.id;
      const claimUrl = this.defaultUrl + '/' + encodeURIComponent(campaignId) + '/claim';
      const claimRes = await fetchFn(claimUrl, {
        method: 'POST',
        headers,
        body: '{}'
      });
      const claimBody = await claimRes.text();
      if (claimRes.status === 401 || claimRes.status === 403) {
        return { success: false, authExpired: true, message: 'Qoder 登录已失效，请重新登录 Qoder CN 客户端' };
      }
      let claimJson;
      try { claimJson = JSON.parse(claimBody); } catch (e) { claimJson = null; }
      const result = claimJson?.result || claimJson?.status || '';
      const benefit = claimJson?.benefit || claimJson?.data?.benefit || {};
      const amount = toNumber(benefit.amount) || toNumber(target.amount) || 100;
      // 已领取过
      if (claimRes.status === 409 || result === 'ALREADY_CLAIMED' || claimJson?.replayed) {
        return { success: true, points: amount, message: `今日已领取 ${amount} Credits` };
      }
      if (claimRes.status >= 200 && claimRes.status < 300) {
        return { success: true, points: amount, message: `领取成功：+${amount} Credits` };
      }
      return { success: false, message: `领取失败：HTTP ${claimRes.status}` };
    },
    parseResponse: (status, body) => parseCommonBody(status, body),
    parseStatusResponse: (status, body) => {
      if (status !== 200) return { checked: null, error: `HTTP ${status}` };
      let json = null;
      try { json = JSON.parse(body); } catch (e) { return { checked: null, error: '非 JSON 响应' }; }
      const data = json.data || json;
      const campaigns = data.campaigns || data.list || [];
      const todayCampaign = campaigns.find(c => c.daily && !c.claimed && c.claimStatus !== 'CLAIMED');
      const checked = !todayCampaign;
      return {
        checked,
        hasClaimable: !!todayCampaign,
        campaignId: todayCampaign?.campaignId || todayCampaign?.id,
        raw: data
      };
    }
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
    // 支持自定义签到流程（如 Qoder 需要先获取活动列表再领取）
    if (typeof adapter.customCheckin === 'function') {
      const fetchFn = (url, opts) => fetch(url, {
        ...opts,
        redirect: 'follow',
        signal: AbortSignal.timeout(20000)
      });
      result = await adapter.customCheckin(cred, fetchFn);
    } else {
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
    }
  } catch (err) {
    result = { success: false, message: '请求异常：' + (err && err.message ? err.message : String(err)) };
  } finally {
    inFlight.delete(account.id);
  }

  // 部分平台（如 Trae）的领取接口不返回积分：签到成功后用状态接口补全当日积分
  if (result.success && !result.alreadyCheckedIn &&
      !(typeof result.points === 'number' && result.points > 0) &&
      adapter.pointsFromStatus && typeof adapter.buildStatusRequest === 'function' &&
      typeof adapter.parseStatusResponse === 'function') {
    try {
      const sreq = adapter.buildStatusRequest(cred);
      const sres = await fetch(sreq.url, {
        method: sreq.method,
        headers: sreq.headers,
        body: sreq.body,
        signal: AbortSignal.timeout(10000)
      });
      const st = adapter.parseStatusResponse(sres.status, await sres.text());
      const base = st.credits || 0;
      const extra = st.extraCredits || 0;
      const p = base + extra;
      if (p > 0) {
        result.points = p;
        result.message = `${result.message}，获得 ${p} 积分` + (extra > 0 ? `（基础 ${base} + 额外 ${extra}）` : '');
      }
    } catch (e) { /* 积分补全失败不影响签到结果 */ }
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
