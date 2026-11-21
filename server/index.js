'use strict';
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { WebSocketServer, WebSocket } = require('ws');
const { PNG } = require('pngjs');

const { ROOT, config, categories, words } = require('./config');
const { InferenceEngine } = require('./inference');
const { SequenceEngine } = require('./sequence-inference');
const { Probe, LAYER_META } = require('./probe');
const players = require('./players');

const PUBLIC = path.join(ROOT, 'public');
const ENGINE_LOG = [];
function log(msg) {
  const line = `[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${msg}`;
  console.log(line);
  ENGINE_LOG.push(line);
  if (ENGINE_LOG.length > 200) ENGINE_LOG.shift();
}
players.setLogger(log);

// engine: 根据配置选择推理引擎。sequence=CRNN V2 笔画序列(默认)，其余=旧栅格模型
const useSequence = (config.inference.engine || 'raster') === 'sequence';
const engine = useSequence
  ? new SequenceEngine(config, categories, log)
  : new InferenceEngine(config, categories, log);
const drawClients = new Set();
const displayClients = new Set();
const hostClients = new Set();
const scienceClients = new Set();   // 科普页 /science

// 科普探针（对战引擎就绪后初始化，失败不影响对战）
const probe = new Probe(engine, config, log);
let lastProbe = null;                // 最近一次探针快照，供新接入的科普页立即拿到
let displayView = 'play';            // 大屏当前视图：'play' 对战 / 'rules' 规则投放

const stats = {
  framesIn: 0,
  framesDropped: 0,
  inferences: 0,
  inferMsLast: 0,
  inferMsTotal: 0,
  errors: 0,
  guessesSent: 0
};

const scoreboard = { ai: 0, human: 0, rounds: 0, draws: 0 };

// 游戏模式：'classic'（系统出题的常规对战）/ 'free'（自由模式：画手自由画，
// 画手口头告诉主持人自己画的是什么，主持人对照 AI 猜测裁定是否同一种）。
// 运行时状态，不落盘；重启回到 config 默认值。
let gameMode = config.round.gameMode === 'free' ? 'free' : 'classic';
const VALID_MODES = new Set(['classic', 'free']);

// 从灰度帧生成小缩略图，供大屏展示"AI 看到的画面"
function makeThumb(gray, srcSize, outSize) {
  const png = new PNG({ width: outSize, height: outSize });
  const scale = srcSize / outSize;
  for (let y = 0; y < outSize; y++) {
    const y0 = Math.floor(y * scale), y1 = Math.min(srcSize, Math.ceil((y + 1) * scale));
    for (let x = 0; x < outSize; x++) {
      const x0 = Math.floor(x * scale), x1 = Math.min(srcSize, Math.ceil((x + 1) * scale));
      let sum = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) {
        const row = yy * srcSize;
        for (let xx = x0; xx < x1; xx++) { sum += gray[row + xx]; n++; }
      }
      const v = n ? Math.round(sum / n) : 255;
      const p = (y * outSize + x) * 4;
      png.data[p] = v; png.data[p + 1] = v; png.data[p + 2] = v; png.data[p + 3] = 255;
    }
  }
  return PNG.sync.write(png).toString('base64');
}

// 从笔画坐标序列渲染一张小缩略图，供大屏展示"AI 看到的画面"。
// strokes: [{points:[[x,y],...]}, ...]，坐标是画布像素。
function thumbFromStrokes(strokes, outSize) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const s of strokes || []) {
    for (const p of (s.points || [])) {
      const x = Number(p[0]) || 0, y = Number(p[1]) || 0;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
  }
  if (!isFinite(minX)) return null;
  const w = maxX - minX, h = maxY - minY, s = Math.max(w, h) || 1;
  const pad = outSize * 0.1;
  const area = outSize - pad * 2;
  const png = new PNG({ width: outSize, height: outSize });
  for (let i = 0; i < outSize * outSize; i++) {
    png.data[i * 4] = 255; png.data[i * 4 + 1] = 255; png.data[i * 4 + 2] = 255; png.data[i * 4 + 3] = 255;
  }
  const plot = (x, y) => {
    const px = Math.round(pad + ((x - minX) / s) * area);
    const py = Math.round(pad + ((y - minY) / s) * area);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = px + dx, yy = py + dy;
      if (xx >= 0 && xx < outSize && yy >= 0 && yy < outSize) {
        const o = (yy * outSize + xx) * 4;
        png.data[o] = 0; png.data[o + 1] = 0; png.data[o + 2] = 0;
      }
    }
  };
  for (const stroke of strokes || []) {
    const pts = stroke.points || [];
    for (let i = 0; i < pts.length; i++) {
      if (i === 0) { plot(pts[i][0], pts[i][1]); continue; }
      const x0 = pts[i - 1][0], y0 = pts[i - 1][1], x1 = pts[i][0], y1 = pts[i][1];
      const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0)));
      for (let k = 0; k <= steps; k++) {
        plot(x0 + (x1 - x0) * k / steps, y0 + (y1 - y0) * k / steps);
      }
    }
  }
  return PNG.sync.write(png).toString('base64');
}

