'use strict';
(function () {
  const $ = id => document.getElementById(id);
  const heroCanvas = $('heroCanvas'), hctx = heroCanvas.getContext('2d');
  const strokeCanvas = $('strokeCanvas'), sctx = strokeCanvas.getContext('2d');
  const flowCanvas = $('flowCanvas'), fctx = flowCanvas.getContext('2d');

  let ws = null, reconnectDelay = 500;
  let LAYERS = [];
  let probeData = null;
  let curLayer = 0;
  let paused = false;
  let engineer = false;
  let view = 'overview';           // overview | detail
  let autoTimer = null;
  let tourWanted = true;           // 默认自动讲解，无需人工点击
  const TOUR_MS = 3200;
  let railY = 42, fw = 0, fh = 0, dpr = 1;

  const SITES = [
    { name: '① 看笔画', keys: ['input', 'cnn_multiscale', 'se_channel1', 'cnn_deep'] },
    { name: '② 读顺序', keys: ['bilstm1', 'bilstm2'] },
    { name: '③ 找关联', keys: ['mha_attention', 'mha_out'] },
    { name: '④ 下结论', keys: ['pool_fuse', 'logits', 'probs'] }
  ];
  const SHORT = {
    input: '输入编码', cnn_multiscale: '多尺度卷积', se_channel1: '通道注意', cnn_deep: '深层卷积',
    bilstm1: '双向LSTM①', bilstm2: '双向LSTM②', mha_attention: '自注意力', mha_out: '注意力输出',
    pool_fuse: '池化汇总', logits: '分类头', probs: '最终答案'
  };
  // 全景卡片上的一句话讲解
  const BRIEF = {
    input: '每个采样点记成「相对上一点的位移 + 是否抬笔」，与画布分辨率无关。',
    cnn_multiscale: '三种宽度的卷积同时扫过轨迹，分别抓小弯钩与整体走向。',
    se_channel1: '给每个特征通道打分，重要的放大、没用的压低。',
    cnn_deep: '更大的感受野，把小弯钩组合成弧线、封闭圈等结构。',
    bilstm1: '正反各读一遍轨迹，笔画顺序第一次变得有意义。',
    bilstm2: '再读一遍，记住「先画外圈、几笔后回来封口」这类长依赖。',
    mha_attention: '不同时刻的笔画互相「对照」，找出相隔很远的关联。',
    mha_out: '融合全局信息，局部特征升级成对整幅画的理解。',
    pool_fuse: '把整条序列压成一个 1024 维向量，得到对画的「整体印象」。',
    logits: '分类头输出 345 个类别的原始分数。',
    probs: 'softmax 变成总和为 1 的概率，最高的就是最终答案。'
  };
  const DETAIL = {
    input: '你把画交给 AI 的第一步：每个采样点被记成「相对上一点移动了多少（dx,dy）」和「这是不是一笔的结尾」。画布大小、笔画粗细都不重要了——AI 只看运动的轨迹。这就是它能“无视分辨率”的原因。注意热图右侧大片空白：模型固定读 128 步，而你的画简化后往往只有几十个点，剩下的都是补零——这也是「画得太复杂（点数超限）反而会被截断」的由来。',
    cnn_multiscale: '三种不同宽度的卷积核同时扫过轨迹：窄的看小弯钩，宽的看整体走向。它们把原始的点变成一组“局部形状特征”。想象成三副不同度数的眼镜同时看你的画。',
    se_channel1: 'SE（Squeeze-Excitation）注意力：网络给每个特征通道打一个“重要度”分数，重要的通道被放大，没用的被压低。这是网络在自学“画香蕉时，弧度的通道比直角更重要”。',
    cnn_deep: '更深一层的卷积，感受野更大，看到的是组合后的结构——不再是小弯钩，而是“一整段弧线”“一个封闭圈”。层越深，语义越抽象。',
    bilstm1: '双向 LSTM 开始“读”这条轨迹。它像一个边读边记的读者：正向读一遍，反向再读一遍，于是每个时刻都知道“前面画了什么、后面将要画什么”。笔画顺序第一次变得有意义。',
    bilstm2: '再来一层双向 LSTM，理解更长的依赖——比如“先画了外圈，几笔之后又回来画封口”，这种跨越好几笔的关系，就是靠它记住的。',
    mha_attention: '多头自注意力的“注意力矩阵”：行和列都是时间步，越亮表示这两个时刻的笔画越在互相关照。AI 用它找出“哪几笔之间有关联”，哪怕它们离得很远。图上是 8 个注意力头的平均。',
    mha_out: '注意力融合后的结果。现在每个时刻的表示，都已经“看过”整幅画里和它相关的其他笔画——局部特征升级成了全局理解。',
    pool_fuse: '把整条序列压缩成一个 1024 维的向量——相当于 AI 对这幅画的“整体印象”。画的所有信息在这里汇聚成一个可以拿去分类的表示。',
    logits: '分类头输出 345 个类别的原始分数（logits）。分数还没归一化，数值可正可负。右侧列出的就是此刻分数最高的 10 个类别。',
    probs: '最后一步：softmax 把 345 个分数变成总和为 1 的概率。最高的那个就是 AI 的最终答案——也就是对战大屏上显示的 Top-5 来源。'
  };

  /* ---------------- 连接 ---------------- */
  function connect() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(proto + '//' + location.host + '/ws/science');
    $('connBadge').textContent = '连接中…';
    ws.onmessage = ev => {
      let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.type === 'hello') {
        if (!m.ready) {
          $('statusNote').textContent = '科普探针未就绪（缺少 model-scope.onnx），对战不受影响';
          return;
        }
        LAYERS = m.layers || [];
        buildOverview(); buildPipeline(); layout(); drawIdle();
        if (m.probe) onProbe(m.probe);
      } else if (m.type === 'probe') {
        onProbe(m);
      }
    };
    ws.onopen = () => {
      reconnectDelay = 500;
      $('connBadge').textContent = '已连接';
      $('connBadge').className = 'badge';
    };
    ws.onclose = () => {
      $('connBadge').textContent = '断开重连中';
      $('connBadge').className = 'badge warn';
      setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(5000, reconnectDelay * 2);
    };
    ws.onerror = () => { try { ws.close(); } catch (e) {} };
  }

  function onProbe(m) {
    if (paused) return;
    probeData = m;
    $('statusNote').textContent = '实时拆解中 · 帧 #' + (m.seq || 0) + ' · 平板上作画即可看到变化';
    render();
    if (tourWanted && !autoTimer && LAYERS.length) startTour();
  }

  /* ---------------- 全景：4×3 网格，11 层 + 答案卡 ---------------- */
  function groupOf(key) {
    if (SITES[0].keys.includes(key)) return 1;
    if (SITES[1].keys.includes(key)) return 2;
    if (SITES[2].keys.includes(key)) return 3;
    return 4;
  }

  function buildOverview() {
    const box = $('ovGrid'); box.innerHTML = '';
    LAYERS.forEach((meta, i) => {
      const card = document.createElement('div');
      card.className = 'ov-card g' + groupOf(meta.key);
      card.dataset.i = i;
      card.title = '第 ' + (i + 1) + ' 层 · ' + meta.name + '（点击放大细看）';
      card.innerHTML =
        '<div class="ov-head"><span class="ov-num">LAYER ' + String(i + 1).padStart(2, '0') + '</span>' +
        '<span class="ov-name">' + escapeHtml(meta.name) + '</span></div>' +
        '<div class="ov-canvas-wrap"><canvas class="ov-canvas" width="440" height="200"></canvas></div>' +
        '<div class="ov-sub">' + escapeHtml(BRIEF[meta.key] || meta.sub || '') + '</div>' +
        '<div class="ov-metric"><span>输出 <b>—</b></span><span>范围 <b>—</b></span></div>';
      card.onclick = () => { setView('detail'); selectLayer(i, false); };
      box.appendChild(card);
    });
    // 第 12 格：答案总结卡
    const fin = document.createElement('div');
    fin.className = 'ov-card final';
    fin.id = 'ovFinal';
    fin.title = '查看最终答案层的详细拆解';
    fin.innerHTML =
      '<div class="ov-head"><span class="ov-num">RESULT</span><span class="ov-name">AI 的最终结论</span></div>' +
      '<div class="final-body"><div class="final-word" id="finalWord">等待作画</div>' +
      '<div class="final-pct" id="finalPct"></div>' +
      '<div class="final-rank" id="finalRank"></div></div>' +
      '<div class="ov-metric"><span>345 类 → softmax → 概率</span></div>';
    fin.onclick = () => { setView('detail'); selectLayer(LAYERS.length - 1, false); };
    box.appendChild(fin);
  }

  function renderOverview() {
    if (!LAYERS.length) return;
    LAYERS.forEach((meta, i) => {
      const card = $('ovGrid').children[i];
      if (!card) return;
      const layer = probeData && (probeData.layers || []).find(l => l.key === meta.key);
      paintThumb(card.querySelector('canvas'), layer, meta);
      const metric = card.querySelector('.ov-metric');
      if (metric) {
        metric.innerHTML = layer
          ? '<span>输出 <b>[' + layer.shape.join(',') + ']</b></span>' +
            '<span>范围 <b>' + layer.min.toFixed(2) + ' ~ ' + layer.max.toFixed(2) + '</b></span>'
          : '<span>等待数据</span>';
      }
    });
    // 答案总结卡
    const top = (probeData && probeData.top10) || [];
    const first = top[0];
    $('finalWord').textContent = first ? first.zh : '等待作画';
    $('finalPct').textContent = first ? (first.v * 100).toFixed(1) + '%' : '';
    $('finalRank').innerHTML = top.slice(1, 4).map((t, k) =>
      '<b>' + (k + 2) + '.</b> ' + escapeHtml(t.zh) + ' ' + (t.v * 100).toFixed(0) + '%').join('<br>');
    updateAnswer();
    applySpotlight();
  }

  // 把一层的 grid 画进小卡片画布（注意力保持正方形，序列按比例，向量画频谱）
  function paintThumb(cv, layer, meta) {
    const ctx = cv.getContext('2d');
    const W = cv.width, H = cv.height;
    ctx.fillStyle = '#050a18'; ctx.fillRect(0, 0, W, H);
    if (!layer || !layer.grid) {
      ctx.strokeStyle = 'rgba(79,227,255,.06)'; ctx.lineWidth = 1;
      for (let x = 0; x < W; x += 24) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
      for (let y = 0; y < H; y += 24) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
      return;
    }
    const off = gridToImage(layer);
    ctx.imageSmoothingEnabled = true;
    if (meta.kind === 'attention') {
      const s = Math.min(W - 12, H - 12);
      ctx.drawImage(off, 0, 0, layer.gridW, layer.gridH, (W - s) / 2, (H - s) / 2, s, s);
    } else if (meta.kind === 'vector') {
      const grid = layer.grid, N = grid.length, pad = 8, base = H - 12, maxH = H - 22, bw = (W - pad * 2) / N;
      for (let i = 0; i < N; i++) {
        const v = Math.max(0, Math.min(1, grid[i] || 0));
        const h = Math.max(1, v * maxH);
        const c = heatRGB(v);
        ctx.fillStyle = 'rgb(' + c[0] + ',' + c[1] + ',' + c[2] + ')';
        ctx.fillRect(pad + i * bw, base - h, Math.max(1, bw - 0.3), h);
      }
    } else {
      // 序列层等比缩放（保持真实的 通道:时间 比例），绝不拉伸失真；居中留白
      const pad = 4, aw = W - pad * 2, ah = H - pad * 2;
      const ar = layer.gridW / layer.gridH;
      let dw = aw, dh = dw / ar;
      if (dh > ah) { dh = ah; dw = dh * ar; }
      ctx.drawImage(off, 0, 0, layer.gridW, layer.gridH, (W - dw) / 2, (H - dh) / 2, dw, dh);
    }
  }

  function applySpotlight() {
    if (view !== 'overview' || !LAYERS.length) return;
    Array.from($('ovGrid').children).forEach((c, i) => c.classList.toggle('spotlight', i === curLayer));
    Array.from($('ovPhases').children).forEach((el, i) => el.classList.toggle('active', siteActive(i)));
  }

  /* ---------------- 管线（逐层视图） ---------------- */
  function buildPipeline() {
    const box = $('pipelineNodes'); box.innerHTML = '';
    LAYERS.forEach((l, i) => {
      const el = document.createElement('div');
      el.className = 'pnode';
      el.innerHTML = '<div class="dot"></div><div class="lb"><span class="idx">' + (i + 1) + '</span>' + escapeHtml(SHORT[l.key] || l.name) + '</div>';
      el.title = '第 ' + (i + 1) + ' 层 · ' + l.name;
      el.onclick = () => selectLayer(i, false);
      box.appendChild(el);
    });
  }

  function siteActive(si) {
    if (!LAYERS.length) return false;
    const meta = LAYERS[curLayer];
    return meta ? SITES[si].keys.includes(meta.key) : false;
  }

  // 聚光灯/巡讲的下一步；fromTour=true 表示自动触发，不打断讲解
  function selectLayer(i, fromTour) {
    if (!LAYERS.length) return;
    if (!fromTour) stopTour();
    curLayer = (i + LAYERS.length) % LAYERS.length;
    render();
  }

  function setView(v) {
    view = v;
    document.body.classList.toggle('overview', v === 'overview');
    document.body.classList.toggle('detail', v === 'detail');
    $('viewOverview').classList.toggle('on', v === 'overview');
    $('viewDetail').classList.toggle('on', v === 'detail');
    if (v === 'detail') { layout(); }
    render();
  }

  function render() {
    if (!LAYERS.length) return;
    if (view === 'overview') { renderOverview(); return; }
    renderDetail();
  }

  function renderDetail() {
    if (!probeData) return;
    const meta = LAYERS[curLayer];
    const layer = (probeData.layers || []).find(l => l.key === meta.key);
    $('ddCrumb').textContent = '第 ' + (curLayer + 1) + ' 层 · ' + meta.name;
    $('layerTag').textContent = '第 ' + (curLayer + 1) + ' / ' + LAYERS.length + ' 层';
    $('bigNum').textContent = String(curLayer + 1).padStart(2, '0');
    $('layerName').textContent = meta.name;
    $('layerSub').textContent = meta.sub || '';
    $('layerDetail').textContent = DETAIL[meta.key] || '';
    $('heatTitle').textContent = meta.name + ' · ' + (meta.kind === 'attention' ? '注意力矩阵' : meta.kind === 'vector' ? '数值分布' : '激活热图（通道 × 时间）');
    $('legend').style.display = meta.kind === 'attention' || meta.kind === 'vector' ? 'none' : 'flex';
    // 底部对照说明
    const layerNow = (probeData.layers || []).find(l => l.key === meta.key);
    const prevMeta = curLayer > 0 ? LAYERS[curLayer - 1] : null;
    const prevLayer = prevMeta && (probeData.layers || []).find(l => l.key === prevMeta.key);
    $('fnTo').textContent = layerNow ? '[' + layerNow.shape.join(', ') + ']' : '这一层的输出';
    $('fnFromLabel').textContent = prevLayer ? '[' + prevLayer.shape.join(', ') + ']' : '原始笔画点序列';
    $('layerPoint').innerHTML =
      '<div class="lp-title">这一层在做什么</div>' + escapeHtml(BRIEF[meta.key] || meta.sub || '');
    Array.from($('pipelineNodes').children).forEach((el, idx) => {
      el.classList.toggle('active', idx === curLayer);
      el.classList.toggle('done', idx < curLayer);
    });

    if (layer) {
      const shape = '[' + layer.shape.join(', ') + ']';
      $('stats').innerHTML =
        '<span>输出形状 <b>' + shape + '</b></span>' +
        '<span>显示网格 <b>' + layer.gridW + '×' + layer.gridH + '</b></span>' +
        '<span>激活范围 <b>' + layer.min.toFixed(3) + ' ~ ' + layer.max.toFixed(3) + '</b></span>' +
        '<span>均值 <b>' + layer.mean.toFixed(3) + '</b></span>';
      $('engineer').textContent =
        '输出 shape : ' + shape + '\n' +
        '显示网格   : ' + layer.gridW + ' × ' + layer.gridH + '\n' +
        '激活范围   : [' + layer.min.toFixed(4) + ', ' + layer.max.toFixed(4) + ']\n' +
        '平均激活   : ' + layer.mean.toFixed(4) + '\n' +
        '说明       : 颜色为 |激活值| 归一化后的映射，非原始颜色';
      if (meta.kind === 'attention') drawAttention(layer);
      else if (meta.kind === 'vector') drawSpectrum(layer, meta.key);
      else drawSequence(layer, meta.key);
    } else {
      $('stats').innerHTML = '<span>该层暂无数据</span>';
      $('engineer').textContent = '该层暂无数据';
      drawIdle();
    }
    drawStrokes(probeData.strokes || []);
    drawTop(probeData.top10 || []);
    updateAnswer();
  }

  function updateAnswer() {
    const t = probeData && probeData.top10 && probeData.top10[0];
    $('arWord').textContent = t ? t.zh : '等待作画';
    $('arPct').textContent = t ? (t.v * 100).toFixed(1) + '%' : '';
    $('answerReveal').classList.toggle('reveal', view === 'overview' || curLayer >= LAYERS.length - 2);
  }

  /* ---------------- 绘制 ---------------- */
  function heatRGB(v) {
    // 柔和连续的科学配色（深蓝→蓝→青→绿→金），避免大面积刺眼红黄
    const stops = [
      [0, [8, 16, 38]], [0.25, [26, 78, 138]], [0.5, [34, 158, 178]],
      [0.72, [86, 200, 150]], [0.88, [190, 214, 110]], [1, [255, 214, 120]]
    ];
    for (let i = 0; i < stops.length - 1; i++) {
      if (v <= stops[i + 1][0]) {
        const t = (v - stops[i][0]) / (stops[i + 1][0] - stops[i][0]);
        const a = stops[i][1], b = stops[i + 1][1];
        return [Math.round(a[0] + (b[0] - a[0]) * t), Math.round(a[1] + (b[1] - a[1]) * t), Math.round(a[2] + (b[2] - a[2]) * t)];
      }
    }
    return [255, 96, 86];
  }

  function gridToImage(layer) {
    const { grid, gridW, gridH } = layer;
    const off = document.createElement('canvas');
    off.width = gridW; off.height = gridH;
    const octx = off.getContext('2d');
    const img = octx.createImageData(gridW, gridH);
    for (let i = 0; i < grid.length; i++) {
      const c = heatRGB(Math.max(0, Math.min(1, grid[i] || 0)));
      img.data[i * 4] = c[0]; img.data[i * 4 + 1] = c[1]; img.data[i * 4 + 2] = c[2]; img.data[i * 4 + 3] = 255;
    }
    octx.putImageData(img, 0, 0);
    return off;
  }

  function drawIdle() {
    const W = heroCanvas.width, H = heroCanvas.height;
    hctx.fillStyle = '#050a18'; hctx.fillRect(0, 0, W, H);
    hctx.strokeStyle = 'rgba(79,227,255,.06)'; hctx.lineWidth = 1;
    for (let x = 0; x < W; x += 40) { hctx.beginPath(); hctx.moveTo(x, 0); hctx.lineTo(x, H); hctx.stroke(); }
    for (let y = 0; y < H; y += 40) { hctx.beginPath(); hctx.moveTo(0, y); hctx.lineTo(W, y); hctx.stroke(); }
    hctx.font = '26px "Microsoft YaHei",sans-serif'; hctx.textAlign = 'center'; hctx.textBaseline = 'middle';
    hctx.fillStyle = 'rgba(147,168,212,.5)';
    hctx.fillText('在平板上作画，这里会实时点亮每一层', W / 2, H / 2);
  }

  // 输入层专用：左「你的画 + 按时间着色的采样点」 → 右「拆成的 dx/dy/抬笔 信号」，一眼看懂对应关系
  function drawInputMapping(layer) {
    const W = heroCanvas.width, H = heroCanvas.height;
    hctx.fillStyle = '#040914'; hctx.fillRect(0, 0, W, H);
    const strokes = (probeData && probeData.strokes) || [];
    const gap = 40, halfW = (W - gap) / 2, pad = 24;
    // 中线分隔
    hctx.strokeStyle = 'rgba(255,210,102,.25)'; hctx.setLineDash([6, 6]); hctx.lineWidth = 1;
    hctx.beginPath(); hctx.moveTo(W / 2, 20); hctx.lineTo(W / 2, H - 20); hctx.stroke();
    hctx.setLineDash([]);
    hctx.textAlign = 'left'; hctx.textBaseline = 'top';
    hctx.font = 'bold 17px "Microsoft YaHei",sans-serif'; hctx.fillStyle = '#cfe0ff';
    hctx.fillText('① 你画下的轨迹', pad, 14);
    hctx.fillText('② AI 记下的运动信号', W / 2 + pad, 14);
    hctx.font = '12px "Microsoft YaHei",sans-serif'; hctx.fillStyle = '#7f93c4';
    hctx.fillText('线越亮 = 越晚画到', pad, 38);
    hctx.fillText('每个时刻：移动量 dx / dy + 是否抬笔', W / 2 + pad, 38);

    // ---- 左：按时间着色的原始轨迹 ----
    const bx = pad, by = 62, bw = halfW - pad * 2, bh = H - by - 30;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, total = 0;
    for (const s of strokes) for (const p of (s.points || [])) {
      minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]);
      minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]); total++;
    }
    hctx.fillStyle = 'rgba(8,16,36,.6)'; hctx.fillRect(bx, by, bw, bh);
    hctx.strokeStyle = 'rgba(31,48,89,.6)'; hctx.strokeRect(bx + 0.5, by + 0.5, bw, bh);
    if (isFinite(minX) && total > 1) {
      const span = Math.max(maxX - minX, maxY - minY) || 1;
      const k = Math.min(bw, bh) * 0.82 / span;
      const ox = bx + bw / 2 - (minX + maxX) / 2 * k;
      const oy = by + bh / 2 - (minY + maxY) / 2 * k;
      // 逐段按时间着色（由暗青到亮金），体现"先后顺序"
      let idx = 0;
      hctx.lineCap = 'round'; hctx.lineJoin = 'round'; hctx.lineWidth = 3;
      for (const s of strokes) {
        const pts = s.points || [];
        for (let i = 1; i < pts.length; i++) {
          const t = idx / total;
          hctx.strokeStyle = timeColor(t);
          hctx.beginPath();
          hctx.moveTo(ox + pts[i-1][0] * k, oy + pts[i-1][1] * k);
          hctx.lineTo(ox + pts[i][0] * k, oy + pts[i][1] * k);
          hctx.stroke();
          idx++;
        }
        idx++;
      }
      // 起点 / 终点标记
      const first = strokes[0] && strokes[0].points && strokes[0].points[0];
      const lastS = strokes[strokes.length-1], last = lastS && lastS.points && lastS.points[lastS.points.length-1];
      if (first) { hctx.fillStyle = '#6ef0a8'; hctx.beginPath(); hctx.arc(ox+first[0]*k, oy+first[1]*k, 6, 0, Math.PI*2); hctx.fill(); }
      if (last) { hctx.fillStyle = '#ff7a5c'; hctx.beginPath(); hctx.arc(ox+last[0]*k, oy+last[1]*k, 6, 0, Math.PI*2); hctx.fill(); }
      if (first) { hctx.font = '12px "Microsoft YaHei",sans-serif'; hctx.textAlign='left'; hctx.textBaseline='middle'; hctx.fillStyle='#6ef0a8'; hctx.fillText('起', ox+first[0]*k+10, oy+first[1]*k); }
    }

    // ---- 右：dx/dy/抬笔 三条信号带（用真实 grid） ----
    const grid = layer.grid || [], gw = layer.gridW, gh = layer.gridH;
    const rx = W/2 + pad, ry = by, rw = halfW - pad*2, rh = bh;
    hctx.fillStyle = 'rgba(8,16,36,.6)'; hctx.fillRect(rx, ry, rw, rh);
    hctx.strokeStyle = 'rgba(31,48,89,.6)'; hctx.strokeRect(rx + 0.5, ry + 0.5, rw, rh);
    const off = gridToImage(layer);
    hctx.imageSmoothingEnabled = false;
    hctx.drawImage(off, 0, 0, gw, gh, rx, ry, rw, rh);
    const labels = ['dx 横移', 'dy 纵移', '抬笔'];
    if (gh === 3) {
      hctx.font = '14px "Microsoft YaHei",sans-serif'; hctx.textBaseline = 'middle'; hctx.textAlign = 'left';
      labels.forEach((t, i) => {
        hctx.fillStyle = 'rgba(4,9,20,.72)'; hctx.fillRect(rx+2, ry + rh*i/3 + 2, 82, rh/3 - 4);
        hctx.fillStyle = '#eaf4ff'; hctx.fillText(t, rx+8, ry + rh*(i+0.5)/3);
      });
    }
    hctx.font = '12px Consolas,monospace'; hctx.fillStyle = 'rgba(147,168,212,.7)';
    hctx.textAlign = 'left'; hctx.textBaseline = 'bottom'; hctx.fillText('时间 0', rx, ry + rh + 20);
    hctx.textAlign = 'right'; hctx.fillText('时间 ' + gw, rx + rw, ry + rh + 20);
  }

  function timeColor(t) {
    // 由暗青 -> 青 -> 金，表达时间先后
    const a = [40, 110, 150], b = [255, 214, 102];
    return 'rgb(' + Math.round(a[0]+(b[0]-a[0])*t) + ',' + Math.round(a[1]+(b[1]-a[1])*t) + ',' + Math.round(a[2]+(b[2]-a[2])*t) + ')';
  }

  function drawSequence(layer, key) {
    if (key === 'input' && layer.gridH === 3) { drawInputMapping(layer); return; }
    const W = heroCanvas.width, H = heroCanvas.height;
    hctx.fillStyle = '#040914'; hctx.fillRect(0, 0, W, H);
    const { gridW, gridH } = layer;
    const off = gridToImage(layer);
    const axisH = 34, topPad = 20;
    const availW = W - 40, availH = H - axisH - topPad - 10;
    const ar = gridW / gridH;
    let dw = availW, dh = dw / ar;
    if (dh > availH) { dh = availH; dw = dh * ar; }
    const ox = (W - dw) / 2, oy = topPad + (availH - dh) / 2;
    hctx.imageSmoothingEnabled = true;
    hctx.drawImage(off, 0, 0, gridW, gridH, ox, oy, dw, dh);
    hctx.strokeStyle = 'rgba(207,224,255,.16)'; hctx.lineWidth = 1;
    hctx.strokeRect(ox - 0.5, oy - 0.5, dw + 1, dh + 1);
    hctx.fillStyle = 'rgba(147,168,212,.8)'; hctx.font = '14px Consolas,monospace';
    hctx.textBaseline = 'bottom'; hctx.textAlign = 'center';
    const steps = 8, axisY = oy + dh;
    for (let i = 0; i <= steps; i++) {
      const x = ox + dw * i / steps;
      hctx.beginPath(); hctx.moveTo(x, axisY); hctx.lineTo(x, axisY + 6); hctx.stroke();
      hctx.fillText(String(Math.round(gridW * i / steps)), x, axisY + 24);
    }
    hctx.save(); hctx.translate(ox - 12, oy + dh / 2); hctx.rotate(-Math.PI / 2);
    hctx.font = '13px "Microsoft YaHei",sans-serif'; hctx.fillStyle = 'rgba(127,147,196,.7)';
    hctx.textAlign = 'center'; hctx.textBaseline = 'top'; hctx.fillText('通道 × 时间', 0, 0); hctx.restore();
  }

  function drawAttention(layer) {
    const W = heroCanvas.width, H = heroCanvas.height;
    hctx.fillStyle = '#050a18'; hctx.fillRect(0, 0, W, H);
    const { gridW, gridH } = layer;
    const size = Math.min(W - 150, H - 80);
    const ox = (W - size) / 2 + 20, oy = (H - size) / 2 + 12;
    const off = gridToImage(layer);
    hctx.imageSmoothingEnabled = true;
    hctx.drawImage(off, 0, 0, gridW, gridH, ox, oy, size, size);
    hctx.strokeStyle = 'rgba(207,224,255,.18)'; hctx.lineWidth = 1;
    hctx.strokeRect(ox - 0.5, oy - 0.5, size + 1, size + 1);
    hctx.strokeStyle = 'rgba(234,242,255,.10)'; hctx.lineWidth = 1;
    for (let i = 0; i <= gridW; i += 4) {
      const p = ox + size * i / gridW;
      hctx.beginPath(); hctx.moveTo(p, oy); hctx.lineTo(p, oy + size); hctx.stroke();
      const q = oy + size * i / gridH;
      hctx.beginPath(); hctx.moveTo(ox, q); hctx.lineTo(ox + size, q); hctx.stroke();
    }
    hctx.strokeStyle = 'rgba(255,255,255,.22)'; hctx.setLineDash([6, 6]);
    hctx.beginPath(); hctx.moveTo(ox, oy); hctx.lineTo(ox + size, oy + size); hctx.stroke();
    hctx.setLineDash([]);
    hctx.fillStyle = 'rgba(147,168,212,.85)'; hctx.font = '15px "Microsoft YaHei",sans-serif';
    hctx.textAlign = 'center'; hctx.textBaseline = 'bottom'; hctx.fillText('← 当前时刻的笔画看向哪些时刻 →', ox + size / 2, oy - 12);
    hctx.save(); hctx.translate(ox - 24, oy + size / 2); hctx.rotate(-Math.PI / 2);
    hctx.fillText('被关注的时刻', 0, 0); hctx.restore();
  }

  function drawSpectrum(layer, key) {
    const W = heroCanvas.width, H = heroCanvas.height;
    hctx.fillStyle = '#050a18'; hctx.fillRect(0, 0, W, H);
    const grid = layer.grid || [], N = grid.length;
    if (!N) return;
    const pad = 48, base = H - 46, maxH = H - 100, bw = (W - pad * 2) / N;
    const hi = new Set();
    if ((key === 'probs' || key === 'logits') && probeData && probeData.top10) probeData.top10.forEach(t => hi.add(t.i));
    for (let i = 0; i < N; i++) {
      const v = Math.max(0, Math.min(1, grid[i] || 0));
      const h = Math.max(1, v * maxH);
      const c = heatRGB(v);
      hctx.fillStyle = 'rgb(' + c[0] + ',' + c[1] + ',' + c[2] + ')';
      hctx.fillRect(pad + i * bw, base - h, Math.max(1, bw - 0.4), h);
    }
    hctx.strokeStyle = 'rgba(255,210,102,.9)'; hctx.lineWidth = 1;
    hi.forEach(i => {
      const v = Math.max(0, Math.min(1, grid[i] || 0));
      const h = Math.max(1, v * maxH);
      hctx.strokeRect(pad + i * bw - 1, base - h - 2, Math.max(2, bw + 1), h + 3);
    });
    hctx.strokeStyle = 'rgba(207,224,255,.35)';
    hctx.beginPath(); hctx.moveTo(pad, base + 1); hctx.lineTo(W - pad, base + 1); hctx.stroke();
    hctx.fillStyle = 'rgba(147,168,212,.8)'; hctx.font = '13px Consolas,monospace';
    hctx.textAlign = 'left'; hctx.textBaseline = 'bottom'; hctx.fillText('类别 0', pad, H - 8);
    hctx.textAlign = 'right'; hctx.fillText('类别 ' + (N - 1), W - pad, H - 8);
  }

  function drawStrokes(strokes) {
    const W = strokeCanvas.width, H = strokeCanvas.height;
    sctx.clearRect(0, 0, W, H);
    sctx.fillStyle = '#0a1228'; sctx.fillRect(0, 0, W, H);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const s of strokes) for (const p of (s.points || [])) {
      minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]);
      minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]);
    }
    if (!isFinite(minX)) return;
    const sc = Math.max(maxX - minX, maxY - minY) || 1;
    const pad = 14, area = Math.min(W, H) - pad * 2, k = area / sc;
    const ox = (W - area) / 2 - minX * k, oy = (H - area) / 2 - minY * k;
    sctx.strokeStyle = '#eaf4ff'; sctx.lineWidth = 2.4; sctx.lineCap = 'round'; sctx.lineJoin = 'round';
    for (const s of strokes) {
      const pts = s.points || [];
      if (!pts.length) continue;
      sctx.beginPath();
      sctx.moveTo(ox + pts[0][0] * k, oy + pts[0][1] * k);
      for (let i = 1; i < pts.length; i++) sctx.lineTo(ox + pts[i][0] * k, oy + pts[i][1] * k);
      sctx.stroke();
    }
  }

  function drawTop(top) {
    const box = $('topList'); box.innerHTML = '';
    top.forEach((t, i) => {
      const row = document.createElement('div');
      row.className = 'trow';
      row.innerHTML = '<span class="rank">' + (i + 1) + '</span>' +
        '<span class="name" title="' + escapeHtml(t.en || '') + '">' + escapeHtml(t.zh) + '</span>' +
        '<span class="track"><div class="fill" style="width:' + (t.v * 100).toFixed(1) + '%"></div></span>' +
        '<span class="pct">' + (t.v * 100).toFixed(1) + '%</span>';
      box.appendChild(row);
    });
  }

  /* ---------------- 管线流动动画 ---------------- */
  const particles = Array.from({ length: 40 }, () => ({
    x: Math.random(), speed: 0.00006 + Math.random() * 0.00014, r: 1 + Math.random() * 2
  }));

  function layout() {
    dpr = window.devicePixelRatio || 1;
    fw = flowCanvas.clientWidth; fh = flowCanvas.clientHeight;
    flowCanvas.width = Math.max(1, Math.round(fw * dpr));
    flowCanvas.height = Math.max(1, Math.round(fh * dpr));
    fctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const dot = $('pipelineNodes').querySelector('.pnode .dot');
    if (dot) {
      const a = dot.getBoundingClientRect(), b = flowCanvas.getBoundingClientRect();
      railY = a.top - b.top + a.height / 2;
    }
    if (view === 'detail') {
      heroCanvas.width = Math.max(1, Math.round(heroCanvas.clientWidth));
      heroCanvas.height = Math.max(1, Math.round(heroCanvas.clientHeight));
      if (probeData) renderDetail(); else drawIdle();
    }
  }

  let lastTs = 0;
  function loop(ts) {
    const dt = Math.min(64, ts - lastTs || 16); lastTs = ts;
    if (fw > 0 && view === 'detail') {
      fctx.clearRect(0, 0, fw, fh);
      const grad = fctx.createLinearGradient(0, 0, fw, 0);
      grad.addColorStop(0, 'rgba(79,227,255,0)');
      grad.addColorStop(0.12, 'rgba(79,227,255,.4)');
      grad.addColorStop(0.88, 'rgba(192,107,255,.4)');
      grad.addColorStop(1, 'rgba(192,107,255,0)');
      fctx.strokeStyle = grad; fctx.lineWidth = 2;
      fctx.beginPath(); fctx.moveTo(0, railY); fctx.lineTo(fw, railY); fctx.stroke();
      const passX = LAYERS.length > 1 ? curLayer / (LAYERS.length - 1) : 0;
      for (const p of particles) {
        p.x += p.speed * dt;
        if (p.x > 1) p.x -= 1;
        const x = p.x * fw, past = p.x <= passX;
        fctx.beginPath();
        fctx.arc(x, railY + Math.sin(p.x * 24 + ts / 400) * 1.6, p.r, 0, Math.PI * 2);
        fctx.fillStyle = past ? 'rgba(79,227,255,.95)' : 'rgba(147,168,212,.4)';
        fctx.shadowBlur = past ? 10 : 0; fctx.shadowColor = '#4fe3ff';
        fctx.fill(); fctx.shadowBlur = 0;
      }
    }
    requestAnimationFrame(loop);
  }

  /* ---------------- 控制 ---------------- */
  function startTour() {
    if (autoTimer || !LAYERS.length) return;
    tourWanted = true;
    $('autoTour').classList.add('on');
    $('autoTour').textContent = '讲解中';
    autoTimer = setInterval(() => selectLayer(curLayer + 1, true), TOUR_MS);
  }
  function stopTour() {
    tourWanted = false;
    if (autoTimer) { clearInterval(autoTimer); autoTimer = null; }
    $('autoTour').classList.remove('on');
    $('autoTour').textContent = '自动讲解';
  }
  $('viewOverview').onclick = () => setView('overview');
  $('viewDetail').onclick = () => setView('detail');
  $('backOverview').onclick = () => setView('overview');
  $('prevLayer').onclick = () => selectLayer(curLayer - 1, false);
  $('nextLayer').onclick = () => selectLayer(curLayer + 1, false);
  $('autoTour').onclick = () => { if (autoTimer) stopTour(); else startTour(); };
  $('togglePause').onclick = e => {
    paused = !paused;
    e.target.textContent = paused ? '继续' : '暂停';
    e.target.classList.toggle('on', paused);
    $('statusNote').textContent = paused ? '已暂停 · 定格在当前帧' : '实时拆解中';
  };
  $('toggleMode').onclick = e => {
    engineer = !engineer;
    document.body.classList.toggle('engineer', engineer);
    $('modeBadge').textContent = engineer ? '工程师模式' : '新手模式';
    e.target.classList.toggle('on', engineer);
  };
  window.addEventListener('keydown', e => {
    if (e.key === 'ArrowLeft') selectLayer(curLayer - 1, false);
    else if (e.key === 'ArrowRight') selectLayer(curLayer + 1, false);
    else if (e.key === ' ') { e.preventDefault(); $('togglePause').click(); }
    else if (e.key >= '1' && e.key <= '4') {
      const s = SITES[Number(e.key) - 1];
      const idx = LAYERS.findIndex(l => l.key === s.keys[0]);
      if (idx >= 0) selectLayer(idx, false);
    }
  });
  window.addEventListener('resize', layout);

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  connect();
  requestAnimationFrame(loop);
})();
