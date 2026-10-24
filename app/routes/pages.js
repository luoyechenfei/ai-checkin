'use strict';
const express = require('express');
const router = express.Router();
const config = require('../config');
const { db, getSetting, getNow } = require('../db');
const { REGISTRY, platformOptions } = require('../platforms');
const { daysLeft } = require('../util');
const { requireAuth, requireAdmin } = require('../security');
const captcha = require('../captcha');

const PER_PAGE = 50;

function unreadCount(userId) {
  return db.prepare('SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND is_read = 0').get(userId).c;
}

/** 计算分页信息（每页默认 50 条） */
function pageInfo(req, total, perPage = PER_PAGE) {
  const pages = Math.max(1, Math.ceil(total / perPage));
  let page = parseInt(req.query.page, 10) || 1;
  if (page < 1) page = 1;
  if (page > pages) page = pages;
  return { page, pages, perPage, total, offset: (page - 1) * perPage };
}

/** 统一渲染：注入公共模板变量 */
function render(req, res, view, locals = {}) {
  res.render(view, Object.assign({
    user: req.user,
    siteName: getSetting('site_name', 'AI 签到助手'),
    unread: req.user ? unreadCount(req.user.id) : 0,
    themeMode: req.user ? (req.user.theme || 'auto') : 'auto',
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

// ---------- 验证码 ----------
router.get('/captcha/new', (req, res) => {
  const c = captcha.create();
  res.set('Cache-Control', 'no-store');
  res.json({ id: c.id, svg: captcha.svg(c.code) });
});

router.get('/captcha/:id.svg', (req, res) => {
  const item = captcha.get(req.params.id);
  if (!item) {
    res.status(404).set('Cache-Control', 'no-store').type('text/plain').send('验证码已过期，请点击刷新');
    return;
  }
  res.set('Cache-Control', 'no-store');
  res.type('image/svg+xml').send(captcha.svg(item.code));
});

// ---------- 登录 / 注册 ----------
router.get('/login', (req, res) => {
  if (req.user) return res.redirect('/dashboard');
  const allowRegister = getSetting('allow_register', '0') === '1';
  const c = captcha.create();
  render(req, res, 'login', { title: '登录', allowRegister, captchaId: c.id });
});

router.get('/register', (req, res) => {
  if (req.user) return res.redirect('/dashboard');
  if (getSetting('allow_register', '0') !== '1') {
    return res.redirect('/login?msg=' + encodeURIComponent('当前未开放注册，请联系管理员') + '&type=err');
  }
  const c = captcha.create();
  render(req, res, 'register', { title: '注册', captchaId: c.id });
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
  let where = 'WHERE l.user_id = ?';
  const params = [req.user.id];
  if (platform) { where += ' AND l.platform = ?'; params.push(platform); }
  if (status === 'ok') where += ' AND l.success = 1';
  if (status === 'fail') where += ' AND l.success = 0';

  const total = db.prepare(`SELECT COUNT(*) AS c FROM logs l ${where}`).get(...params).c;
  const p = pageInfo(req, total);
  const logs = db.prepare(
    `SELECT l.*, a.name AS account_name FROM logs l
     LEFT JOIN accounts a ON a.id = l.account_id
     ${where} ORDER BY l.id DESC LIMIT ? OFFSET ?`).all(...params, p.perPage, p.offset)
    .map(l => Object.assign({}, l, { platformName: platformName(l.platform) }));

  // 分页链接保留筛选条件
  const qs = [];
  if (platform) qs.push('platform=' + encodeURIComponent(platform));
  if (status) qs.push('status=' + encodeURIComponent(status));

  render(req, res, 'logs', {
    title: '签到记录', logs,
    filterPlatform: platform, filterStatus: status,
    platforms: platformOptions(),
    page: p.page, pages: p.pages, total, perPage: p.perPage,
    queryBase: qs.length ? '&' + qs.join('&') : ''
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

// ---------- 管理后台：操作日志（仅管理员） ----------
router.get('/admin/logs', requireAuth, requireAdmin, (req, res) => {
  const q = (req.query.q || '').trim();
  const action = (req.query.action || '').trim();
  const conds = [];
  const params = [];
  if (q) {
    conds.push('(username LIKE ? OR detail LIKE ? OR ip LIKE ?)');
    params.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  if (action) { conds.push('action = ?'); params.push(action); }
  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';

  const total = db.prepare(`SELECT COUNT(*) AS c FROM audit_logs ${where}`).get(...params).c;
  const p = pageInfo(req, total);
  const rows = db.prepare(
    `SELECT * FROM audit_logs ${where} ORDER BY id DESC LIMIT ? OFFSET ?`)
    .all(...params, p.perPage, p.offset);
  const actions = db.prepare(
    'SELECT action, COUNT(*) AS c FROM audit_logs GROUP BY action ORDER BY c DESC').all();
  const qs = [];
  if (q) qs.push('q=' + encodeURIComponent(q));
  if (action) qs.push('action=' + encodeURIComponent(action));

  render(req, res, 'admin-logs', {
    title: '操作日志',
    rows, actions,
    q, filterAction: action,
    page: p.page, pages: p.pages, total, perPage: p.perPage,
    queryBase: qs.length ? '&' + qs.join('&') : ''
  });
});

// ---------- 管理后台：系统通知（仅管理员） ----------
router.get('/admin/notifications', requireAuth, requireAdmin, (req, res) => {
  const broadcasts = db.prepare('SELECT * FROM broadcasts ORDER BY id DESC LIMIT 100').all();
  const userCount = db.prepare(`SELECT COUNT(*) AS c FROM users WHERE status = 'active'`).get().c;
  // 全部通知记录（含欢迎通知等系统消息），管理员可逐条或批量删除
  const total = db.prepare('SELECT COUNT(*) AS c FROM notifications').get().c;
  const p = pageInfo(req, total);
  const notices = db.prepare(`
    SELECT n.*, u.username FROM notifications n
    LEFT JOIN users u ON u.id = n.user_id
    ORDER BY n.id DESC LIMIT ? OFFSET ?`).all(p.perPage, p.offset);
  render(req, res, 'admin-notifications', {
    title: '系统通知', broadcasts, userCount,
    notices, page: p.page, pages: p.pages, total, perPage: p.perPage
  });
});

module.exports = router;