let round = {
  active: false,
  id: 0,
  seconds: config.round.seconds,
  startTime: 0,
  endTime: 0,
  target: null,
  playerId: null,
  player: null,
  top5: [],
  locked: false,
  lockCount: 0,
  lockTopIndex: -1,
  result: null,
  endTimer: null,
  lockTimer: null,
  judgeTimer: null,
  awaitingJudge: false,
  // 自由模式专用：本轮画手自述的“我画的是什么”，以及对 AI 猜测的裁定
  selfReport: null,     // 主持人录入的画手自述文本
  judgeVerdict: null    // 'same'（同一种，AI 得分）/ 'diff'（不同种，人类得分）
};

/* ------------------------------------------------------------------ */
/* HTTP                                                                */
/* ------------------------------------------------------------------ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.ico': 'image/x-icon'
};

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function serveFile(res, filePath) {
  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404 Not Found');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': 'no-store'
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', c => {
      raw += c;
      if (raw.length > 1e6) reject(new Error('请求体过大'));
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch (e) {
    return sendJSON(res, 400, { error: 'bad url' });
  }

  // ---------- API ----------
  if (pathname === '/api/status') {
    const m = process.memoryUsage();
    return sendJSON(res, 200, {
      route: engine.route,
      attempts: engine.attempts,
      log: ENGINE_LOG.slice(-20),
      decoyMode: config.inference.decoyMode,
      scoringMode: config.round.scoringMode,
      gameMode,
      inputSize: engine.size,
      clients: { draw: drawClients.size, display: displayClients.size, host: hostClients.size },
      round: {
        active: round.active, id: round.id, endTime: round.endTime,
        mode: round.mode,
        target: round.target ? round.target.word : null,
        locked: round.locked, result: round.result, top5: round.top5,
        awaitingJudge: round.awaitingJudge,
        selfReport: round.selfReport, judgeVerdict: round.judgeVerdict
      },
      scoreboard,
      players: players.snapshot(),
      science: { ready: probe.ready, clients: scienceClients.size },
      stats: {
        ...stats,
        avgInferMs: stats.inferences ? Math.round(stats.inferMsTotal / stats.inferences) : 0
      },
      memMB: {
        rss: Math.round(m.rss / 1048576),
        heapUsed: Math.round(m.heapUsed / 1048576)
      }
    });
  }

  if (pathname === '/api/config') {
    return sendJSON(res, 200, {
      round: config.round,
      inference: {
        engine: config.inference.engine || 'raster',
        intervalMs: config.inference.intervalMs,
        topK: config.inference.topK,
        decoyMode: config.inference.decoyMode,
        inputSize: config.inference.inputSize,
        dilateRadius: config.inference.dilateRadius
      },
      tablet: config.tablet,
      display: config.display,
      scoringMode: config.round.scoringMode,
      gameMode,
      engine: config.inference.engine || 'raster',
      route: engine.route
    });
  }

  // 游戏模式：读取 / 切换。切换只影响后续回合，进行中的回合不受影响。
  if (pathname === '/api/mode' && req.method === 'GET') {
    return sendJSON(res, 200, { ok: true, gameMode });
  }
  if (pathname === '/api/mode' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const next = body.gameMode || body.mode;
      if (!VALID_MODES.has(next)) return sendJSON(res, 400, { ok: false, error: 'invalid mode' });
      setGameMode(next);
      return sendJSON(res, 200, { ok: true, gameMode });
    } catch (e) {
      return sendJSON(res, 400, { ok: false, error: e.message });
    }
  }

  if (pathname === '/api/labels') return sendJSON(res, 200, engine.labelsForApi());
  if (pathname === '/api/words') return sendJSON(res, 200, words);

  // 本机所有可访问地址，供首页展示完整网址（含平板要用的局域网 IP）
  if (pathname === '/api/hosts') {
    const port = Number(config.server.port) || 3000;
    const ips = new Set(['127.0.0.1']);
    const ifaces = os.networkInterfaces();
    for (const name of Object.keys(ifaces)) {
      for (const it of (ifaces[name] || [])) {
        if (it.family === 'IPv4' && !it.internal) ips.add(it.address);
      }
    }
    return sendJSON(res, 200, { port, ips: Array.from(ips), host: config.server.host });
  }

  if (pathname === '/api/players' && req.method === 'GET') {
    return sendJSON(res, 200, players.snapshot());
  }
  if (pathname === '/api/players/add' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const r = players.add(body.name);
      if (r.ok) broadcastPlayers();
      return sendJSON(res, r.ok ? 200 : 400, r);
    } catch (e) { return sendJSON(res, 400, { ok: false, error: e.message }); }
  }
  if (pathname === '/api/players/remove' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const r = players.remove(body.id);
      if (r.ok) broadcastPlayers();
      return sendJSON(res, r.ok ? 200 : 400, r);
    } catch (e) { return sendJSON(res, 400, { ok: false, error: e.message }); }
  }
  if (pathname === '/api/players/select' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const r = players.select(body.id);
      if (r.ok) broadcastPlayers();
      return sendJSON(res, r.ok ? 200 : 400, r);
    } catch (e) { return sendJSON(res, 400, { ok: false, error: e.message }); }
  }
  if (pathname === '/api/players/autorotate' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const r = players.setAutoRotate(body.enabled);
      broadcastPlayers();
      return sendJSON(res, 200, r);
    } catch (e) { return sendJSON(res, 400, { ok: false, error: e.message }); }
  }
  if (pathname === '/api/players/clear' && req.method === 'POST') {
    const r = players.clear();
    broadcastPlayers();
    return sendJSON(res, 200, r);
  }

  if (pathname === '/api/view' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      displayView = body.view === 'rules' ? 'rules' : 'play';
      broadcast(displayClients, { type: 'view', view: displayView });
      return sendJSON(res, 200, { ok: true, view: displayView });
    } catch (e) { return sendJSON(res, 400, { ok: false, error: e.message }); }
  }

  if (pathname === '/api/start' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      startRound(body.word || body.class || null);
      return sendJSON(res, 200, { ok: true, round: publicRound() });
    } catch (e) {
      return sendJSON(res, 400, { ok: false, error: e.message });
    }
  }

  if (pathname === '/api/lock' && req.method === 'POST') {
    if (round.active && !round.awaitingJudge) endRound('host');
    return sendJSON(res, 200, { ok: true });
  }

  // 自由模式：主持人录入画手自述（"画手说自己画的是什么"）
  if (pathname === '/api/report' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const ok = submitReport(String(body.report || '').trim());
      return sendJSON(res, ok ? 200 : 400, { ok });
    } catch (e) {
      return sendJSON(res, 400, { ok: false, error: e.message });
    }
  }

  // 裁定：classic 用 verdict=like/unlike；free 用 verdict=same/diff
  if (pathname === '/api/judge' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const verdict = (body.verdict === 'like' || body.verdict === 'unlike' ||
                       body.verdict === 'same' || body.verdict === 'diff' ||
                       body.verdict === 'skip')
                      ? body.verdict : null;
      // 自由模式：裁定与自述一并提交，避免两次请求竞态导致自述丢失
      if ((verdict === 'same' || verdict === 'diff') && typeof body.report === 'string' && body.report.trim()) {
        round.selfReport = body.report.trim().slice(0, 60);
      }
      const ok = judgeRound(verdict);
      return sendJSON(res, ok ? 200 : 400, { ok });
    } catch (e) {
      return sendJSON(res, 400, { ok: false, error: e.message });
    }
  }

  if (pathname === '/api/reset' && req.method === 'POST') {
    resetRound();
    return sendJSON(res, 200, { ok: true });
  }

  // ---------- 静态资源 ----------
  if (pathname === '/') return serveFile(res, path.join(PUBLIC, 'index.html'));

  if (pathname === '/vendor/tf.min.js') {
    const p = path.join(ROOT, 'node_modules', '@tensorflow', 'tfjs', 'dist', 'tf.min.js');
    if (!fs.existsSync(p)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('未安装 @tensorflow/tfjs，无法使用路线③');
    }
    return serveFile(res, p);
  }

  if (pathname.startsWith('/model/')) {
    const rel = pathname.slice('/model/'.length);
    if (rel.includes('..') || rel.includes('/') && rel.split('/').includes('..')) {
      return sendJSON(res, 403, { error: 'forbidden' });
    }
    return serveFile(res, path.join(ROOT, 'model', rel));
  }

  let safe = pathname.replace(/^\/+/, '').replace(/\\/g, '/');
  // /draw → draw.html，/display → display.html，/host → host.html
  if (safe && !path.extname(safe)) safe += '.html';
  const filePath = path.resolve(PUBLIC, safe);
  if (!filePath.startsWith(PUBLIC + path.sep) && filePath !== PUBLIC) {
    return sendJSON(res, 403, { error: 'forbidden' });
  }
  return serveFile(res, filePath);
});

/* ------------------------------------------------------------------ */
/* WebSocket                                                           */
/* ------------------------------------------------------------------ */

