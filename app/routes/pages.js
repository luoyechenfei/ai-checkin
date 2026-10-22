'use strict';
const express = require('express');
const router = express.Router();
const config = require('../config');
const { db, getSetting, getNow } = require('../db');
const { REGISTRY, platformOptions } = require('../platforms');
const { daysLeft } = require('../util');
const { requireAuth, requireAdmin } = require('../security');

function unreadCount(userId) {
  return db.prepare('SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND is_read = 0').get(userId).c;
}

/** 统一渲染：注入公共模板变量 */
function render(req, res, view, locals = {}) {
  res.render(view, Object.assign({
    user: req.user,
    siteName: getSetting('site_name', 'AI 签到助手'),
    unread: req.user ? unreadCount(req.user.id) : 0,
    msg: req.query.msg || null,
    msgType: req.query.type === 'err' ? 'err' : 'ok'
  }, locals));
}

function platformName(id) {
  return REGISTRY[id] ? REGISTRY[id].name : id;
}

/** 给账号列表补充展示字段 */
function decorateAccount(a, now) {
  const platform = REGISTRY[a.platform] || { name: a.platform };
  let days = null;
  if (a.status === 'active' && a.expires_at) days = daysLeft(now, a.expires_at);
  return Object.assign({}, a, {
    platformName: platform.name,
    daysLeft: days,
    expired: a.status === 'expired' || (days !== null && days <= 0)
  });
}

// ---------- 首页 → 仪表盘 ----------
router.get('/', (req, res) => {
  res.redirect(req.user ? '/dashboard' : '/login');
});

// ---------- 初始化向导（仅首次，无管理员时） ----------
router.get('/setup', (req, res) => {
  const n = db.prepare('SELECT COUNT(*) AS c FROM users WHERE is_admin = 1').get().c;
  if (n > 0) return res.redirect('/login');
  render(req, res, 'setup', {
    title: '初始化',
    internalPort: config.PORT,
    defaultTime: '08:00'
  });
});

// ---------- 登录 / 注册 ----------
router.get('/login', (req, res) => {
  if (req.user) return res.redirect('/dashboard');
  const allowRegister = getSetting('allow_register', '0') === '1';
  render(req, res, 'login', { title: '登录', allowRegister });
});

router.get('/register', (req, res) => {
  if (req.user) return res.redirect('/dashboard');
  if (getSetting('allow_register', '0') !== '1') {
    return res.redirect('/login?msg=' + encodeURIComponent('当前未开放注册，请联系管理员') + '&type=err');
  }
  render(req, res, 'register', { title: '注册' });
});

// ---------- 仪表盘 ----------
router.get('/dashboard', requireAuth, (req, res) => {
  const now = getNow();
  const uid = req.user.id;
  const today = now.slice(0, 10);

  const accounts = db.prepare('SELECT * FROM accounts WHERE user_id = ? ORDER BY created_at DESC').all(uid)
    .map(a => decorateAccount(a, now));

  const stats = {
    total: accounts.length,
    active: accounts.filter(a => a.status === 'active').length,
    expired: accounts.filter(a => a.expired && a.status !== 'disabled').length,
    todayDone: db.prepare(
      `SELECT COUNT(DISTINCT account_id) AS c FROM logs
       WHERE user_id = ? AND success = 1 AND substr(created_at, 1, 10) = ?`).get(uid, today).c
  };

  const pointRow = db.prepare(
    `SELECT COALESCE(SUM(points), 0) AS total,
            COALESCE(SUM(CASE WHEN substr(created_at, 1, 10) = ? THEN points ELSE 0 END), 0) AS today
     FROM logs WHERE user_id = ? AND success = 1`).get(today, uid);
  stats.todayPoints = pointRow.today;
  stats.totalPoints = pointRow.total;

  const recentLogs = db.prepare(
    `SELECT l.*, a.name AS account_name FROM logs l
     LEFT JOIN accounts a ON a.id = l.account_id
     WHERE l.user_id = ? ORDER BY l.id DESC LIMIT 10`).all(uid)
    .map(l => Object.assign({}, l, { platformName: platformName(l.platform) }));

  const upcoming = accounts
    .filter(a => a.status === 'active')
    .sort((a, b) => (a.checkin_time > b.checkin_time ? 1 : -1))
    .slice(0, 6);

  render(req, res, 'dashboard', { title: '仪表盘', stats, accounts, recentLogs, upcoming });
});

// ---------- 平台账号 ----------
router.get('/accounts', requireAuth, (req, res) => {
  const now = getNow();
  const accounts = db.prepare('SELECT * FROM accounts WHERE user_id = ? ORDER BY created_at DESC').all(req.user.id)
    .map(a => decorateAccount(a, now));
  // 每个账号累计获得的积分
  const sums = db.prepare(
    `SELECT account_id, COALESCE(SUM(points), 0) AS points FROM logs
     WHERE user_id = ? AND success = 1 AND account_id IS NOT NULL GROUP BY account_id`).all(req.user.id);
  const pointMap = {};
  for (const s of sums) pointMap[s.account_id] = s.points;
  for (const a of accounts) a.points = pointMap[a.id] || 0;
  render(req, res, 'accounts', {
    title: '平台账号',
    accounts,
    platforms: platformOptions(),
    registry: REGISTRY
  });
});

// ---------- 签到记录 ----------
router.get('/logs', requireAuth, (req, res) => {
  const platform = req.query.platform || '';
  const status = req.query.status || '';
  let sql = `SELECT l.*, a.name AS account_name FROM logs l
             LEFT JOIN accounts a ON a.id = l.account_id WHERE l.user_id = ?`;
  const params = [req.user.id];
  if (platform) { sql += ' AND platform = ?'; params.push(platform); }
  if (status === 'ok') sql += ' AND success = 1';
  if (status === 'fail') sql += ' AND success = 0';
  sql += ' ORDER BY id DESC LIMIT 200';
  const logs = db.prepare(sql).all(...params)
    .map(l => Object.assign({}, l, { platformName: platformName(l.platform) }));
  render(req, res, 'logs', {
    title: '签到记录', logs,
    filterPlatform: platform, filterStatus: status,
    platforms: platformOptions()
  });
});

// ---------- 通知 ----------
router.get('/notifications', requireAuth, (req, res) => {
  const list = db.prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 200').all(req.user.id);
  render(req, res, 'notifications', { title: '通知', list });
});

// ---------- 管理后台 ----------
router.get('/admin', requireAuth, requireAdmin, (req, res) => {
  const now = getNow();
  const users = db.prepare(`
    SELECT u.*,
      (SELECT COUNT(*) FROM accounts a WHERE a.user_id = u.id) AS account_count
    FROM users u ORDER BY u.is_admin DESC, u.id ASC`).all()
    .map(u => Object.assign({}, u, { is_admin: !!u.is_admin }));
  const s = {
    site_name: getSetting('site_name', 'AI 签到助手'),
    default_checkin_time: getSetting('default_checkin_time', '08:00'),
    timezone: getSetting('timezone', config.DEFAULT_TIMEZONE),
    allow_register: getSetting('allow_register', '0'),
    external_port: getSetting('external_port', ''),
    internal_port: getSetting('internal_port', String(config.PORT))
  };
  const accounts = db.prepare(`
    SELECT a.*, u.username FROM accounts a
    LEFT JOIN users u ON u.id = a.user_id
    ORDER BY a.id DESC LIMIT 100`).all()
    .map(a => decorateAccount(a, now));
  render(req, res, 'admin', { title: '管理后台', users, settings: s, accounts, registry: REGISTRY });
});

module.exports = router;
