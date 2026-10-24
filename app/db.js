'use strict';
const { DatabaseSync } = require('node:sqlite');
const config = require('./config');

const db = new DatabaseSync(config.DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  is_admin      INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'active', -- active | disabled
  theme         TEXT NOT NULL DEFAULT 'auto',   -- auto | light | dark
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS accounts (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id        INTEGER NOT NULL,
  platform       TEXT NOT NULL,              -- trae | workbuddy | codebuddy | custom
  name           TEXT NOT NULL,              -- 备注名称
  credentials    TEXT NOT NULL DEFAULT '{}', -- JSON，各平台凭据字段
  status         TEXT NOT NULL DEFAULT 'active', -- active | expired | disabled
  authorized_at  TEXT,
  expires_at     TEXT,                       -- authorized_at + 7 天
  checkin_time   TEXT NOT NULL DEFAULT '08:00',
  last_checkin_at TEXT,
  last_result    TEXT,
  created_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER,
  user_id    INTEGER NOT NULL,
  platform   TEXT NOT NULL,
  success    INTEGER NOT NULL,               -- 1 成功 0 失败
  message    TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notifications (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL,
  type         TEXT NOT NULL,                  -- session_expired | checkin_failed | system
  title        TEXT NOT NULL,
  content      TEXT,
  broadcast_id INTEGER,                        -- 全局公告 fan-out 来源（管理员广播）
  level        TEXT NOT NULL DEFAULT 'info',   -- info | warn | err
  is_read      INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL
);

-- 管理员全局公告（发布时复制给每个用户，编辑/删除同步到对应的通知）
CREATE TABLE IF NOT EXISTS broadcasts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  title      TEXT NOT NULL,
  content    TEXT,
  level      TEXT NOT NULL DEFAULT 'info',     -- info | warn | err
  recipients INTEGER NOT NULL DEFAULT 0,       -- 发布时的接收人数
  created_by INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT
);

-- 操作日志（仅管理员可见/可管理）
CREATE TABLE IF NOT EXISTS audit_logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER,
  username   TEXT,
  action     TEXT NOT NULL,
  detail     TEXT,
  ip         TEXT,
  created_at TEXT NOT NULL
);

-- 找回密码的一次性令牌（10 分钟有效，回答 3 个安全问题全部正确后才可重置）
CREATE TABLE IF NOT EXISTS password_resets (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL,
  verified   INTEGER NOT NULL DEFAULT 0,   -- 0 待回答问题 1 已通过验证
  attempts   INTEGER NOT NULL DEFAULT 0,   -- 答案错误次数（最多 5 次）
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
`);

/** 增量迁移：为旧数据库补列（SQLite 无 ADD COLUMN IF NOT EXISTS） */
function ensureColumn(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some(c => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
// 签到获得的积分（REAL 兼容小数积分；拿不到积分的平台记 0）
ensureColumn('logs', 'points', 'REAL NOT NULL DEFAULT 0');
// 用户主题偏好：auto（跟随系统）/ light / dark
ensureColumn('users', 'theme', "TEXT NOT NULL DEFAULT 'auto'");
// 通知关联的全局公告 ID
ensureColumn('notifications', 'broadcast_id', 'INTEGER');
// 通知级别（系统广播使用 info/warn/err 区分普通、重要、紧急）
ensureColumn('notifications', 'level', "TEXT NOT NULL DEFAULT 'info'");
// 找回密码的 3 个安全问题与答案（答案以 scrypt 哈希存储）
for (let i = 1; i <= 3; i++) {
  ensureColumn('users', `sec_q${i}`, 'TEXT');
  ensureColumn('users', `sec_a${i}`, 'TEXT');
}

// 索引必须在补列迁移之后创建（旧库的 notifications 表可能还没有 broadcast_id）
db.exec(`
CREATE INDEX IF NOT EXISTS idx_accounts_user ON accounts(user_id);
CREATE INDEX IF NOT EXISTS idx_logs_user ON logs(user_id);
CREATE INDEX IF NOT EXISTS idx_logs_account ON logs(account_id);
CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, is_read);
CREATE INDEX IF NOT EXISTS idx_notif_broadcast ON notifications(broadcast_id);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at);
`);

function getSetting(key, fallback) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

function setSetting(key, value) {
  db.prepare(
    'INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, value == null ? '' : String(value));
}

function allSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const map = {};
  for (const r of rows) map[r.key] = r.value;
  return map;
}

function notify(userId, type, title, content, broadcastId = null, level = 'info') {
  db.prepare(
    'INSERT INTO notifications(user_id, type, title, content, broadcast_id, level, created_at) VALUES(?,?,?,?,?,?,?)'
  ).run(userId, type, title, content || '', broadcastId, level, getNow());
}

/** 写操作日志（管理员可见）。失败不影响主流程 */
function writeAudit({ userId = null, username = null, action, detail = '', ip = '' }) {
  try {
    db.prepare(
      'INSERT INTO audit_logs(user_id, username, action, detail, ip, created_at) VALUES(?,?,?,?,?,?)'
    ).run(userId, username, action, detail || '', ip || '', getNow());
  } catch (e) {
    console.error('[audit] 写入失败:', e.message);
  }
}

/** 从请求上下文写操作日志：自动带当前用户与来源 IP */
function auditReq(req, action, detail = '') {
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    (req.socket && req.socket.remoteAddress) || '';
  writeAudit({
    userId: req.user ? req.user.id : null,
    username: req.user ? req.user.username : '',
    action, detail, ip
  });
}

// 当前时间统一由调用方传入时区设置，这里提供一个默认便捷函数
const { zonedNow } = require('./util');
function getNow() {
  return zonedNow(getSetting('timezone', config.DEFAULT_TIMEZONE));
}

module.exports = { db, getSetting, setSetting, allSettings, notify, getNow, writeAudit, auditReq };