const wssDraw = new WebSocketServer({ noServer: true });
const wssDisplay = new WebSocketServer({ noServer: true });
const wssHost = new WebSocketServer({ noServer: true });
const wssScience = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  let pathname;
  try {
    pathname = new URL(req.url, 'http://localhost').pathname;
  } catch (e) {
    return socket.destroy();
  }
  const map = {
    '/ws/draw': wssDraw,
    '/ws/display': wssDisplay,
    '/ws/host': wssHost,
    '/ws/science': wssScience
  };
  const wss = map[pathname];
  if (!wss) return socket.destroy();
  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
});

function broadcast(set, obj) {
  const text = JSON.stringify(obj);
  for (const ws of set) {
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.send(text); } catch (e) { /* 单个客户端异常不影响广播 */ }
    }
  }
}

// 把选手名单/排名广播到所有端
function broadcastPlayers() {
  const payload = { type: 'players', ...players.snapshot() };
  broadcast(displayClients, payload);
  broadcast(drawClients, payload);
  broadcast(hostClients, payload);
  broadcast(scienceClients, payload);
}

// 科普探针：串行化执行，避免高频笔画堆积推理任务
let probeBusy = false;
let probePending = null;
async function runProbe(strokes, seq) {
  if (probeBusy) { probePending = { strokes, seq }; return; }
  probeBusy = true;
  try {
    const result = await probe.probe(strokes);
    if (result && scienceClients.size > 0) {
      lastProbe = { ...result, seq, ts: Date.now(), strokes };
      // strokes 可能较大，截断点数上限以控制推送体积（科普展示足够）
      const lightStrokes = strokes.map(s => ({ points: (s.points || []).slice(0, 400) }));
      broadcast(scienceClients, { type: 'probe', ...lastProbe, strokes: lightStrokes });
    }
  } catch (e) {
    // 探针失败绝不影响对战
  } finally {
    probeBusy = false;
    if (probePending) {
      const next = probePending; probePending = null;
      runProbe(next.strokes, next.seq);
    }
  }
}

