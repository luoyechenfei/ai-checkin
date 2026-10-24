'use strict';
const express = require('express');
const router = express.Router();
const config = require('../config');
const { db, getSetting, setSetting, notify, getNow, auditReq, writeAudit } = require('../db');
const { REGISTRY, platformOptions, runCheckin, authorizeFields, traeGenDevice } = require('../platforms');
const { isValidTimezone, isValidHHMM } = require('../util');
const {
  hashPassword, verifyPassword, createSession, destroySession,
  requireAuth, requireAdmin
} = require('../security');
const captcha = require('../captcha');

// Trae OAuth 临时设备存储：key=tempId，value={device, expiresAt}（10 分钟有效）
const oauthTempStore = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of oauthTempStore) if (v.expiresAt < now) oauthTempStore.delete(k);
}, 60000).unref?.();

const back = (path, msg, type) =>
  `${path}?msg=${encodeURIComponent(msg)}&type=${type === 'err' ? 'err' : 'ok'}`;

function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    (req.socket && req.socket.remoteAddress) || '';
}

/** 表单里的 id 列表（支持单值/数组），返回去重后的正整数数组 */
function idList(raw) {
  const arr = Array.isArray(raw) ? raw : (raw == null ? [] : [raw]);
  const ids = arr.map(v => parseInt(v, 10)).filter(n => Number.isInteger(n) && n > 0);
  return [...new Set(ids)];
}

/** 从表单中按适配器字段定义收集凭据（含 OAuth 隐藏字段） */
function collectCredentials(req, platformId) {
  const adapter = REGISTRY[platformId];
  if (!adapter) return null;
  const cred = {};
  const allFields = [...(adapter.fields || []), ...(adapter.oauthFields || [])];
  for (const f of allFields) {
    const raw = req.body[`f_${f.key}`];
    // 同名字段可能来自多个平台的 credfields（如 Trae 与 Qoder 都有 token），
    // 取第一个非空值，避免取到其它平台的空字段。
    const arr = Array.isArray(raw) ? raw : [raw];
    const v = arr.map(x => String(x ?? '').trim()).find(x => x) || '';
    if (f.required && !v) return null;
    if (v) cred[f.key] = v;
  }
  return cred;
}

// ---------- 初始化向导 ----------
router.post('/setup', (req, res) => {
  const n = db.prepare('SELECT COUNT(*) AS c FROM users WHERE is_admin = 1').get().c;
  if (n > 0) return res.redirect('/login');

  const username = (req.body.username || '').trim();
  const password = req.body.password || '';
  const password2 = req.body.password2 || '';
  const siteName = (req.body.site_name || '').trim() || 'AI 签到助手';
  const checkinTime = (req.body.default_checkin_time || '08:00').trim();
  const timezone = (req.body.timezone || config.DEFAULT_TIMEZONE).trim();
  const externalPort = (req.body.external_port || '').trim();
  const internalPort = (req.body.internal_port || '').trim();

  if (username.length < 2 || username.length > 32) return res.redirect(back('/setup', '管理员用户名需 2-32 个字符', 'err'));
  if (password.length < 6) return res.redirect(back('/setup', '密码至少 6 位', 'err'));
  if (password !== password2) return res.redirect(back('/setup', '两次输入的密码不一致', 'err'));
  if (!isValidHHMM(checkinTime)) return res.redirect(back('/setup', '签到时间格式应为 HH:MM', 'err'));
  if (!isValidTimezone(timezone)) return res.redirect(back('/setup', '无效的时区，例如 Asia/Shanghai', 'err'));

  setSetting('site_name', siteName);
  setSetting('default_checkin_time', checkinTime);
  setSetting('timezone', timezone);
  setSetting('allow_register', req.body.allow_register === '1' ? '1' : '0');
  setSetting('internal_port', internalPort || String(config.PORT));
  setSetting('external_port', externalPort);

  db.prepare('INSERT INTO users(username, password_hash, is_admin, created_at) VALUES(?,?,1,?)')
    .run(username, hashPassword(password), getNow());
  notify(db.prepare('SELECT id FROM users WHERE username = ?').get(username).id,
    'system', '欢迎使用 AI 签到助手', '系统初始化完成。请前往「平台账号」添加并授权你的第一个平台。');

  const user = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  writeAudit({
    userId: user.id, username, action: 'setup',
    detail: `完成系统初始化，站点名称：${siteName}`, ip: clientIp(req)
  });
  createSession(res, user.id);
  res.redirect(back('/dashboard', '初始化完成，欢迎使用！'));
});

