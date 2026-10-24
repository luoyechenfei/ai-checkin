'use strict';
const express = require('express');
const router = express.Router();
const config = require('../config');
const { db, getSetting, setSetting, notify, getNow, auditReq, writeAudit } = require('../db');
const { REGISTRY, platformOptions, runCheckin, authorizeFields } = require('../platforms');
const { isValidTimezone, isValidHHMM } = require('../util');
const {
  hashPassword, verifyPassword, createSession, destroySession,
  requireAuth, requireAdmin
} = require('../security');
const captcha = require('../captcha');

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

/** 从表单中按适配器字段定义收集凭据 */
function collectCredentials(req, platformId) {
  const adapter = REGISTRY[platformId];
  if (!adapter) return null;
  const cred = {};
  for (const f of adapter.fields) {
    const raw = req.body[`f_${f.key}`];
    // 值可能是数组（同名字段重复提交）或非字符串，统一转字符串再 trim
    const v = String(Array.isArray(raw) ? raw[raw.length - 1] : (raw ?? '')).trim();
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

  const a = authorizeFields(cred);
  db.prepare(`INSERT INTO accounts(user_id, platform, name, credentials, status, authorized_at, expires_at, checkin_time, created_at)
              VALUES(?,?,?,?,?,?,?,?,?)`)
    .run(req.user.id, platform, name, a.credentials, a.status, a.authorized_at, a.expires_at, time, getNow());
  auditReq(req, 'account_add', `添加平台账号「${name}」（${platform}）`);
  res.redirect(back('/accounts', `「${name}」添加成功，授权将保持 7 天，到期自动提醒`));
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
  const a = authorizeFields(cred);
  db.prepare(`UPDATE accounts SET credentials=?, status=?, authorized_at=?, expires_at=? WHERE id=?`)
    .run(a.credentials, a.status, a.authorized_at, a.expires_at, acc.id);
  auditReq(req, 'account_reauth', `重新授权平台账号「${acc.name}」（${acc.platform}）`);
  res.redirect(back('/accounts', `「${acc.name}」重新授权成功，授权期已刷新为 7 天`));
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

module.exports = router;