function publicRound() {
  return {
    active: round.active,
    id: round.id,
    mode: round.mode || 'classic',
    endTime: round.endTime,
    seconds: round.seconds,
    target: round.active && round.target ? round.target.word : null,
    player: round.player,
    locked: round.locked,
    result: round.result,
    awaitingJudge: round.awaitingJudge,
    selfReport: round.selfReport,
    judgeVerdict: round.judgeVerdict
  };
}

function setGameMode(mode) {
  if (!VALID_MODES.has(mode) || mode === gameMode) return;
  gameMode = mode;
  log(`[模式] 切换到${mode === 'free' ? '自由模式' : '对战模式'}`);
  const payload = { type: 'mode', gameMode };
  broadcast(displayClients, payload);
  broadcast(drawClients, payload);
  broadcast(hostClients, payload);
  broadcast(scienceClients, payload);
}

function notifyDrawOnline() {
  broadcast(displayClients, { type: 'connection', drawOnline: drawClients.size });
}

wssDraw.on('connection', ws => {
  drawClients.add(ws);
  log(`[WS] 平板接入，当前 ${drawClients.size} 台`);
  notifyDrawOnline();
  ws.send(JSON.stringify({ type: 'hello', role: 'draw', route: engine.route, round: publicRound(), players: players.snapshot() }));

  ws.on('message', data => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch (e) {
      return;
    }

    if (msg.type === 'guess' && engine.route === 'browser' && round.active && !round.locked) {
      // 路线③：后端不推理，只校验并转发平板送来的 Top-5
      let top5 = Array.isArray(msg.top5) ? msg.top5.slice(0, config.inference.topK).map(x => ({
        index: Number(x.index) || 0,
        en: String(x.en || ''),
        zh: String(x.zh || x.en || ''),
        score: Math.max(0, Math.min(1, Number(x.score) || 0))
      })) : [];
      // 骗AI模式在③路线上由后端压制正确答案置信度并重新排序，保持三路线行为一致
      if (config.inference.decoyMode && round.target && round.target.index >= 0) {
        top5.forEach(t => {
          if (t.index === round.target.index) t.score *= config.inference.decoySuppressFactor;
        });
        top5.sort((a, b) => b.score - a.score);
      }
      round.top5 = top5;
      stats.guessesSent++;
      broadcast(displayClients, {
        type: 'guess', top5, seq: msg.seq || 0, ts: Date.now(), locked: false,
        thumb: typeof msg.thumb === 'string' ? msg.thumb.slice(0, 20000) : null,
        inferMs: stats.inferMsLast
      });
      checkLock(top5);
      return;
    }

    // 序列路线：平板上传笔画坐标序列 [{points:[[x,y],...]},...]
    if (msg.type === 'strokes') {
      stats.framesIn++;
      if (!round.active || engine.route !== 'sequence' || !Array.isArray(msg.strokes)) return;
      try {
        enqueueFrame({
          strokes: msg.strokes,
          drawing: !!msg.drawing,
          strokeCount: Number(msg.strokeCount) || 0,
          pointCount: Number(msg.pointCount) || 0,
          seq: msg.seq || 0, ts: msg.ts || Date.now()
        });
        // 科普探针：仅当科普页在线时跑额外一次前向，抓真实中间层激活
        if (probe.ready && scienceClients.size > 0 && msg.strokes && msg.strokes.length) {
          runProbe(msg.strokes, msg.seq || 0);
        }
      } catch (e) {
        stats.errors++;
      }
      return;
    }

    if (msg.type === 'frame') {
      stats.framesIn++;
      // 序列引擎只认 strokes；栅格 PNG 帧直接忽略，避免送进 flush 触发错误
      if (!round.active || engine.route === 'browser' || engine.route === 'sequence' || !msg.png) return;
      try {
        const buf = Buffer.from(msg.png, 'base64');
        enqueueFrame({ png: buf, seq: msg.seq || 0, ts: msg.ts || Date.now(), w: msg.w || 160 });
      } catch (e) {
        stats.errors++;
      }
    }
  });

  ws.on('close', () => {
    drawClients.delete(ws);
    log(`[WS] 平板断开，当前 ${drawClients.size} 台`);
    notifyDrawOnline();
  });
  ws.on('error', () => {});
});