// ---------- 登录 / 注册 / 登出 ----------
router.post('/login', (req, res) => {
  const username = (req.body.username || '').trim();
  const password = req.body.password || '';
  if (!captcha.verify(req.body.captcha_id, req.body.captcha_code)) {
    return res.redirect(back('/login', '验证码错误或已过期，请重新输入', 'err'));
  }
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || !verifyPassword(password, user.password_hash)) {
    writeAudit({
      username, action: 'login_failed',
      detail: `登录失败：用户名或密码错误（${username}）`, ip: clientIp(req)
    });
    return res.redirect(back('/login', '用户名或密码错误', 'err'));
  }
  if (user.status !== 'active') {
    writeAudit({
      userId: user.id, username: user.username, action: 'login_failed',
      detail: '登录失败：账号已被禁用', ip: clientIp(req)
    });
    return res.redirect(back('/login', '该账号已被禁用', 'err'));
  }
  createSession(res, user.id);
  writeAudit({
    userId: user.id, username: user.username, action: 'login',
    detail: '登录成功', ip: clientIp(req)
  });
  res.redirect('/dashboard');
});

router.post('/register', (req, res) => {
  if (getSetting('allow_register', '0') !== '1') return res.redirect(back('/login', '当前未开放注册', 'err'));
  const username = (req.body.username || '').trim();
  const password = req.body.password || '';
  const password2 = req.body.password2 || '';
  if (!captcha.verify(req.body.captcha_id, req.body.captcha_code)) {
    return res.redirect(back('/register', '验证码错误或已过期，请重新输入', 'err'));
  }
  if (username.length < 2 || username.length > 32) return res.redirect(back('/register', '用户名需 2-32 个字符', 'err'));
  if (password.length < 6) return res.redirect(back('/register', '密码至少 6 位', 'err'));
  if (password !== password2) return res.redirect(back('/register', '两次输入的密码不一致', 'err'));
  const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (exists) return res.redirect(back('/register', '用户名已存在', 'err'));
  const info = db.prepare('INSERT INTO users(username, password_hash, is_admin, created_at) VALUES(?,?,0,?)')
    .run(username, hashPassword(password), getNow());
  const newId = Number(info.lastInsertRowid);
  writeAudit({
    userId: newId, username, action: 'register',
    detail: '注册新用户', ip: clientIp(req)
  });
  createSession(res, newId);
  res.redirect(back('/dashboard', '注册成功，欢迎！请先添加平台账号。'));
});

router.post('/logout', (req, res) => {
  auditReq(req, 'logout', '退出登录');
  destroySession(req, res);
  res.redirect('/login?msg=' + encodeURIComponent('已退出登录'));
});

// ---------- 账号设置：修改密码 / 安全问题 ----------
router.post('/password/change', requireAuth, (req, res) => {
  const oldPw = req.body.old_password || '';
  const pw = req.body.password || '';
  const pw2 = req.body.password2 || '';
  const u = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
  if (!u || !verifyPassword(oldPw, u.password_hash)) {
    auditReq(req, 'password_change', '修改密码失败：原密码错误');
    return res.redirect(back('/password', '原密码不正确', 'err'));
  }
  if (pw.length < 6) return res.redirect(back('/password', '新密码至少 6 位', 'err'));
  if (pw !== pw2) return res.redirect(back('/password', '两次输入的新密码不一致', 'err'));
  if (pw === oldPw) return res.redirect(back('/password', '新密码不能与原密码相同', 'err'));
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(pw), req.user.id);
  // 使其它设备上的会话失效，仅保留当前会话
  const cur = req.cookies && req.cookies[config.SESSION_COOKIE];
  if (cur) db.prepare('DELETE FROM sessions WHERE user_id = ? AND token != ?').run(req.user.id, cur);
  auditReq(req, 'password_change', '修改登录密码');
  res.redirect(back('/password', '密码已修改，其他设备的登录状态已失效'));
});

router.post('/password/questions', requireAuth, (req, res) => {
  const pw = req.body.current_password || '';
  const u = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
  if (!u || !verifyPassword(pw, u.password_hash)) {
    auditReq(req, 'secq_update', '设置安全问题失败：当前密码错误');
    return res.redirect(back('/password', '当前密码不正确', 'err'));
  }
  const qs = [], as = [];
  for (let i = 1; i <= 3; i++) {
    const q = String(req.body[`q${i}`] || '').trim();
    const a = String(req.body[`a${i}`] || '').trim();
    if (!q || !a) return res.redirect(back('/password', `请完整填写第 ${i} 个安全问题与答案`, 'err'));
    if (q.length > 100 || a.length > 100) return res.redirect(back('/password', '问题或答案过长（最多 100 字符）', 'err'));
    qs.push(q); as.push(hashPassword(a.toLowerCase()));
  }
  db.prepare('UPDATE users SET sec_q1=?, sec_a1=?, sec_q2=?, sec_a2=?, sec_q3=?, sec_a3=? WHERE id=?')
    .run(qs[0], as[0], qs[1], as[1], qs[2], as[2], req.user.id);
  auditReq(req, 'secq_update', '设置/更新找回密码安全问题');
  res.redirect(back('/password', '安全问题已保存，可用于找回密码'));
});

