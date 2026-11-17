'use strict';
(function () {
  const $ = id => document.getElementById(id);
  const heatCanvas = $('heatCanvas'), hctx = heatCanvas.getContext('2d');
  const strokeCanvas = $('strokeCanvas'), sctx = strokeCanvas.getContext('2d');

  let ws = null, reconnectDelay = 500;
  let LAYERS = [];           // 层元信息
  let probeData = null;      // 最近一次探针数据
  let curLayer = 0;          // 当前层索引
  let paused = false;        // 暂停自动跟随最新帧
  let engineer = false;
  const SITES = [            // 教学站点：layer key 分组
    { name: '① 看笔画', keys: ['input', 'cnn_multiscale', 'se_channel1', 'cnn_deep'] },
    { name: '② 读顺序', keys: ['bilstm1', 'bilstm2'] },
    { name: '③ 找关联', keys: ['mha_attention', 'mha_out'] },
    { name: '④ 下结论', keys: ['pool_fuse', 'logits', 'probs'] }
  ];

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

  function connect() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(proto + '//' + location.host + '/ws/science');
    $('connBadge').textContent = '连接中…';
    ws.onopen = () => { reconnectDelay = 500; $('connBadge').textContent = '已连接'; $('connBadge').className = 'badge'; };
    ws.onmessage = ev => {
      let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.type === 'hello') {
        if (!m.ready) { $('statusNote').textContent = '科普探针未就绪（缺少 model-scope.onnx），对战不受影响'; return; }
        LAYERS = m.layers || [];
        buildNav(); buildSites();
        if (m.probe) onProbe(m.probe);
      } else if (m.type === 'probe') {
        onProbe(m);
      }
    };
    ws.onclose = () => {
      $('connBadge').textContent = '断开重连中'; $('connBadge').className = 'badge warn';
      setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(5000, reconnectDelay * 2);
    };
    ws.onerror = () => { try { ws.close(); } catch (e) {} };
  }

  function onProbe(m) {
    probeData = m;
    $('frameSeq').textContent = '#' + (m.seq || 0);
    if (!paused) render();
    $('statusNote').textContent = '实时拆解中 · 帧 #' + (m.seq || 0) + ' · 在平板上作画即可看到变化';
  }

  function buildNav() {
    const nav = $('layerNav'); nav.innerHTML = '';
    LAYERS.forEach((l, i) => {
      const el = document.createElement('div');
      el.className = 'ln' + (i === curLayer ? ' active' : '');
      el.innerHTML = '<span class="n">' + (i + 1) + '</span>' + l.name;
      el.onclick = () => selectLayer(i);
      nav.appendChild(el);
    });
  }

  function buildSites() {
    const box = $('siteTabs'); box.innerHTML = '';
    SITES.forEach((s, i) => {
      const el = document.createElement('div');
      el.className = 'site' + (siteActive(i) ? ' active' : '');
      el.textContent = s.name;
      el.onclick = () => {
        const idx = LAYERS.findIndex(l => l.key === s.keys[0]);
        if (idx >= 0) selectLayer(idx);
      };
      box.appendChild(el);
    });
  }

  function siteActive(si) {
    if (!LAYERS.length) return false;
    const key = LAYERS[curLayer] && LAYERS[curLayer].key;
    return SITES[si].keys.includes(key);
  }

  function selectLayer(i) {
    if (!LAYERS.length) return;
    curLayer = (i + LAYERS.length) % LAYERS.length;
    Array.from($('layerNav').children).forEach((el, idx) => el.classList.toggle('active', idx === curLayer));
    Array.from($('siteTabs').children).forEach((el, idx) => el.classList.toggle('active', siteActive(idx)));
    render();
  }

  function render() {
    if (!probeData || !LAYERS.length) return;
    const meta = LAYERS[curLayer];
    const layer = (probeData.layers || []).find(l => l.key === meta.key);
    $('layerName').textContent = '第 ' + (curLayer + 1) + ' 层 · ' + meta.name;
    $('layerSub').textContent = meta.sub;
    $('layerDetail').textContent = DETAIL[meta.key] || '';
    $('heatTitle').textContent = meta.name + ' · ' + (meta.kind === 'attention' ? '注意力矩阵' : meta.kind === 'vector' ? '数值分布' : '激活热图（通道 × 时间）');
    if (layer) {
      $('engineer').textContent =
        '输出 shape : [' + layer.shape.join(', ') + ']\n' +
        '显示网格   : ' + layer.gridW + ' × ' + layer.gridH + '\n' +
        '激活范围   : [' + layer.min.toFixed(4) + ', ' + layer.max.toFixed(4) + ']\n' +
        '平均激活   : ' + layer.mean.toFixed(4) + '\n' +
        '说明       : 颜色为 |激活值| 归一化后的映射，非原始颜色';
      drawHeat(layer);
    } else {
      hctx.clearRect(0, 0, heatCanvas.width, heatCanvas.height);
      $('engineer').textContent = '该层暂无数据';
    }
    drawStrokes(probeData.strokes || []);
    drawTop(probeData.top10 || []);
  }

  // 热图渲染：把归一化 grid 画成彩色像素，放大到画布
  function drawHeat(layer) {
    const { grid, gridW, gridH } = layer;
    const W = heatCanvas.width, H = heatCanvas.height;
    hctx.clearRect(0, 0, W, H);
    hctx.fillStyle = '#0a1228'; hctx.fillRect(0, 0, W, H);
    // 通道极少时（输入层）左侧留出标签区
    const labels = (layer.key === 'input' && gridH === 3) ? ['dx 横移', 'dy 纵移', '抬笔'] : null;
    const labelW = labels ? 96 : 0;
    const drawW = W - labelW;
    const cw = drawW / gridW, ch = H / gridH;
    for (let y = 0; y < gridH; y++) {
      for (let x = 0; x < gridW; x++) {
        const v = Math.max(0, Math.min(1, grid[y * gridW + x] || 0));
        hctx.fillStyle = heatColor(v);
        hctx.fillRect(labelW + x * cw, y * ch, Math.ceil(cw), Math.ceil(ch));
      }
    }
    if (labels) {
      hctx.font = '18px "Microsoft YaHei",sans-serif';
      hctx.textAlign = 'left'; hctx.textBaseline = 'middle';
      labels.forEach((t, i) => {
        hctx.fillStyle = '#cfe0ff';
        hctx.fillText(t, 8, (i + 0.5) * ch);
      });
    }
  }

  function heatColor(v) {
    // 深蓝 -> 蓝 -> 青 -> 黄 -> 橙红
    const stops = [
      [0.0, [10, 18, 40]], [0.25, [27, 110, 168]], [0.5, [97, 213, 255]],
      [0.75, [255, 224, 138]], [1.0, [255, 122, 92]]
    ];
    for (let i = 0; i < stops.length - 1; i++) {
      if (v <= stops[i + 1][0]) {
        const t = (v - stops[i][0]) / (stops[i + 1][0] - stops[i][0]);
        const a = stops[i][1], b = stops[i + 1][1];
        return `rgb(${Math.round(a[0] + (b[0]-a[0])*t)},${Math.round(a[1] + (b[1]-a[1])*t)},${Math.round(a[2] + (b[2]-a[2])*t)})`;
      }
    }
    return 'rgb(255,122,92)';
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
    const pad = 30, area = Math.min(W, H) - pad * 2;
    const ox = (W - area) / 2 - minX * (area / sc) + pad * 0;
    const oy = (H - area) / 2 - minY * (area / sc);
    const k = area / sc;
    sctx.strokeStyle = '#eaf4ff'; sctx.lineWidth = 3; sctx.lineCap = 'round'; sctx.lineJoin = 'round';
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
    const target = probeData && probeData.targetIndex;
    top.forEach((t, i) => {
      const row = document.createElement('div');
      row.className = 'trow' + (i === 0 ? ' hit' : '');
      row.innerHTML = '<span class="rank">' + (i + 1) + '</span>' +
        '<span class="name" title="' + (t.en || '') + '">' + escapeHtml(t.zh) + '</span>' +
        '<span class="track"><div class="fill" style="width:' + (t.v * 100).toFixed(1) + '%"></div></span>' +
        '<span class="pct">' + (t.v * 100).toFixed(1) + '%</span>';
      box.appendChild(row);
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  $('prevLayer').onclick = () => selectLayer(curLayer - 1);
  $('nextLayer').onclick = () => selectLayer(curLayer + 1);
  $('togglePause').onclick = e => {
    paused = !paused;
    e.target.textContent = paused ? '继续' : '暂停';
    e.target.classList.toggle('on', paused);
    $('statusNote').textContent = paused ? '已暂停 · 定格在当前帧，可逐层讲解' : '实时拆解中';
  };
  $('toggleMode').onclick = e => {
    engineer = !engineer;
    document.body.classList.toggle('engineer', engineer);
    $('modeBadge').textContent = engineer ? '工程师模式' : '新手模式';
    e.target.classList.toggle('on', engineer);
  };
  window.addEventListener('keydown', e => {
    if (e.key === 'ArrowLeft') selectLayer(curLayer - 1);
    else if (e.key === 'ArrowRight') selectLayer(curLayer + 1);
    else if (e.key === ' ') { e.preventDefault(); $('togglePause').click(); }
    else if (e.key >= '1' && e.key <= '4') {
      const s = SITES[Number(e.key) - 1];
      const idx = LAYERS.findIndex(l => l.key === s.keys[0]);
      if (idx >= 0) selectLayer(idx);
    }
  });

  connect();
})();