wssDisplay.on('connection', ws => {
  displayClients.add(ws);
  log(`[WS] 大屏接入，当前 ${displayClients.size} 台`);
  ws.send(JSON.stringify({
    type: 'hello', role: 'display', route: engine.route,
    config: { title: config.display.title, subtitle: config.display.subtitle },
    drawOnline: drawClients.size,
    round: publicRound(),
    players: players.snapshot(),
    view: displayView
  }));
  ws.on('close', () => displayClients.delete(ws));
  ws.on('error', () => {});
});

wssHost.on('connection', ws => {
  hostClients.add(ws);
  ws.send(JSON.stringify({ type: 'hello', role: 'host', route: engine.route, round: publicRound(), scoreboard, players: players.snapshot() }));
  ws.on('message', data => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch (e) { return; }
    if (msg.type === 'start') startRound(msg.word || null);
    else if (msg.type === 'lock' && round.active && !round.awaitingJudge) endRound('host');
    else if (msg.type === 'judge') judgeRound(msg.verdict || null);
    else if (msg.type === 'reset') resetRound();
    else if (msg.type === 'mode' && VALID_MODES.has(msg.gameMode || msg.mode)) {
      setGameMode(msg.gameMode || msg.mode);
    } else if (msg.type === 'report') submitReport(String(msg.report || '').trim());
  });
  ws.on('close', () => hostClients.delete(ws));
  ws.on('error', () => {});
});

wssScience.on('connection', ws => {
  scienceClients.add(ws);
  log(`[WS] 科普页接入，当前 ${scienceClients.size} 个`);
  ws.send(JSON.stringify({
    type: 'hello', role: 'science', ready: probe.ready,
    layers: probe.ready ? LAYER_META : [],
    probe: lastProbe, players: players.snapshot()
  }));
  ws.on('close', () => scienceClients.delete(ws));
  ws.on('error', () => {});
});

/* ------------------------------------------------------------------ */
/* 帧调度：服务端忙时丢旧帧，只算最新帧                                  */
/* ------------------------------------------------------------------ */

let pendingFrame = null;
let inferring = false;
let flushTimer = null;

function nextWait() {
  const elapsed = Date.now() - (stats.lastInferAt || 0);
  return Math.max(0, config.inference.intervalMs - elapsed);
}

function enqueueFrame(frame) {
  // 单槽覆盖：旧帧直接丢弃
  if (pendingFrame) stats.framesDropped++;
  pendingFrame = frame;
  if (!flushTimer && !inferring) flushTimer = setTimeout(flush, nextWait());
}

async function flush() {
  flushTimer = null;
  if (inferring) return; // 处理中的循环会在 finally 中重新调度
  const frame = pendingFrame;
  pendingFrame = null;
  if (!frame || !round.active) return;

  inferring = true;
  const started = Date.now();
  try {
    const suppress = config.inference.decoyMode && round.target && round.target.index >= 0
      ? round.target.index : -1;
    let res, thumb;
    if (frame.strokes) {
      // 序列路线：CRNN V2
      res = await engine.infer(frame.strokes, { suppressIndex: suppress });
      thumb = thumbFromStrokes(frame.strokes, config.tablet.thumbSize || 72);
    } else {
      // 旧栅格路线：PNG -> 灰度
      const png = PNG.sync.read(frame.png);
      const gray = new Uint8Array(png.width * png.height);
      for (let i = 0; i < gray.length; i++) gray[i] = png.data[i * 4];
      res = await engine.infer(gray, { suppressIndex: suppress, srcSize: png.width });
      thumb = makeThumb(gray, png.width, config.tablet.thumbSize || 72);
    }

    stats.inferences++;
    stats.inferMsLast = Date.now() - started;
    stats.inferMsTotal += stats.inferMsLast;
    stats.lastInferAt = Date.now();
    round.top5 = res.top5;

    broadcast(displayClients, {
      type: 'guess', top5: res.top5, seq: frame.seq, ts: Date.now(),
      locked: round.locked, thumb, inferMs: stats.inferMsLast
    });
    checkLock(res.top5, frame);
  } catch (e) {
    stats.errors++;
    log(`[推理] 帧处理失败：${e && e.message ? e.message : String(e)}`);
  } finally {
    inferring = false;
    // 处理期间到达的新帧已经在 pendingFrame 中，立刻处理最新的一帧
    if (pendingFrame) flushTimer = setTimeout(flush, 0);
  }
}