// ---------- 找回密码（无需登录） ----------
const crypto = require('crypto');

/** 在“站点时区的墙上时间字符串”上加分钟数（与 getNow 输出格式一致） */
function addMinutes(dateStr, minutes) {
  const d = new Date(dateStr.replace(' ', 'T') + 'Z');
  d.setUTCMinutes(d.getUTCMinutes() + minutes);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

router.post('/forgot', (req, res) => {
  if (!captcha.verify(req.body.captcha_id, req.body.captcha_code)) {
    return res.redirect(back('/forgot', '验证码错误或已过期', 'err'));
  }
  const username = (req.body.username || '').trim();
  const u = db.prepare(`SELECT * FROM users WHERE username = ? AND status = 'active'`).get(username);
  if (!u) return res.redirect(back('/forgot', '该用户名不存在或已被禁用', 'err'));
  if (!u.sec_q1 || !u.sec_q2 || !u.sec_q3) {
    return res.redirect(back('/forgot', '该账号未设置安全问题，无法自助找回，请联系管理员重置密码', 'err'));
  }
  db.prepare('DELETE FROM password_resets WHERE user_id = ? OR expires_at <= ?').run(u.id, getNow());
  const token = crypto.randomBytes(24).toString('hex');
  db.prepare('INSERT INTO password_resets(token, user_id, verified, attempts, created_at, expires_at) VALUES(?,?,0,0,?,?)')
    .run(token, u.id, getNow(), addMinutes(getNow(), 10));
  writeAudit({ userId: u.id, username: u.username, action: 'forgot_request', detail: '申请找回密码', ip: clientIp(req) });
  res.redirect('/forgot/answer?token=' + token);
});

router.post('/forgot/answer', (req, res) => {
  const r = db.prepare('SELECT * FROM password_resets WHERE token = ?').get(String(req.body.token || ''));
  if (!r || r.expires_at <= getNow() || r.verified) {
    return res.redirect(back('/forgot', '链接无效或已过期，请重新申请', 'err'));
  }
  if (r.attempts >= 5) {
    db.prepare('DELETE FROM password_resets WHERE token = ?').run(r.token);
    return res.redirect(back('/forgot', '答案错误次数过多，请重新申请', 'err'));
  }
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(r.user_id);
  if (!u) return res.redirect(back('/forgot', '账号不存在', 'err'));
  const ok = [1, 2, 3].every(i =>
    verifyPassword(String(req.body[`a${i}`] || '').trim().toLowerCase(), u[`sec_a${i}`] || ''));
  if (!ok) {
    db.prepare('UPDATE password_resets SET attempts = attempts + 1 WHERE token = ?').run(r.token);
    const left = 4 - r.attempts;
    return res.redirect('/forgot/answer?token=' + r.token + '&msg=' +
      encodeURIComponent(`答案不正确，还可尝试 ${left} 次`) + '&type=err');
  }
  db.prepare('UPDATE password_resets SET verified = 1 WHERE token = ?').run(r.token);
  res.redirect('/forgot/reset?token=' + r.token);
});

router.post('/forgot/reset', (req, res) => {
  const r = db.prepare('SELECT * FROM password_resets WHERE token = ?').get(String(req.body.token || ''));
  if (!r || !r.verified || r.expires_at <= getNow()) {
    return res.redirect(back('/forgot', '链接无效、未通过验证或已过期，请重新申请', 'err'));
  }
  const pw = req.body.password || '';
  const pw2 = req.body.password2 || '';
  if (pw.length < 6) return res.redirect('/forgot/reset?token=' + r.token + '&msg=' + encodeURIComponent('新密码至少 6 位') + '&type=err');
  if (pw !== pw2) return res.redirect('/forgot/reset?token=' + r.token + '&msg=' + encodeURIComponent('两次输入的新密码不一致') + '&type=err');
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(pw), r.user_id);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(r.user_id);
  db.prepare('DELETE FROM password_resets WHERE user_id = ?').run(r.user_id);
  const u = db.prepare('SELECT username FROM users WHERE id = ?').get(r.user_id);
  writeAudit({ userId: r.user_id, username: u ? u.username : '', action: 'forgot_success', detail: '通过安全问题找回密码', ip: clientIp(req) });
  res.redirect(back('/login', '密码已重置，请使用新密码登录'));
});

// ---------- 主题偏好 ----------
router.post('/prefs/theme', requireAuth, (req, res) => {
  const theme = String(req.body.theme || '');
  if (!['auto', 'light', 'dark'].includes(theme)) return res.status(400).json({ error: '无效的主题' });
  db.prepare('UPDATE users SET theme = ? WHERE id = ?').run(theme, req.user.id);
  res.status(204).end();
});

