'use strict';
/**
 * 轻量图形验证码（内存存储，5 分钟有效，一次性使用）
 * - 生成 4 位大写字符 + 干扰线与噪点，输出 SVG
 * - 登录 / 注册必须携带 captcha_id 与 captcha_code
 */
const crypto = require('crypto');

const TTL_MS = 5 * 60 * 1000;
const MAX_ITEMS = 5000;
const CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const COLORS = ['#2c3e50', '#1f4e79', '#4b2e83', '#7a2e2e', '#155e4b', '#8a4b08'];

const store = new Map();

function sweep() {
  const now = Date.now();
  for (const [id, item] of store) {
    if (item.exp <= now) store.delete(id);
  }
  // 极端情况下防止内存无限增长
  if (store.size > MAX_ITEMS) {
    const keys = [...store.keys()].slice(0, store.size - MAX_ITEMS);
    for (const k of keys) store.delete(k);
  }
}

/** 新建验证码，返回 { id, code } */
function create() {
  sweep();
  const id = crypto.randomBytes(12).toString('hex');
  let code = '';
  for (let i = 0; i < 4; i++) code += CHARS[crypto.randomInt(CHARS.length)];
  store.set(id, { code, exp: Date.now() + TTL_MS });
  return { id, code };
}

/** 取验证码内容（用于绘制 SVG） */
function get(id) {
  const item = store.get(String(id || ''));
  if (!item) return null;
  if (item.exp <= Date.now()) {
    store.delete(String(id));
    return null;
  }
  return item;
}

/** 校验并立即作废；不区分大小写 */
function verify(id, input) {
  const key = String(id || '');
  const item = store.get(key);
  if (!item) return false;
  store.delete(key);
  if (item.exp <= Date.now()) return false;
  return String(input || '').trim().toUpperCase() === item.code;
}

function rand(min, max) {
  return min + Math.random() * (max - min);
}

/** 生成验证码 SVG */
function svg(code) {
  let noise = '';
  for (let i = 0; i < 5; i++) {
    noise += `<line x1="${rand(0, 120).toFixed(1)}" y1="${rand(0, 44).toFixed(1)}" x2="${rand(0, 120).toFixed(1)}" y2="${rand(0, 44).toFixed(1)}" stroke="${COLORS[i % COLORS.length]}" stroke-width="1" opacity="0.35"/>`;
  }
  for (let i = 0; i < 28; i++) {
    noise += `<circle cx="${rand(0, 120).toFixed(1)}" cy="${rand(0, 44).toFixed(1)}" r="${rand(0.6, 1.6).toFixed(1)}" fill="${COLORS[i % COLORS.length]}" opacity="0.5"/>`;
  }
  let text = '';
  for (let i = 0; i < code.length; i++) {
    const x = 16 + i * 26 + rand(-2, 2);
    const y = 30 + rand(-4, 4);
    const rot = rand(-22, 22).toFixed(1);
    const color = COLORS[Math.floor(Math.random() * COLORS.length)];
    text += `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" font-family="Arial, Helvetica, sans-serif" font-size="26" font-weight="700" fill="${color}" transform="rotate(${rot} ${x.toFixed(1)} ${y.toFixed(1)})">${code[i]}</text>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="44" viewBox="0 0 120 44" role="img" aria-label="验证码">` +
    `<rect width="120" height="44" rx="8" fill="#eef2f9"/>${noise}${text}</svg>`;
}

module.exports = { create, get, verify, svg };