function checkLock(top5, frame) {
  if (round.locked || !top5.length) return;
  const first = top5[0];

  // 序列路线：作画过程中绝不锁定，避免方框被当成枕头"画一半就锁死"。
  // 只有过了作画宽限期、停笔、且画了足够内容后才允许累计稳定帧。
  if (engine.route === 'sequence' && frame) {
    const graceMs = Number(config.round.lockGraceMs) || 0;
    const inGrace = round.startTime > 0 && (Date.now() - round.startTime) < graceMs;
    const minStrokes = Number(config.round.lockMinStrokes) || 1;
    const minPoints = Number(config.round.lockMinPoints) || 8;
    const stillDrawing = !!frame.drawing;
    const tooLittle = (frame.strokeCount || 0) < minStrokes || (frame.pointCount || 0) < minPoints;
    if (inGrace) {
      round.lockCount = 0;
      round.lockTopIndex = -1;
      return;
    }
    if (stillDrawing || tooLittle) {
      if (round.lockCount || round.lockTopIndex >= 0) {
        log(`[锁定] 重置：${stillDrawing ? '仍在作画' : '内容不足'}`);
      }
      round.lockCount = 0;
      round.lockTopIndex = -1;
      return;
    }
  }

  if (first.score < config.round.lockThreshold) {
    round.lockCount = 0;
    round.lockTopIndex = -1;
    return;
  }
  if (first.index === round.lockTopIndex) round.lockCount++;
  else {
    round.lockTopIndex = first.index;
    round.lockCount = 1;
  }
  if (round.lockCount >= config.round.lockStableFrames) {
    round.locked = true;
    log(`[锁定] 第 ${round.id} 轮锁定：${first.zh} ${(first.score * 100).toFixed(0)}%`);
    broadcast(displayClients, { type: 'lock', top1: first });
    broadcast(drawClients, { type: 'lock', top1: first });
    round.lockTimer = setTimeout(() => endRound('lock'), config.round.lockHoldMs);
  }
}

/* ------------------------------------------------------------------ */
/* 回合与结算                                                          */
/* ------------------------------------------------------------------ */

function pickTarget(requested) {
  let item = null;
  if (requested) {
    item = words.find(w => w.word === requested || w.class === requested) || null;
  }
  if (!item) item = words[Math.floor(Math.random() * words.length)];
  if (!item) return { word: '飞机', class: 'airplane', hint: '', index: engine.indexOfClass('airplane') };
  return { word: item.word, class: item.class, hint: item.hint || '', index: engine.indexOfClass(item.class) };
}

function startRound(requested) {
  clearTimeout(round.endTimer);
  clearTimeout(round.lockTimer);
  clearTimeout(round.judgeTimer);
  round.endTimer = null;
  round.lockTimer = null;
  round.judgeTimer = null;
  round.awaitingJudge = false;
  round.selfReport = null;
  round.judgeVerdict = null;
  pendingFrame = null;
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }

  const isFree = gameMode === 'free';
  round.mode = gameMode;
  round.id++;
  round.active = true;
  round.seconds = config.round.seconds;
  round.startTime = Date.now();
  round.endTime = round.startTime + round.seconds * 1000;
  // 自由模式没有系统谜底：AI 纯凭画面猜，画手自述由主持人录入
  round.target = isFree ? null : pickTarget(requested);
  // 绑定本轮选手：自动轮转时切到下一位，否则用当前选中的
  round.player = players.beginRound();
  round.playerId = round.player ? round.player.id : null;
  round.top5 = [];
  round.locked = false;
  round.lockCount = 0;
  round.lockTopIndex = -1;
  round.result = null;

  log(`[回合 ${round.id}] 开始（${isFree ? '自由模式' : '对战模式'}）：${isFree ? '画手自由作画' : round.target.word + ' (' + round.target.class + ', 索引 ' + round.target.index + ')'} ${round.seconds}s，路线 ${engine.route}${round.player ? `，选手 ${round.player.name}` : ''}`);

  broadcast(drawClients, {
    type: 'roundStart', roundId: round.id,
    mode: round.mode,
    word: isFree ? null : round.target.word,
    hint: isFree ? '' : round.target.hint,
    seconds: round.seconds, endTime: round.endTime, route: engine.route
  });
  // 大屏不接收谜底，避免画面泄露给 AI 侧观众
  broadcast(displayClients, {
    type: 'roundStart', roundId: round.id, mode: round.mode,
    seconds: round.seconds,
    endTime: round.endTime, route: engine.route, player: round.player
  });
  broadcast(hostClients, { type: 'roundStart', round: publicRound() });
  broadcastPlayers();

  round.endTimer = setTimeout(() => endRound('timeout'), round.seconds * 1000);
}

