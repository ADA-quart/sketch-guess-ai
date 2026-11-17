'use strict';
/**
 * 2 小时压力测试客户端（也可缩短用于冒烟测试）
 *   node scripts/stress-test.js --minutes=120 --clients=3 --host=127.0.0.1 --port=3000
 *
 * 模拟 1~N 台平板，每 400ms 上传一帧 160×160 灰度 PNG，同时挂一个display客户端。
 * 每 30 秒向 /api/status 取一次服务端统计并打印，用于确认：
 *   - framesDropped 持续增长（说明丢旧帧策略生效，队列没有堆积）
 *   - heapUsed / rss 不持续单调上升（说明张量与帧缓冲被正确回收）
 *   - errors 不增长
 */
const WebSocket = require('ws');
const http = require('http');
const { PNG } = require('pngjs');

function arg(name, def) {
  const hit = process.argv.find(a => a.startsWith('--' + name + '='));
  return hit ? hit.split('=')[1] : def;
}

const MINUTES = Number(arg('minutes', 120));
const CLIENTS = Number(arg('clients', 1));
const HOST = arg('host', '127.0.0.1');
const PORT = Number(arg('port', 3000));
const SIZE = 160;

function makeFrame(seed) {
  const png = new PNG({ width: SIZE, height: SIZE });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = 255; png.data[i + 1] = 255; png.data[i + 2] = 255; png.data[i + 3] = 255;
  }
  const t = Date.now() / 300 + seed;
  for (let k = 0; k < 28; k++) {
    const cx = Math.floor(SIZE / 2 + Math.sin(t + k) * 42);
    const cy = Math.floor(SIZE / 2 + Math.cos(t * 0.8 + k) * 42);
    for (let dy = -5; dy <= 5; dy++) {
      for (let dx = -5; dx <= 5; dx++) {
        if (dx * dx + dy * dy > 25) continue;
        const x = cx + dx, y = cy + dy;
        if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) continue;
        const p = (y * SIZE + x) * 4;
        png.data[p] = 0; png.data[p + 1] = 0; png.data[p + 2] = 0;
      }
    }
  }
  return PNG.sync.write(png).toString('base64');
}

// 序列路线：生成一段随时间变化的笔画（若干条折线），模拟真人作画
function makeStrokes(seed) {
  const t = Date.now() / 400 + seed;
  const strokes = [];
  for (let s = 0; s < 3; s++) {
    const points = [];
    const cx = SIZE / 2 + Math.sin(t + s) * 40;
    const cy = SIZE / 2 + Math.cos(t * 0.8 + s) * 40;
    for (let i = 0; i < 24; i++) {
      const a = i / 24 * Math.PI * 2;
      points.push([cx + Math.cos(a) * (20 + s * 8), cy + Math.sin(a) * (20 + s * 8)]);
    }
    strokes.push({ points });
  }
  return strokes;
}

let ENGINE = 'raster';
function detectEngine() {
  return new Promise(resolve => {
    http.get(`http://${HOST}:${PORT}/api/config`, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try { ENGINE = JSON.parse(raw).engine || JSON.parse(raw).route || 'raster'; } catch (e) {}
        resolve();
      });
    }).on('error', () => resolve());
  });
}

function getStatus() {
  return new Promise((resolve, reject) => {
    http.get(`http://${HOST}:${PORT}/api/status`, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

const sockets = [];
let framesSent = 0;
let roundNo = 0;

function startDrawClient(i) {
  const ws = new WebSocket(`ws://${HOST}:${PORT}/ws/draw`);
  sockets.push(ws);
  ws.on('open', () => {
    console.log(`[client ${i}] 已连接`);
    const timer = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (ENGINE === 'sequence') {
        ws.send(JSON.stringify({ type: 'strokes', seq: ++framesSent, ts: Date.now(), strokes: makeStrokes(i) }));
      } else {
        ws.send(JSON.stringify({ type: 'frame', seq: ++framesSent, ts: Date.now(), w: SIZE, png: makeFrame(i) }));
      }
    }, 400);
    ws.on('close', () => clearInterval(timer));
  });
  ws.on('message', data => {
    let m; try { m = JSON.parse(data.toString()); } catch (e) { return; }
    if (m.type === 'hello' && !m.round.active) {
      fetchJson('/api/start', {});
    }
    if (m.type === 'roundEnd') roundNo++;
  });
  ws.on('error', () => {});
  ws.on('close', () => setTimeout(() => startDrawClient(i), 1000));
}

function fetchJson(pathname, body) {
  const data = JSON.stringify(body);
  const req = http.request({
    host: HOST, port: PORT, path: pathname, method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
  }, res => res.resume());
  req.on('error', () => {});
  req.end(data);
}

// 一个模拟大屏，验证广播链路
const display = new WebSocket(`ws://${HOST}:${PORT}/ws/display`);
display.on('error', () => {});
display.on('close', () => setTimeout(() => {}, 1000));

detectEngine().then(() => {
  console.log(`[engine] ${ENGINE}`);
  for (let i = 0; i < CLIENTS; i++) startDrawClient(i);
});

const started = Date.now();
const endAt = started + MINUTES * 60000;
console.log(`压力测试开始：${MINUTES} 分钟，${CLIENTS} 个平板模拟客户端，目标 ${HOST}:${PORT}`);

const reportTimer = setInterval(async () => {
  try {
    const s = await getStatus();
    const elapsed = Math.round((Date.now() - started) / 1000);
    const remain = Math.max(0, Math.round((endAt - Date.now()) / 1000));
    console.log(
      `[${elapsed}s / 剩余${remain}s] route=${s.route} 入帧=${s.stats.framesIn} 丢弃=${s.stats.framesDropped} ` +
      `推理=${s.stats.inferences} 均耗时=${s.stats.avgInferMs}ms 错误=${s.stats.errors} ` +
      `heap=${s.memMB.heapUsed}MB rss=${s.memMB.rss}MB 本地已发=${framesSent} 完成回合=${roundNo}`
    );
  } catch (e) {
    console.log('[report] 获取状态失败：' + e.message);
  }
}, 30000);

setTimeout(() => {
  clearInterval(reportTimer);
  sockets.forEach(s => { try { s.close(); } catch (e) {} });
  try { display.close(); } catch (e) {}
  console.log('压力测试时间到，客户端已关闭。请查看 /api/status 与服务端日志。');
}, MINUTES * 60000);
