'use strict';
const express = require('express');
const router = express.Router();
const config = require('../config');
const { db, getSetting, setSetting, notify, getNow } = require('../db');
const { REGISTRY, platformOptions, runCheckin, authorizeFields } = require('../platforms');
const { isValidTimezone, isValidHHMM } = require('../util');
const { hashPassword, verifyPassword, createSession, destroySession } = require('../security');

const back = (path, msg, type) =>
  `${path}?msg=${encodeURIComponent(msg)}&type=${type === 'err' ? 'err' : 'ok'}`;

/** 从表单中按适配器字段定义收集凭据 */
function collectCredentials(req, platformId) {
  const adapter = REGISTRY[platformId];
  if (!adapter) return null;
  const cred = {};
  for (const f of adapter.fields) {
    const v = (req.body[`f_${f.key}`] || '').trim();
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
  createSession(res, user.id);
  res.redirect(back('/dashboard', '初始化完成，欢迎使用！'));
});

// ---------- 登录 / 注册 / 登出 ----------
router.post('/login', (req, res) => {
  const username = (req.body.username || '').trim();
  const password = req.body.password || '';
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || !verifyPassword(password, user.password_hash)) {
    return res.redirect(back('/login', '用户名或密码错误', 'err'));
  }
  if (user.status !== 'active') return res.redirect(back('/login', '该账号已被禁用', 'err'));
  createSession(res, user.id);
  res.redirect('/dashboard');
});

router.post('/register', (req, res) => {
  if (getSetting('allow_register', '0') !== '1') return res.redirect(back('/login', '当前未开放注册', 'err'));
  const username = (req.body.username || '').trim();
  const password = req.body.password || '';
  const password2 = req.body.password2 || '';
  if (username.length < 2 || username.length > 32) return res.redirect(back('/register', '用户名需 2-32 个字符', 'err'));
  if (password.length < 6) return res.redirect(back('/register', '密码至少 6 位', 'err'));
  if (password !== password2) return res.redirect(back('/register', '两次输入的密码不一致', 'err'));
  const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (exists) return res.redirect(back('/register', '用户名已存在', 'err'));
  const info = db.prepare('INSERT INTO users(username, password_hash, is_admin, created_at) VALUES(?,?,0,?)')
    .run(username, hashPassword(password), getNow());
  createSession(res, Number(info.lastInsertRowid));
  res.redirect(back('/dashboard', '注册成功，欢迎！请先添加平台账号。'));
});

router.post('/logout', (req, res) => {
  destroySession(req, res);
  res.redirect('/login?msg=' + encodeURIComponent('已退出登录'));
});

// ---------- 平台账号 ----------
router.post('/accounts', (req, res) => {
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
  res.redirect(back('/accounts', `「${name}」添加成功，授权将保持 7 天，到期自动提醒`));
});

function getOwnAccount(req) {
  return db.prepare('SELECT * FROM accounts WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.user.id);
}

router.post('/accounts/:id/delete', (req, res) => {
  const acc = getOwnAccount(req);
  if (!acc) return res.redirect(back('/accounts', '账号不存在', 'err'));
  db.prepare('DELETE FROM accounts WHERE id = ?').run(acc.id);
  db.prepare('DELETE FROM logs WHERE account_id = ?').run(acc.id);
  res.redirect(back('/accounts', `「${acc.name}」已删除`));
});

router.post('/accounts/:id/checkin', async (req, res) => {
  const acc = getOwnAccount(req);
  if (!acc) return res.redirect(back('/accounts', '账号不存在', 'err'));
  const result = await runCheckin(acc, 'manual');
  res.redirect(back('/accounts', `「${acc.name}」${result.message}`, result.success ? 'ok' : 'err'));
});

router.post('/accounts/:id/reauth', (req, res) => {
  const acc = getOwnAccount(req);
  if (!acc) return res.redirect(back('/accounts', '账号不存在', 'err'));
  const cred = collectCredentials(req, acc.platform);
  if (!cred) return res.redirect(back('/accounts', '请完整填写平台必填凭据', 'err'));
  const a = authorizeFields(cred);
  db.prepare(`UPDATE accounts SET credentials=?, status=?, authorized_at=?, expires_at=? WHERE id=?`)
    .run(a.credentials, a.status, a.authorized_at, a.expires_at, acc.id);
  res.redirect(back('/accounts', `「${acc.name}」重新授权成功，授权期已刷新为 7 天`));
});

router.post('/accounts/:id/time', (req, res) => {
  const acc = getOwnAccount(req);
  if (!acc) return res.redirect(back('/accounts', '账号不存在', 'err'));
  const time = (req.body.checkin_time || '').trim();
  if (!isValidHHMM(time)) return res.redirect(back('/accounts', '签到时间格式应为 HH:MM', 'err'));
  db.prepare('UPDATE accounts SET checkin_time = ? WHERE id = ?').run(time, acc.id);
  res.redirect(back('/accounts', `「${acc.name}」每日签到时间已更新为 ${time}`));
});

router.post('/accounts/:id/toggle', (req, res) => {
  const acc = getOwnAccount(req);
  if (!acc) return res.redirect(back('/accounts', '账号不存在', 'err'));
  if (acc.status === 'expired') return res.redirect(back('/accounts', '授权已过期，请先重新授权', 'err'));
  const next = acc.status === 'active' ? 'disabled' : 'active';
  db.prepare('UPDATE accounts SET status = ? WHERE id = ?').run(next, acc.id);
  res.redirect(back('/accounts', `「${acc.name}」已${next === 'active' ? '启用' : '暂停'}`));
});

// ---------- 通知 ----------
router.post('/notifications/:id/read', (req, res) => {
  db.prepare('UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  res.redirect('/notifications');
});

router.post('/notifications/read-all', (req, res) => {
  db.prepare('UPDATE notifications SET is_read = 1 WHERE user_id = ?').run(req.user.id);
  res.redirect('/notifications');
});

// ---------- 管理后台 ----------
router.post('/admin/settings', (req, res) => {
  if (!req.user || !req.user.isAdmin) return res.status(403).send('需要管理员权限');
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
  res.redirect(back('/admin', '设置已保存'));
});

router.post('/admin/users/:id/op', (req, res) => {
  if (!req.user || !req.user.isAdmin) return res.status(403).send('需要管理员权限');
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!target) return res.redirect(back('/admin', '用户不存在', 'err'));
  const op = req.body.op;
  const adminCount = db.prepare(`SELECT COUNT(*) AS c FROM users WHERE is_admin = 1 AND status = 'active'`).get().c;

  if (op === 'disable') {
    if (target.id === req.user.id) return res.redirect(back('/admin', '不能禁用自己', 'err'));
    if (target.is_admin && adminCount <= 1) return res.redirect(back('/admin', '不能禁用最后一个管理员', 'err'));
    db.prepare(`UPDATE users SET status = 'disabled' WHERE id = ?`).run(target.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(target.id);
    return res.redirect(back('/admin', `用户「${target.username}」已禁用`));
  }
  if (op === 'enable') {
    db.prepare(`UPDATE users SET status = 'active' WHERE id = ?`).run(target.id);
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
    return res.redirect(back('/admin', `用户「${target.username}」已删除`));
  }
  if (op === 'resetpw') {
    const pw = req.body.new_password || '';
    if (pw.length < 6) return res.redirect(back('/admin', '新密码至少 6 位', 'err'));
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(pw), target.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(target.id);
    return res.redirect(back('/admin', `用户「${target.username}」密码已重置`));
  }
  res.redirect(back('/admin', '未知操作', 'err'));
});

module.exports = router;