function buildResult(key, hitRank) {
  const target = round.target ? round.target.word : '?';
  const guess = round.top5[0] ? round.top5[0].zh : '无';
  const conf = round.top5[0] ? Math.round(round.top5[0].score * 100) : 0;
  const report = round.selfReport || '未填写'; // 自由模式：画手自述（可留空）
  const reportPhrase = round.selfReport ? `画手说画的是「${report}」` : '画手未填写自述';

  // ---- 自由模式：主持人裁定 AI 猜测与画手自述是否同一种，简单二分计分 ----
  if (key === 'free_same') {
    return {
      key, title: '同一种 · AI 得分', winner: 'ai', hitRank: 1,
      detail: `${reportPhrase}，AI 猜的是「${guess}」。主持人判定两种描述指的是同一样东西——AI +2。`,
      points: { ai: 2, human: 0 }, mode: 'free', report, aiGuess: guess
    };
  }
  if (key === 'free_diff') {
    return {
      key, title: '不是同一种 · 人类得分', winner: 'human', hitRank: 0,
      detail: `${reportPhrase}，AI 猜的是「${guess}」。主持人判定两者不是同一样东西——画手 +2。`,
      points: { ai: 0, human: 2 }, mode: 'free', report, aiGuess: guess
    };
  }
  if (key === 'free_skip') {
    return {
      key, title: '本轮跳过 · 无人得分', winner: 'none', hitRank: 0,
      detail: `主持跳过本轮。AI 曾猜「${guess}」，本轮双方均不得分。`,
      points: { ai: 0, human: 0 }, mode: 'free', report, aiGuess: guess
    };
  }

  if (key === 'ai') {
    return {
      key, title: 'AI 猜中', winner: 'ai', hitRank: 1,
      detail: `「${target}」画得传神，AI 一眼认出（${conf}%）。画得好人类 +1，AI 识破 +2。`,
      points: { ai: 2, human: 1 }
    };
  }
  if (key === 'narrow') {
    return {
      key, title: '险胜', winner: 'human', hitRank,
      detail: `AI 到第 ${hitRank} 位才摸到「${target}」。画面有辨识度，人类 +2、AI +1。`,
      points: { ai: 1, human: 2 }
    };
  }
  if (key === 'fail') {
    return {
      key, title: 'AI 翻车，人类得分', winner: 'human', hitRank: 0,
      detail: `画得像「${target}」，AI 却猜成了「${guess}」。裁判判定画得像——人类 +2。`,
      points: { ai: 0, human: 2 }
    };
  }
  return {
    key: 'abstract', title: '画得太抽象，AI 不背锅', winner: 'none', hitRank: 0,
    detail: `谜底是「${target}」，但画面确实难以辨认，本轮无人得分。`,
    points: { ai: 0, human: 0 }
  };
}

function settleRound(key, reason, hitRank) {
  const result = buildResult(key, hitRank);
  result.reason = reason;
  round.result = result;
  round.awaitingJudge = false;
  clearTimeout(round.judgeTimer);
  round.judgeTimer = null;

  scoreboard.ai += result.points.ai;
  scoreboard.human += result.points.human;
  if (result.key === 'abstract' || result.key === 'free_skip') scoreboard.draws++;
  scoreboard.rounds++;

  // 记到本轮选手名下（个人分 = 人类得分）
  result.playerAward = players.award(round.playerId, result.points.human, result.winner, result.key);

  log(`[回合 ${round.id}] 结算（${reason}）：${result.title} — ${result.detail}`);
  const payload = {
    type: 'roundEnd', result, reason,
    mode: round.mode,
    top5: round.top5,
    target: round.target ? { word: round.target.word, en: round.target.class } : null,
    scoreboard: { ...scoreboard },
    players: players.snapshot()
  };
  broadcast(displayClients, payload);
  broadcast(drawClients, payload);
  broadcast(hostClients, payload);
  broadcastPlayers();
}

// 自由模式：主持人录入画手自述。仅在等待裁定阶段可写。
function submitReport(text) {
  if (!round.awaitingJudge || (round.mode || 'classic') !== 'free') return false;
  if (typeof text !== 'string' || !text.trim()) return false;
  round.selfReport = text.slice(0, 60);
  log(`[回合 ${round.id}] 画手自述：${round.selfReport}`);
  // 把已录入的自述同步给三端，主持人可确认
  const payload = {
    type: 'report', mode: 'free', report: round.selfReport,
    top5: round.top5
  };
  broadcast(displayClients, payload);
  broadcast(drawClients, payload);
  broadcast(hostClients, payload);
  return true;
}