// ---------- 平台账号 ----------
router.post('/accounts', requireAuth, (req, res) => {
  const platform = (req.body.platform || '').trim();
  const name = (req.body.name || '').trim();
  const time = (req.body.checkin_time || getSetting('default_checkin_time', '08:00')).trim();
  if (!REGISTRY[platform]) return res.redirect(back('/accounts', '无效的平台类型', 'err'));
  if (!name) return res.redirect(back('/accounts', '请填写备注名称', 'err'));
  if (!isValidHHMM(time)) return res.redirect(back('/accounts', '签到时间格式应为 HH:MM', 'err'));
  const cred = collectCredentials(req, platform);
  if (!cred) return res.redirect(back('/accounts', '请完整填写平台必填凭据', 'err'));

  // 自动续期：仅当账号具备 refresh_token 时才允许启用
  const wantAutoRenew = req.body.auto_renew === '1' || req.body.auto_renew === 'on';
  const autoRenew = !!(wantAutoRenew && cred.refresh_token);
  const tokenExpiresAt = cred.token_expires_at || null;
  delete cred.token_expires_at;

  const a = authorizeFields(cred, { autoRenew });
  db.prepare(`INSERT INTO accounts(user_id, platform, name, credentials, status, authorized_at, expires_at, checkin_time, created_at, auto_renew, token_expires_at)
              VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
    .run(req.user.id, platform, name, a.credentials, a.status, a.authorized_at, a.expires_at, time, getNow(), autoRenew ? 1 : 0, tokenExpiresAt);
  auditReq(req, 'account_add', `添加平台账号「${name}」（${platform}）${autoRenew ? '，自动续期' : ''}`);
  res.redirect(back('/accounts', `「${name}」添加成功${autoRenew ? '，已开启自动续期' : '，授权将保持 7 天，到期自动提醒'}`));
});

// ---------- Trae OAuth 自动续期：生成授权链接 / 解析回调 ----------
// 生成设备并返回 Trae 扫码授权 URL
router.post('/accounts/oauth/trae/url', requireAuth, (req, res) => {
  const device = traeGenDevice();
  const tempId = crypto.randomBytes(12).toString('hex');
  oauthTempStore.set(tempId, { device, expiresAt: Date.now() + 10 * 60 * 1000 });
  // 前端传入真实 origin（window.location.origin），比服务端 Host 头更可靠；
  // 本地访问（127.0.0.1/localhost）→ 回调直接打回 app，做到无缝授权；
  // 远程部署 → Trae 要求回调必须 127.0.0.1，走「粘贴回调链接」兜底
  const origin = String(req.body.origin || req.headers.host || '').trim();
  const isLocal = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(origin) ||
                  /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin);
  let callbackUrl;
  if (isLocal) {
    const base = origin.startsWith('http') ? origin : `http://${origin}`;
    // 回调 URL 必须干净（不能带 query/path 参数），否则 Trae 授权页会报「网络错误」；
    // tempId 通过 cookie 传递，GET /authorize 时读取
    callbackUrl = `${base}/authorize`;
    res.cookie('trae_oauth_temp', tempId, { httpOnly: true, maxAge: 10 * 60 * 1000, sameSite: 'lax' });
  } else {
    callbackUrl = 'http://127.0.0.1:39393/authorize';
  }
  const url = REGISTRY.trae.getOAuthAuthUrl(device, callbackUrl);
  res.json({ ok: true, tempId, url, seamless: isLocal });
});

// 共享：解析回调链接 + 设备绑定续期，返回 {ok, ...字段} 或 {ok:false, error}
async function traeResolveCallback(tempId, callbackUrl) {
  const stored = oauthTempStore.get(tempId);
  if (!stored) return { ok: false, error: '授权会话已过期，请重新生成授权链接' };
  if (Date.now() > stored.expiresAt) {
    oauthTempStore.delete(tempId);
    return { ok: false, error: '授权会话已过期，请重新生成授权链接' };
  }
  try {
    const parsed = REGISTRY.trae.parseOAuthCallback(callbackUrl);
    let token = parsed.token;
    let refreshToken = parsed.refreshToken;
    let expiresAt = parsed.expiresAt;
    // 立即做一次设备绑定续期，让回调得到的无设备 Token 绑定到本设备
    // （否则签到接口会返回 9074「当前参与用户太多」）；失败则使用原始 Token
    try {
      const bound = await REGISTRY.trae.refreshToken({
        token: parsed.token,
        refresh_token: parsed.refreshToken,
        device_id: stored.device.device_id,
        machine_id: stored.device.machine_id,
        device_public_key: stored.device.device_public_key,
        device_private_key: stored.device.device_private_key
      });
      token = bound.token;
      refreshToken = bound.refresh_token;
      if (bound.token_expires_at) expiresAt = Date.parse(bound.token_expires_at) || expiresAt;
    } catch (e) { /* 绑定失败不阻断，后续签到/调度会再尝试 */ }
    const out = {
      token,
      refresh_token: refreshToken,
      device_id: stored.device.device_id,
      machine_id: stored.device.machine_id,
      device_public_key: stored.device.device_public_key,
      device_private_key: stored.device.device_private_key,
      uid: parsed.uid,
      name: parsed.name,
      token_expires_at: expiresAt ? new Date(expiresAt).toISOString() : null
    };
    return { ok: true, ...out };
  } catch (e) {
    return { ok: false, error: e.message || '解析回调链接失败' };
  }
}

