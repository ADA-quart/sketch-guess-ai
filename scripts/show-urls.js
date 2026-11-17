'use strict';
// 启动时打印所有可直接访问的网址（笔记本用 127.0.0.1，平板用局域网 IP）
const os = require('os');
const cfg = require('../config/config.json');
const port = Number(cfg.server.port) || 3000;
const ips = new Set(['127.0.0.1']);
for (const name of Object.keys(os.networkInterfaces())) {
  for (const it of (os.networkInterfaces()[name] || [])) {
    if (it.family === 'IPv4' && !it.internal) ips.add(it.address);
  }
}
const pages = [
  ['本机入口页', '/'],
  ['平板作画', '/draw'],
  ['大屏展示', '/display'],
  ['主持控制', '/host'],
  ['规则投屏', '/rules'],
  ['神经显微镜', '/science'],
  ['运行状态', '/api/status']
];
const pad = s => ' '.repeat(Math.max(0, 12 - s.length * 2));
console.log('');
console.log('  服务已启动，浏览器打开下面任意网址：');
console.log('');
console.log('  笔记本本机：');
for (const [name, path] of pages) console.log('    ' + name + pad(name) + 'http://127.0.0.1:' + port + path);
for (const ip of ips) {
  if (ip === '127.0.0.1') continue;
  console.log('');
  console.log('  平板 / 同局域网设备（用这个 IP，不要用 localhost）：');
  for (const [name, path] of pages) console.log('    ' + name + pad(name) + 'http://' + ip + ':' + port + path);
}
console.log('');