// 主持裁定
//  classic：like=>AI翻车人类得分；unlike=>无人得分
//  free：   same =>AI猜中(AI+2)；diff =>不是同一种(人类+2)
function judgeRound(verdict) {
  if (!round.awaitingJudge) return false;
  const isFree = (round.mode || 'classic') === 'free';
  if (isFree) {
    if (verdict === 'skip') {
      log(`[回合 ${round.id}] 自由模式：主持跳过本轮（无人得分）`);
      settleRound('free_skip', 'judge:skip', 0);
      return true;
    }
    if (verdict !== 'same' && verdict !== 'diff') return false;
    log(`[回合 ${round.id}] 自由模式裁定：${verdict === 'same' ? '同一种' : '不是同一种'}（自述：${round.selfReport || '未填写'}）`);
    settleRound(verdict === 'same' ? 'free_same' : 'free_diff', 'judge:' + verdict, verdict === 'same' ? 1 : 0);
    return true;
  }
  if (verdict !== 'like' && verdict !== 'unlike') verdict = 'unlike';
  log(`[回合 ${round.id}] 主持裁定：${verdict}`);
  settleRound(verdict === 'like' ? 'fail' : 'abstract', 'judge:' + verdict, 0);
  return true;
}

function endRound(reason) {
  clearTimeout(round.endTimer);
  clearTimeout(round.lockTimer);
  round.endTimer = null;
  round.lockTimer = null;

  if (reason === 'reset' || !round.active) {
    resetRound();
    return;
  }
  round.active = false;
  pendingFrame = null;

  // ---- 自由模式：无系统谜底，回合结束直接进入"录入自述 + 裁定"阶段 ----
  if ((round.mode || 'classic') === 'free') {
    round.awaitingJudge = true;
    round.result = null;
    round.selfReport = null;
    round.judgeVerdict = null;
    const aiGuess = round.top5[0] ? round.top5[0].zh : '无';
    log(`[回合 ${round.id}] 自由模式作画结束，AI 猜测：${aiGuess}。等待主持人录入画手自述并裁定`);
    const payload = {
      type: 'needJudge', mode: 'free', reason, top5: round.top5,
      target: null, aiGuess
    };
    broadcast(displayClients, payload);
    broadcast(drawClients, payload);
    broadcast(hostClients, payload);
    // 自由模式裁定不设自动超时：主持人录入完自述再裁定
    return;
  }

  const targetIndex = round.target ? round.target.index : -1;
  const hitRank = round.top5.findIndex(t => t.index === targetIndex) + 1;
  const hit1 = hitRank === 1;
  const hit3 = hitRank > 0 && hitRank <= 3;
  const fair = config.round.scoringMode !== 'classic';

  // 公平模式：AI 没猜中不等于人类赢——先让主持判断画得像不像
  if (fair && !hit1 && !hit3) {
    round.awaitingJudge = true;
    round.result = null;
    log(`[回合 ${round.id}] AI 未命中，等待主持裁定（超时自动判"画得抽象"）`);
    const payload = {
      type: 'needJudge', reason, top5: round.top5,
      target: round.target ? { word: round.target.word, en: round.target.class } : null
    };
    broadcast(displayClients, payload);
    broadcast(drawClients, payload);
    broadcast(hostClients, payload);
    round.judgeTimer = setTimeout(
      () => judgeRound('unlike'),
      Number(config.round.judgeTimeoutMs) || 45000
    );
    return;
  }

  if (reason === 'timeout' && !fair && !hit1 && !hit3) {
    settleRound('fail', reason, 0);
  } else if (hit1) {
    settleRound('ai', reason, 1);
  } else if (hit3) {
    settleRound('narrow', reason, hitRank);
  } else {
    settleRound('fail', reason, 0);
  }
}

function resetRound() {
  clearTimeout(round.endTimer);
  clearTimeout(round.lockTimer);
  clearTimeout(round.judgeTimer);
  round.endTimer = null;
  round.lockTimer = null;
  round.judgeTimer = null;
  round.awaitingJudge = false;
  round.active = false;
  round.locked = false;
  round.top5 = [];
  round.result = null;
  round.target = null;
  round.selfReport = null;
  round.judgeVerdict = null;
  pendingFrame = null;
  broadcast(displayClients, { type: 'roundReset' });
  broadcast(drawClients, { type: 'roundReset' });
  broadcast(hostClients, { type: 'roundReset', round: publicRound() });
}

/* ------------------------------------------------------------------ */

async function main() {
  players.load();
  await engine.init();
  if (engine.route === 'sequence') await probe.init();
  const host = config.server.host;
  const port = Number(config.server.port) || 3000;
  server.listen(port, host, () => {
    log(`服务已启动： http://127.0.0.1:${port}  （监听 ${host}）`);
    log(`实际推理路线：${engine.route}`);
    log(`平板： http://<本机局域网IP>:${port}/draw`);
    log(`大屏： http://<本机局域网IP>:${port}/display`);
    log(`主持： http://<本机局域网IP>:${port}/host`);
  });
}

main().catch(e => {
  console.error('[致命] 启动失败：', e);
  process.exit(1);
});

process.on('SIGINT', () => {
  log('收到 SIGINT，退出。');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
});
