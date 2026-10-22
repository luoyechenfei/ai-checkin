'use strict';
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

module.exports = {
  ROOT,
  DATA_DIR,
  DB_PATH: path.join(DATA_DIR, 'checkin.db'),
  // 内部端口：容器内监听端口（可用环境变量 INTERNAL_PORT 覆盖）
  PORT: parseInt(process.env.INTERNAL_PORT || process.env.PORT || '3000', 10),
  HOST: process.env.HOST || '0.0.0.0',
  SESSION_COOKIE: 'aic_session',
  // Web 登录会话有效期（天）
  WEB_SESSION_DAYS: 30,
  // 平台授权保持天数，到期自动登出并提示（需求：一周后登出并提示）
  AUTH_KEEP_DAYS: 7,
  // 调度器轮询间隔（秒）
  TICK_SECONDS: 30,
  DEFAULT_TIMEZONE: 'Asia/Shanghai'
};
