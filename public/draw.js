'use strict';
(function () {
  const $ = id => document.getElementById(id);
  const canvas = $('c');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const stage = $('stage');

  const ui = {
    status: $('status'), word: $('word'), hint: $('hint'), timer: $('timer'), prompt: $('prompt'),
    result: $('result'), resultTitle: $('resultTitle'), resultDetail: $('resultDetail'),
    lock: $('lockBanner'), fallback: $('fallback'), video: $('fallbackVideo'),
    judging: $('judgingOverlay'),
    brushSlider: $('brushSlider'), brushVal: $('brushVal')
  };
  // 笔刷滑块值是「256 基准画布上的半径」。现在 AI 端会自动把细线补粗（dilateRadius），
  // 所以默认值取向视觉美观：2（细笔刷），识别交给预处理。范围由 config 控制，默认 1–8。
  let brushBase = 2;
  let brushMin = 1, brushMax = 8;

  let cfg = {
    tablet: { brushRadius: 12, canvasSize: 256, thumbSize: 72 },
    inference: { intervalMs: 400, topK: 5, inputSize: 28, decoyMode: false },
    round: { seconds: 70 }
  };
  let W = canvas.width, H = canvas.height;
  let uploadSize = 256, thumbSize = 72;
  let route = 'none';
  let ws = null;
  let reconnectDelay = 500;
  let seq = 0;
  let dirty = false;
  let drawing = false;
  let last = null;
  let strokes = [];        // 序列路线：原始笔画 [[x,y],...][]
  let curStroke = null;    // 当前正在画的笔画
  let settleFrames = 0;    // 停笔后剩余的上报帧数（用于形状稳定确认）
  let activeRound = false;
  let endTime = 0;
  let browserInited = false;
  let browserBusy = false;
  let tfModel = null;
  let labels = [];

  function setStatus(text, bad) {
    ui.status.textContent = text;
    ui.status.style.color = bad ? '#d1424b' : '#4b8b3b';
  }

  // 画布铺满 stage；旋转屏幕或窗口变化时保留已有笔画
  function resizeCanvas() {
    const r = stage.getBoundingClientRect();
    const nw = Math.max(320, Math.min(2400, Math.round(r.width - 12)));
    const nh = Math.max(240, Math.min(1800, Math.round(r.height - 12)));
    if (nw === W && nh === H) return;
    let snap = null;
    if (W > 0 && H > 0) {
      snap = document.createElement('canvas');
      snap.width = W; snap.height = H;
      snap.getContext('2d').drawImage(canvas, 0, 0);
    }
    W = canvas.width = nw;
    H = canvas.height = nh;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, W, H);
    if (snap) ctx.drawImage(snap, 0, 0, W, H);
    dirty = true;
  }

  function clearCanvas() {
    resizeCanvas();
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, W, H);
    strokes = [];
    curStroke = null;
    settleFrames = 0;
    dirty = true;
  }

  function point(e) {
    const r = canvas.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(W, (e.clientX - r.left) / r.width * W)),
      y: Math.max(0, Math.min(H, (e.clientY - r.top) / r.height * H))
    };
  }

  function brushRadius() {
    // 滑块值是相对 uploadSize(256) 基准画布的半径，换算到当前高分辨率画布
    const r = Math.max(0.5, brushBase) * (W / uploadSize);
    return r;
  }

  function dot(p) {
    ctx.fillStyle = '#000';
    ctx.beginPath();
    ctx.arc(p.x, p.y, brushRadius(), 0, Math.PI * 2);
    ctx.fill();
  }

  // 连续线条：圆头 + 圆角连接，避免逐点画圆在停顿处堆成一坨黑点
  function stroke(a, b) {
    const r = brushRadius();
    ctx.strokeStyle = '#000';
    ctx.lineWidth = r * 2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }

  function setBrush(v) {
    brushBase = Math.max(brushMin, Math.min(brushMax, Number(v) || 2));
    ui.brushSlider.value = brushBase;
    ui.brushVal.textContent = brushBase;
  }
  ui.brushSlider.addEventListener('input', e => setBrush(e.target.value));
  $('brushMinus').addEventListener('click', () => setBrush(brushBase - 0.5));
  $('brushPlus').addEventListener('click', () => setBrush(brushBase + 0.5));

  canvas.addEventListener('pointerdown', e => {
    e.preventDefault();
    drawing = true;
    last = point(e);
    dot(last);
    // 序列路线：开始新笔画，记录原始坐标
    curStroke = [[last.x, last.y]];
    strokes.push(curStroke);
    settleFrames = 0;     // 重新作画，取消停笔稳定计数
    dirty = true;
    if (canvas.setPointerCapture) canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', e => {
    e.preventDefault();
    if (!drawing) return;
    const p = point(e);
    stroke(last, p);
    last = p;
    if (curStroke) curStroke.push([p.x, p.y]);
    dirty = true;
  });
  const endStroke = e => {
    e.preventDefault();
    drawing = false;
    last = null;
    curStroke = null;
    dirty = true;         // 触发一帧上报"停笔"状态
    settleFrames = 8;     // 停笔后再发若干帧，让服务端确认形状稳定再锁定
  };
  canvas.addEventListener('pointerup', endStroke);
  canvas.addEventListener('pointercancel', endStroke);
  canvas.addEventListener('touchstart', e => e.preventDefault(), { passive: false });
  canvas.addEventListener('touchmove', e => e.preventDefault(), { passive: false });

  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(resizeCanvas, 150);
  });

  $('clear').addEventListener('click', clearCanvas);
  $('finish').addEventListener('click', () => {
    fetch('/api/lock', { method: 'POST' }).catch(() => {});
  });

  function connect() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(proto + '//' + location.host + '/ws/draw');
    ws.onopen = () => { reconnectDelay = 500; setStatus('已连接'); };
    ws.onmessage = ev => {
      let m;
      try { m = JSON.parse(ev.data); } catch (e) { return; }
      handleMessage(m);
    };
    ws.onclose = () => {
      setStatus(`已断连 · ${(reconnectDelay / 1000).toFixed(1)}s 后重连`, true);
      setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(5000, reconnectDelay * 2);
    };
    ws.onerror = () => { try { ws.close(); } catch (e) {} };
  }

  function handleMessage(m) {
    if (m.type === 'hello') {
      route = m.route;
      setStatus('已连接 · ' + (route === 'sequence' ? '序列模型 CRNN V2' : '路线' + routeName(route)));
      if (route === 'browser') initBrowserInfer();
      if (m.round && m.round.active) {
        activeRound = true;
        endTime = m.round.endTime;
        ui.word.textContent = m.round.target || '—';
        ui.prompt.classList.add('show');
        ui.result.classList.remove('show');
      }
      if (m.round && m.round.awaitingJudge) ui.judging.classList.add('show');
      return;
    }
    if (m.type === 'roundStart') {
      activeRound = true;
      endTime = m.endTime;
      clearCanvas();
      ui.word.textContent = m.word;
      ui.hint.textContent = m.hint || '';
      ui.prompt.classList.add('show');
      ui.result.classList.remove('show');
      ui.lock.classList.remove('show');
      ui.fallback.classList.remove('show');
      ui.judging.classList.remove('show');
      return;
    }
    if (m.type === 'lock') { ui.lock.classList.add('show'); return; }
    if (m.type === 'needJudge') {
      activeRound = false;
      ui.lock.classList.remove('show');
      ui.judging.classList.add('show');
      return;
    }
    if (m.type === 'roundEnd') {
      activeRound = false;
      ui.lock.classList.remove('show');
      ui.judging.classList.remove('show');
      ui.prompt.classList.remove('show');
      ui.result.className = 'show ' + (m.result.key || '');
      ui.resultTitle.textContent = m.result.title;
      ui.resultDetail.textContent = m.result.detail;
      setTimeout(() => ui.result.classList.remove('show'), 8000);
      return;
    }
    if (m.type === 'roundReset') {
      activeRound = false;
      clearCanvas();
      ui.prompt.classList.remove('show');
      ui.result.classList.remove('show');
      ui.lock.classList.remove('show');
      ui.judging.classList.remove('show');
    }
  }

  function routeName(r) {
    return r === 'tfjs-node' ? '① 本机TFJS' : r === 'onnx' ? '② ONNX' : '③ 平板推理';
  }

  // 把任意宽高比的高分辨率画布等比缩放、居中到正方形 white canvas，
  // 不改变模型看到的笔画比例，也不拉伸变形
  function squareCanvas(size) {
    const off = document.createElement('canvas');
    off.width = size; off.height = size;
    const o = off.getContext('2d');
    o.fillStyle = '#fff';
    o.fillRect(0, 0, size, size);
    const scale = Math.min(size / W, size / H);
    const dw = W * scale, dh = H * scale;
    o.drawImage(canvas, (size - dw) / 2, (size - dh) / 2, dw, dh);
    return off;
  }

  function pngBase64(cv) {
    return cv.toDataURL('image/png').split(',')[1];
  }

  function uploadLoop() {
    setTimeout(() => {
      const due = dirty || (isSequence() && settleFrames > 0);
      if (due && activeRound && ws && ws.readyState === 1) {
        if (isSequence()) {
          // 序列路线：上传原始笔画坐标 + 是否在下笔（服务端据此决定可否锁定）
          ws.send(JSON.stringify({
            type: 'strokes', seq: ++seq, ts: Date.now(),
            drawing: drawing,
            strokeCount: strokes.length,
            pointCount: strokes.reduce((n, s) => n + s.length, 0),
            strokes: strokes.map(s => ({ points: s }))
          }));
          if (!drawing && settleFrames > 0) settleFrames--;
        } else {
          const square = squareCanvas(uploadSize);
          if (route === 'browser') {
            runBrowserInfer(square);
          } else {
            ws.send(JSON.stringify({
              type: 'frame', seq: ++seq, ts: Date.now(), w: uploadSize,
              png: pngBase64(square)
            }));
          }
        }
        dirty = false;
      }
      uploadLoop();
    }, cfg.inference.intervalMs || 400);
  }

  // 是否走序列模型（CRNN V2）。由后端配置决定。
  // 兼容两种位置：cfg.engine（顶层）与 cfg.inference.engine；也认 route=sequence。
  function isSequence() {
    if (route === 'sequence') return true;
    return (cfg.inference && cfg.inference.engine === 'sequence') || cfg.engine === 'sequence';
  }

  setInterval(() => {
    if (!activeRound) { ui.timer.textContent = '--'; return; }
    const left = Math.max(0, Math.ceil((endTime - Date.now()) / 1000));
    ui.timer.textContent = '剩余 ' + left + ' 秒';
  }, 200);

  /* ---------- 路线③：平板端 TensorFlow.js 推理 ---------- */

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error('加载 ' + src + ' 失败'));
      document.head.appendChild(s);
    });
  }

  async function initBrowserInfer() {
    if (browserInited) return;
    browserInited = true;
    try {
      await loadScript('/vendor/tf.min.js');
      labels = await fetch('/api/labels').then(r => r.json());
      tfModel = await tf.loadLayersModel('/model/model.json');
      const size = cfg.inference.inputSize || 28;
      const warm = tf.zeros([1, size, size, 1]);
      const p = tfModel.predict(warm);
      await p.data();
      warm.dispose(); p.dispose();
      setStatus('已连接 · 路线③ 平板推理就绪');
    } catch (e) {
      showFallback();
    }
  }

  function showFallback() {
    ui.fallback.classList.add('show');
    if (ui.video.play) ui.video.play().catch(() => {});
  }

  // 膨胀灰度笔画（白底黑线取邻域最小值），把用户画的细线补到 DoodleNet 期望宽度。
  // 与服务端 server/inference.js 的 dilateGray 算法保持一致。
  function dilateGray(gray, srcSize, radius) {
    if (!radius || radius < 1) return gray;
    const tmp = new Uint8Array(gray.length);
    const out = new Uint8Array(gray.length);
    for (let y = 0; y < srcSize; y++) {
      const row = y * srcSize;
      for (let x = 0; x < srcSize; x++) {
        let m = 255;
        const a = Math.max(0, x - radius), b = Math.min(srcSize - 1, x + radius);
        for (let xx = a; xx <= b; xx++) if (gray[row + xx] < m) m = gray[row + xx];
        tmp[row + x] = m;
      }
    }
    for (let y = 0; y < srcSize; y++) {
      const a = Math.max(0, y - radius), b = Math.min(srcSize - 1, y + radius);
      for (let x = 0; x < srcSize; x++) {
        let m = 255;
        for (let yy = a; yy <= b; yy++) if (tmp[yy * srcSize + x] < m) m = tmp[yy * srcSize + x];
        out[y * srcSize + x] = m;
      }
    }
    return out;
  }

  function downsampleFrom(square, size) {
    const data = square.getContext('2d').getImageData(0, 0, uploadSize, uploadSize).data;
    // 先抽出灰度，再膨胀补粗，最后面积平均下采样
    const gray = new Uint8Array(uploadSize * uploadSize);
    for (let i = 0; i < gray.length; i++) gray[i] = data[i * 4];
    const dr = cfg.inference.dilateRadius === undefined ? 5 : cfg.inference.dilateRadius;
    const radius = Math.round(dr * (uploadSize / 256));
    const work = dilateGray(gray, uploadSize, radius);
    const scale = uploadSize / size;
    const out = new Float32Array(size * size);
    for (let y = 0; y < size; y++) {
      const y0 = Math.floor(y * scale), y1 = Math.min(uploadSize, Math.ceil((y + 1) * scale));
      for (let x = 0; x < size; x++) {
        const x0 = Math.floor(x * scale), x1 = Math.min(uploadSize, Math.ceil((x + 1) * scale));
        let sum = 0, n = 0;
        for (let yy = y0; yy < y1; yy++) {
          for (let xx = x0; xx < x1; xx++) { sum += work[yy * uploadSize + xx]; n++; }
        }
        out[y * size + x] = 1 - (n ? sum / n : 255) / 255;
      }
    }
    return out;
  }

  async function runBrowserInfer(square) {
    if (!tfModel || browserBusy || !ws || ws.readyState !== 1) return;
    browserBusy = true;
    const size = cfg.inference.inputSize || 28;
    let t = null, pred = null;
    try {
      t = tf.tensor4d(downsampleFrom(square, size), [1, size, size, 1]);
      pred = tfModel.predict(t);
      const scores = await pred.data();
      const k = cfg.inference.topK || 5;
      const idx = Array.from(scores.keys()).sort((a, b) => scores[b] - scores[a]).slice(0, k);
      const top5 = idx.map(i => ({
        index: i,
        en: labels[i] ? labels[i].en : 'class_' + i,
        zh: labels[i] ? labels[i].zh : '类别' + i,
        score: Math.max(0, Math.min(1, Number(scores[i]) || 0))
      }));
      const thumb = pngBase64(squareCanvas(thumbSize));
      ws.send(JSON.stringify({ type: 'guess', seq: ++seq, top5, thumb, ts: Date.now() }));
    } catch (e) {
      showFallback();
    } finally {
      if (t) t.dispose();
      if (pred) pred.dispose();
      browserBusy = false;
    }
  }

  // 初始化配置，然后连接
  fetch('/api/config').then(r => r.json()).then(c => {
    cfg = c;
    uploadSize = c.tablet.canvasSize || 256;
    thumbSize = c.tablet.thumbSize || 72;
    brushMin = c.tablet.brushMin === undefined ? 1 : c.tablet.brushMin;
    brushMax = c.tablet.brushMax === undefined ? 8 : c.tablet.brushMax;
    ui.brushSlider.min = brushMin;
    ui.brushSlider.max = brushMax;
    if (c.tablet && c.tablet.brushRadius) setBrush(c.tablet.brushRadius);
    resizeCanvas();
  }).catch(() => {}).finally(() => {
    resizeCanvas();
    connect();
    uploadLoop(); // 启动 400ms 上传/推理循环（此前漏掉种子调用，导致 AI 一直收不到笔画）
  });
})();