// 解析用户粘贴的回调链接（远程部署兜底），返回 Token / Refresh Token / 到期时间
router.post('/accounts/oauth/trae/callback', requireAuth, async (req, res) => {
  const tempId = String(req.body.tempId || '').trim();
  const callbackUrl = String(req.body.callback_url || '').trim();
  const r = await traeResolveCallback(tempId, callbackUrl);
  if (r.ok) oauthTempStore.delete(tempId);
  res.json(r);
});

// 无缝回调：Trae 登录成功后重定向到此（仅本地访问生效）
// 解析 userJwt → 设备绑定 → 通知 opener（postMessage）并跳回账号页
router.get('/authorize', async (req, res) => {
  // tempId 通过 cookie 传递（回调 URL 必须干净，否则 Trae 授权页报网络错误）
  const tempId = String(req.cookies.trae_oauth_temp || '').trim();
  // 从原始 URL 重建完整回调链接（含 userJwt / userInfo 等参数）
  const callbackUrl = req.protocol + '://' + req.get('host') + req.originalUrl;
  const r = await traeResolveCallback(tempId, callbackUrl);
  if (r.ok) {
    // 暂存结果（2 分钟），供前端读取
    oauthTempStore.set(tempId, { ...oauthTempStore.get(tempId), result: r, resultExpiresAt: Date.now() + 2 * 60 * 1000 });
    res.clearCookie('trae_oauth_temp');
  }
  const ok = r.ok;
  const msg = ok ? 'Trae 授权成功，正在返回账号页…' : ('授权失败：' + (r.error || '未知错误'));
  const backHref = ok ? `/accounts?oauth_done=${encodeURIComponent(tempId)}` : '/accounts';
  res.send(`<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>Trae 授权</title>
<style>body{font-family:-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f4f6fb;color:#1f2937}
.card{background:#fff;border:1px solid #e5e9f2;border-radius:12px;padding:32px 40px;max-width:420px;text-align:center;box-shadow:0 1px 3px rgba(16,24,40,.06)}
.icon{font-size:40px;margin-bottom:12px}h2{margin:0 0 8px;font-size:20px}p{margin:0;color:#6b7280;font-size:14px;line-height:1.6}
.btn{margin-top:20px;display:inline-block;padding:8px 20px;background:#4f6ef7;color:#fff;border-radius:8px;text-decoration:none;font-size:14px}</style></head>
<body><div class="card"><div class="icon">${ok ? '✅' : '❌'}</div><h2>${ok ? '授权成功' : '授权失败'}</h2><p>${msg}</p>
${ok ? '<p style="margin-top:12px">页面将自动返回账号页…</p>' : ''}
<a class="btn" href="${backHref}">${ok ? '立即返回' : '返回账号页'}</a></div>
<script>
${ok ? `try{if(window.opener){window.opener.postMessage({type:'trae_oauth_done',tempId:'${tempId}'},'*');}setTimeout(function(){location.href='${backHref}';},1200);}catch(e){location.href='${backHref}';}` : ''}
</script></body></html>`);
});

// 前端获取无缝回调的解析结果（轮询 + 回传都会调用，不立即删除，靠 TTL 过期）
router.get('/accounts/oauth/trae/result', requireAuth, (req, res) => {
  const tempId = String(req.query.tempId || '').trim();
  const stored = oauthTempStore.get(tempId);
  if (!stored) return res.json({ ok: false, error: '授权会话已过期' });
  if (stored.result) {
    if (Date.now() > (stored.resultExpiresAt || 0)) {
      oauthTempStore.delete(tempId);
      return res.json({ ok: false, error: '结果已过期，请重新授权' });
    }
    return res.json(stored.result);
  }
  res.json({ ok: false, pending: true });
});

