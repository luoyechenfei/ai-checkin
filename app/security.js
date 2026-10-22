'use strict';
const crypto = require('crypto');
const config = require('./config');
const { db, getNow } = require('./db');

// ---------- 密码哈希（scrypt，无需原生依赖） ----------
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt:${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  try {
    const [scheme, salt, hash] = String(stored).split(':');
    if (scheme !== 'scrypt' || !salt || !hash) return false;
    const calc = crypto.scryptSync(password, salt, 64);
    const expect = Buffer.from(hash, 'hex');
    return calc.length === expect.length && crypto.timingSafeEqual(calc, expect);
  } catch (e) {
    return false;
  }
}

// ---------- Web 登录会话 ----------
function createSession(res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = getNow();
  const expires = addDays(now, config.WEB_SESSION_DAYS);
  db.prepare('INSERT INTO sessions(token, user_id, created_at, expires_at) VALUES(?,?,?,?)')
    .run(token, userId, now, expires);
  res.cookie(config.SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: config.WEB_SESSION_DAYS * 86400000
  });
}

function destroySession(req, res) {
  const token = req.cookies && req.cookies[config.SESSION_COOKIE];
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  res.clearCookie(config.SESSION_COOKIE);
}

function purgeExpiredSessions() {
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(getNow());
}

// ---------- 中间件 ----------
function attachUser(req, res, next) {
  req.user = null;
  const token = req.cookies && req.cookies[config.SESSION_COOKIE];
  if (token) {
    const row = db.prepare(`
      SELECT u.id, u.username, u.is_admin, u.status, s.expires_at
      FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token = ?`).get(token);
    if (row) {
      if (row.status !== 'active' || row.expires_at <= getNow()) {
        db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
      } else {
        req.user = { id: row.id, username: row.username, isAdmin: !!row.is_admin };
      }
    }
  }
  next();
}

// 未完成初始化时，除 /setup 外全部跳转到初始化向导
function requireSetup(req, res, next) {
  const n = db.prepare('SELECT COUNT(*) AS c FROM users WHERE is_admin = 1').get().c;
  if (n === 0) {
    if (req.path === '/setup' || req.path.startsWith('/public')) return next();
    return res.redirect('/setup');
  }
  if (req.path === '/setup') return res.redirect('/login');
  next();
}

function requireAuth(req, res, next) {
  if (!req.user) {
    if (req.accepts('html')) return res.redirect('/login');
    return res.status(401).json({ error: '未登录' });
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user || !req.user.isAdmin) return res.status(403).send('需要管理员权限');
  next();
}

function addDays(dateStr, days) {
  const d = new Date(dateStr.replace(' ', 'T'));
  d.setDate(d.getDate() + days);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

module.exports = {
  hashPassword, verifyPassword,
  createSession, destroySession, purgeExpiredSessions,
  attachUser, requireSetup, requireAuth, requireAdmin,
  addDays
};
