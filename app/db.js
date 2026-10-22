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
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL,
  type       TEXT NOT NULL,                  -- session_expired | checkin_failed | system
  title      TEXT NOT NULL,
  content    TEXT,
  is_read    INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_accounts_user ON accounts(user_id);
CREATE INDEX IF NOT EXISTS idx_logs_user ON logs(user_id);
CREATE INDEX IF NOT EXISTS idx_logs_account ON logs(account_id);
CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, is_read);
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

function notify(userId, type, title, content) {
  db.prepare(
    'INSERT INTO notifications(user_id, type, title, content, created_at) VALUES(?,?,?,?,?)'
  ).run(userId, type, title, content || '', getNow());
}

// 当前时间统一由调用方传入时区设置，这里提供一个默认便捷函数
const { zonedNow } = require('./util');
function getNow() {
  return zonedNow(getSetting('timezone', config.DEFAULT_TIMEZONE));
}

module.exports = { db, getSetting, setSetting, allSettings, notify, getNow };