function getOwnAccount(req) {
  return db.prepare('SELECT * FROM accounts WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.user.id);
}

router.post('/accounts/:id/delete', requireAuth, (req, res) => {
  const acc = getOwnAccount(req);
  if (!acc) return res.redirect(back('/accounts', '账号不存在', 'err'));
  db.prepare('DELETE FROM accounts WHERE id = ?').run(acc.id);
  db.prepare('DELETE FROM logs WHERE account_id = ?').run(acc.id);
  auditReq(req, 'account_delete', `删除平台账号「${acc.name}」（${acc.platform}）`);
  res.redirect(back('/accounts', `「${acc.name}」已删除`));
});

router.post('/accounts/:id/checkin', requireAuth, async (req, res) => {
  const acc = getOwnAccount(req);
  if (!acc) return res.redirect(back('/accounts', '账号不存在', 'err'));
  const result = await runCheckin(acc, 'manual');
  auditReq(req, 'checkin_manual', `手动签到「${acc.name}」（${acc.platform}）：${result.message}`);
  res.redirect(back('/accounts', `「${acc.name}」${result.message}`, result.success ? 'ok' : 'err'));
});

router.post('/accounts/:id/reauth', requireAuth, (req, res) => {
  const acc = getOwnAccount(req);
  if (!acc) return res.redirect(back('/accounts', '账号不存在', 'err'));
  const cred = collectCredentials(req, acc.platform);
  if (!cred) return res.redirect(back('/accounts', '请完整填写平台必填凭据', 'err'));
  const wantAutoRenew = req.body.auto_renew === '1' || req.body.auto_renew === 'on';
  const autoRenew = !!(wantAutoRenew && cred.refresh_token);
  const tokenExpiresAt = cred.token_expires_at || null;
  delete cred.token_expires_at;
  const a = authorizeFields(cred, { autoRenew });
  db.prepare(`UPDATE accounts SET credentials=?, status=?, authorized_at=?, expires_at=?, auto_renew=?, token_expires_at=? WHERE id=?`)
    .run(a.credentials, a.status, a.authorized_at, a.expires_at, autoRenew ? 1 : 0, tokenExpiresAt, acc.id);
  auditReq(req, 'account_reauth', `重新授权平台账号「${acc.name}」（${acc.platform}）${autoRenew ? '，自动续期' : ''}`);
  res.redirect(back('/accounts', `「${acc.name}」重新授权成功${autoRenew ? '，已开启自动续期' : '，授权期已刷新为 7 天'}`));
});

router.post('/accounts/:id/time', requireAuth, (req, res) => {
  const acc = getOwnAccount(req);
  if (!acc) return res.redirect(back('/accounts', '账号不存在', 'err'));
  const time = (req.body.checkin_time || '').trim();
  if (!isValidHHMM(time)) return res.redirect(back('/accounts', '签到时间格式应为 HH:MM', 'err'));
  db.prepare('UPDATE accounts SET checkin_time = ? WHERE id = ?').run(time, acc.id);
  res.redirect(back('/accounts', `「${acc.name}」每日签到时间已更新为 ${time}`));
});

router.post('/accounts/:id/toggle', requireAuth, (req, res) => {
  const acc = getOwnAccount(req);
  if (!acc) return res.redirect(back('/accounts', '账号不存在', 'err'));
  if (acc.status === 'expired') return res.redirect(back('/accounts', '授权已过期，请先重新授权', 'err'));
  const next = acc.status === 'active' ? 'disabled' : 'active';
  db.prepare('UPDATE accounts SET status = ? WHERE id = ?').run(next, acc.id);
  res.redirect(back('/accounts', `「${acc.name}」已${next === 'active' ? '启用' : '暂停'}`));
});

// ---------- 签到记录管理（仅限本人记录） ----------
router.post('/logs/:id/delete', requireAuth, (req, res) => {
  const r = db.prepare('DELETE FROM logs WHERE id = ? AND user_id = ?')
    .run(req.params.id, req.user.id);
  if (!r.changes) return res.redirect(back('/logs', '记录不存在或无权删除', 'err'));
  auditReq(req, 'log_delete', `删除签到记录 #${req.params.id}`);
  res.redirect(back('/logs', '记录已删除'));
});

router.post('/logs/delete', requireAuth, (req, res) => {
  const ids = idList(req.body.ids);
  if (!ids.length) return res.redirect(back('/logs', '请先选择要删除的记录', 'err'));
  const placeholders = ids.map(() => '?').join(',');
  const r = db.prepare(`DELETE FROM logs WHERE user_id = ? AND id IN (${placeholders})`)
    .run(req.user.id, ...ids);
  auditReq(req, 'log_delete', `批量删除自己的签到记录 ${r.changes} 条`);
  res.redirect(back('/logs', `已删除 ${r.changes} 条记录`));
});

// ---------- 通知 ----------
router.post('/notifications/:id/read', requireAuth, (req, res) => {
  db.prepare('UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  res.redirect('/notifications');
});

router.post('/notifications/read-all', requireAuth, (req, res) => {
  db.prepare('UPDATE notifications SET is_read = 1 WHERE user_id = ?').run(req.user.id);
  res.redirect('/notifications');
});

// ---------- 管理后台（仅管理员） ----------
router.post('/admin/settings', requireAdmin, (req, res) => {
  const siteName = (req.body.site_name || '').trim() || 'AI 签到助手';
  const time = (req.body.default_checkin_time || '08:00').trim();
  const timezone = (req.body.timezone || config.DEFAULT_TIMEZONE).trim();
  if (!isValidHHMM(time)) return res.redirect(back('/admin', '签到时间格式应为 HH:MM', 'err'));
  if (!isValidTimezone(timezone)) return res.redirect(back('/admin', '无效的时区', 'err'));
  setSetting('site_name', siteName);
  setSetting('default_checkin_time', time);
  setSetting('timezone', timezone);
  setSetting('allow_register', req.body.allow_register === '1' ? '1' : '0');
  setSetting('internal_port', (req.body.internal_port || '').trim() || String(config.PORT));
  setSetting('external_port', (req.body.external_port || '').trim());
  auditReq(req, 'settings_update', `更新全局设置：站点名称「${siteName}」、默认签到时间 ${time}、时区 ${timezone}`);
  res.redirect(back('/admin', '设置已保存'));
});

router.post('/admin/users/:id/op', requireAdmin, (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!target) return res.redirect(back('/admin', '用户不存在', 'err'));
  const op = req.body.op;
  const adminCount = db.prepare(`SELECT COUNT(*) AS c FROM users WHERE is_admin = 1 AND status = 'active'`).get().c;

  if (op === 'disable') {
    if (target.id === req.user.id) return res.redirect(back('/admin', '不能禁用自己', 'err'));
    if (target.is_admin && adminCount <= 1) return res.redirect(back('/admin', '不能禁用最后一个管理员', 'err'));
    db.prepare(`UPDATE users SET status = 'disabled' WHERE id = ?`).run(target.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(target.id);
    auditReq(req, 'user_disable', `禁用用户「${target.username}」`);
    return res.redirect(back('/admin', `用户「${target.username}」已禁用`));
  }
  if (op === 'enable') {
    db.prepare(`UPDATE users SET status = 'active' WHERE id = ?`).run(target.id);
    auditReq(req, 'user_enable', `启用用户「${target.username}」`);
    return res.redirect(back('/admin', `用户「${target.username}」已启用`));
  }
  if (op === 'delete') {
    if (target.id === req.user.id) return res.redirect(back('/admin', '不能删除自己', 'err'));
    if (target.is_admin && adminCount <= 1) return res.redirect(back('/admin', '不能删除最后一个管理员', 'err'));
    db.prepare('DELETE FROM users WHERE id = ?').run(target.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(target.id);
    db.prepare('DELETE FROM accounts WHERE user_id = ?').run(target.id);
    db.prepare('DELETE FROM notifications WHERE user_id = ?').run(target.id);
    db.prepare('DELETE FROM logs WHERE user_id = ?').run(target.id);
    db.prepare('DELETE FROM password_resets WHERE user_id = ?').run(target.id);
    auditReq(req, 'user_delete', `删除用户「${target.username}」及其全部数据`);
    return res.redirect(back('/admin', `用户「${target.username}」已删除`));
  }
  if (op === 'resetpw') {
    const pw = req.body.new_password || '';
    if (pw.length < 6) return res.redirect(back('/admin', '新密码至少 6 位', 'err'));
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(pw), target.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(target.id);
    auditReq(req, 'user_resetpw', `重置用户「${target.username}」的密码`);
    return res.redirect(back('/admin', `用户「${target.username}」密码已重置`));
  }
  res.redirect(back('/admin', '未知操作', 'err'));
});

// ---------- 操作日志管理（仅管理员） ----------
router.post('/admin/logs/:id/delete', requireAdmin, (req, res) => {
  const r = db.prepare('DELETE FROM audit_logs WHERE id = ?').run(req.params.id);
  if (!r.changes) return res.redirect(back('/admin/logs', '日志不存在', 'err'));
  auditReq(req, 'audit_delete', `删除操作日志 #${req.params.id}`);
  res.redirect(back('/admin/logs', '日志已删除'));
});

router.post('/admin/logs/delete', requireAdmin, (req, res) => {
  const ids = idList(req.body.ids);
  if (!ids.length) return res.redirect(back('/admin/logs', '请先选择要删除的日志', 'err'));
  const placeholders = ids.map(() => '?').join(',');
  const r = db.prepare(`DELETE FROM audit_logs WHERE id IN (${placeholders})`).run(...ids);
  auditReq(req, 'audit_delete', `删除操作日志 ${r.changes} 条`);
  res.redirect(back('/admin/logs', `已删除 ${r.changes} 条日志`));
});

router.post('/admin/logs/clear', requireAdmin, (req, res) => {
  const r = db.prepare('DELETE FROM audit_logs').run();
  writeAudit({
    userId: req.user.id, username: req.user.username, action: 'audit_clear',
    detail: `清空操作日志（${r.changes} 条）`, ip: clientIp(req)
  });
  res.redirect(back('/admin/logs', '操作日志已清空'));
});

// ---------- 系统通知 / 全局公告（仅管理员） ----------
router.post('/admin/broadcasts', requireAdmin, (req, res) => {
  const title = (req.body.title || '').trim();
  const content = (req.body.content || '').trim();
  const level = ['info', 'warn', 'err'].includes(req.body.level) ? req.body.level : 'info';
  if (!title) return res.redirect(back('/admin/notifications', '请填写通知标题', 'err'));
  if (title.length > 80) return res.redirect(back('/admin/notifications', '标题不能超过 80 个字符', 'err'));

  const now = getNow();
  const info = db.prepare(
    'INSERT INTO broadcasts(title, content, level, recipients, created_by, created_at) VALUES(?,?,?,?,?,?)'
  ).run(title, content, level, 0, req.user.id, now);
  const bid = Number(info.lastInsertRowid);
  const users = db.prepare(`SELECT id FROM users WHERE status = 'active'`).all();
  for (const u of users) notify(u.id, 'system', title, content, bid, level);
  db.prepare('UPDATE broadcasts SET recipients = ? WHERE id = ?').run(users.length, bid);

  auditReq(req, 'broadcast_create', `发布全局通知「${title}」，接收 ${users.length} 人`);
  res.redirect(back('/admin/notifications', `全局通知已发布，送达 ${users.length} 位用户`));
});

router.post('/admin/broadcasts/:id', requireAdmin, (req, res) => {
  const b = db.prepare('SELECT * FROM broadcasts WHERE id = ?').get(req.params.id);
  if (!b) return res.redirect(back('/admin/notifications', '通知不存在', 'err'));
  const title = (req.body.title || '').trim();
  const content = (req.body.content || '').trim();
  const level = ['info', 'warn', 'err'].includes(req.body.level) ? req.body.level : 'info';
  if (!title) return res.redirect(back('/admin/notifications', '请填写通知标题', 'err'));
  if (title.length > 80) return res.redirect(back('/admin/notifications', '标题不能超过 80 个字符', 'err'));

  db.prepare('UPDATE broadcasts SET title = ?, content = ?, level = ?, updated_at = ? WHERE id = ?')
    .run(title, content, level, getNow(), b.id);
  db.prepare('UPDATE notifications SET title = ?, content = ?, level = ? WHERE broadcast_id = ?')
    .run(title, content, level, b.id);

  auditReq(req, 'broadcast_update', `编辑全局通知「${title}」（#${b.id}）`);
  res.redirect(back('/admin/notifications', '通知已更新'));
});

router.post('/admin/broadcasts/:id/delete', requireAdmin, (req, res) => {
  const b = db.prepare('SELECT * FROM broadcasts WHERE id = ?').get(req.params.id);
  if (!b) return res.redirect(back('/admin/notifications', '通知不存在', 'err'));
  db.prepare('DELETE FROM notifications WHERE broadcast_id = ?').run(b.id);
  db.prepare('DELETE FROM broadcasts WHERE id = ?').run(b.id);
  auditReq(req, 'broadcast_delete', `删除全局通知「${b.title}」（#${b.id}）`);
  res.redirect(back('/admin/notifications', '通知已删除'));
});

// ---------- 通知记录管理（仅管理员，可删除任意通知，含欢迎通知等系统消息） ----------
router.post('/admin/notifications/:id/delete', requireAdmin, (req, res) => {
  const target = req.body.from === 'list' ? '/notifications' : '/admin/notifications';
  const n = db.prepare('SELECT * FROM notifications WHERE id = ?').get(req.params.id);
  if (!n) return res.redirect(back(target, '通知不存在', 'err'));
  db.prepare('DELETE FROM notifications WHERE id = ?').run(n.id);
  auditReq(req, 'notification_delete', `删除通知「${n.title}」（#${n.id}，用户 #${n.user_id}）`);
  res.redirect(back(target, '通知已删除'));
});

router.post('/admin/notifications/delete', requireAdmin, (req, res) => {
  const ids = idList(req.body.ids);
  if (!ids.length) return res.redirect(back('/admin/notifications', '请先选择要删除的通知', 'err'));
  const placeholders = ids.map(() => '?').join(',');
  const r = db.prepare(`DELETE FROM notifications WHERE id IN (${placeholders})`).run(...ids);
  auditReq(req, 'notification_delete', `批量删除通知 ${r.changes} 条`);
  res.redirect(back('/admin/notifications', `已删除 ${r.changes} 条通知`));
});

module.exports = router;
