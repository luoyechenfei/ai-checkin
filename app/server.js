'use strict';
const express = require('express');
const path = require('path');
const config = require('./config');
const { attachUser, requireSetup } = require('./security');
const scheduler = require('./scheduler');

const app = express();
app.disable('x-powered-by');
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// 轻量 Cookie 解析（避免额外依赖）
app.use((req, res, next) => {
  req.cookies = {};
  const raw = req.headers.cookie;
  if (raw) {
    for (const part of raw.split(';')) {
      const i = part.indexOf('=');
      if (i > 0) {
        try {
          req.cookies[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
        } catch (e) { /* 忽略非法编码 */ }
      }
    }
  }
  next();
});

app.use('/public', express.static(path.join(__dirname, 'public'), { maxAge: '1d' }));

app.use(attachUser);
app.use(requireSetup);

app.use(require('./routes/pages'));
app.use(require('./routes/actions'));

// 404
app.use((req, res) => {
  if (req.user) return res.status(404).send('页面不存在');
  res.redirect('/login');
});

// 错误处理
app.use((err, req, res, next) => {
  console.error('[server] error:', err.stack || err.message);
  res.status(500).send('服务器内部错误：' + err.message);
});

app.listen(config.PORT, config.HOST, () => {
  console.log(`==============================================`);
  console.log(`  AI 签到助手已启动`);
  console.log(`  内部端口: ${config.PORT}  监听地址: ${config.HOST}`);
  console.log(`  数据目录: ${config.DATA_DIR}`);
  console.log(`==============================================`);
  scheduler.start();
});

process.on('SIGINT', () => { scheduler.stop(); process.exit(0); });
process.on('SIGTERM', () => { scheduler.stop(); process.exit(0); });
