'use strict';
(function () {
  const $ = id => document.getElementById(id);
  const app = $('app');
  const rows = Array.from(document.querySelectorAll('.row'));
  const ranking = $('ranking');
  const waiting = $('waiting');
  const playArea = $('playArea');
  const resultOverlay = $('resultOverlay');
  const judgeOverlay = $('judgeOverlay');
  const disconnectOverlay = $('disconnectOverlay');
  const curve = $('curve');
  const cctx = curve.getContext('2d');

  let ws = null;
  let reconnectDelay = 500;
  let lastName = '';
  let scoreboard = { ai: 0, human: 0, rounds: 0, draws: 0 };
  let endTime = 0;
  let resultTimer = null;
  let history = [];
  let frameCount = 0;
  let playerState = null;
  let gameMode = 'classic';

  function connect() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(proto + '//' + location.host + '/ws/display');
    ws.onopen = () => {
      reconnectDelay = 500;
      disconnectOverlay.classList.remove('show');
      $('statusText').textContent = '已连接服务';
      $('statusText').classList.remove('warn');
    };
    ws.onmessage = ev => {
      let m;
      try { m = JSON.parse(ev.data); } catch (e) { return; }
      handle(m);
    };
    ws.onclose = () => {
      disconnectOverlay.classList.add('show');
      $('discTitle').textContent = '与服务断开连接';
      $('discDetail').textContent = `正在自动重连（${(reconnectDelay / 1000).toFixed(1)}s）…`;
      setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(5000, reconnectDelay * 2);
    };
    ws.onerror = () => { try { ws.close(); } catch (e) {} };
  }

  function handle(m) {
    if (m.type === 'view') {
      if (m.view === 'rules') $('rulesOverlay').classList.add('show');
      else $('rulesOverlay').classList.remove('show');
      return;
    }
    if (m.type === 'mode') { gameMode = m.gameMode; return; }
    if (m.type === 'report') {
      // 画手自述录入后，大屏裁定页同步展示
      if (judgeOverlay.classList.contains('show')) {
        $('judgeLine').innerHTML = '画手说画的是「<b>' + escapeHtml(m.report || '—') + '</b>」';
      }
      return;
    }
    if (m.type === 'players') { if (m.players) playerState = m.players; renderPlayerBar(); return; }

    if (m.type === 'hello') {
      if (m.view === 'rules') $('rulesOverlay').classList.add('show');
      if (m.config) {
        $('title').textContent = m.config.title;
        $('subtitle').textContent = m.config.subtitle;
      }
      setRoute(m.route);
      if (m.scoreboard) scoreboard = m.scoreboard;
      if (m.players) playerState = m.players;
      updateScore();
      renderPlayerBar();
      if (m.drawOnline === 0) showDrawLost();
      if (m.round && m.round.active) {
        startVisualRound(m.round.seconds, m.round.endTime);
        if (m.round.player) setRoundPlayer(m.round.player);
      }
      if (m.round && m.round.awaitingJudge) showJudge(m.round.target || '—', m.round.mode);
      if (m.round && m.round.result) showResult(m.round.result, m.scoreboard || m.round.scoreboard);
      return;
    }

    if (m.type === 'connection') {
      if (m.drawOnline === 0) showDrawLost();
      else {
        $('statusText').textContent = `已连接 · 平板 ${m.drawOnline} 台`;
        $('statusText').classList.remove('warn');
      }
      return;
    }

    if (m.type === 'roundStart') {
      gameMode = m.mode || gameMode;
      startVisualRound(m.seconds, m.endTime);
      if (m.player) setRoundPlayer(m.player);
      return;
    }
    if (m.type === 'guess') { renderGuess(m); return; }
    if (m.type === 'lock') {
      app.classList.add('locked');
      $('lockOverlay').classList.add('show');
      return;
    }
    if (m.type === 'needJudge') {
      if (m.mode === 'free') showJudge(m.aiGuess || (m.top5 && m.top5[0] ? m.top5[0].zh : '—'), 'free');
      else showJudge(m.target ? m.target.word : '—', 'classic');
      return;
    }
    if (m.type === 'roundEnd') {
      app.classList.remove('locked');
      $('lockOverlay').classList.remove('show');
      judgeOverlay.classList.remove('show');
      if (m.players) playerState = m.players;
      showResult(m.result, m.scoreboard);
      return;
    }
    if (m.type === 'roundReset') {
      app.classList.remove('locked');
      $('lockOverlay').classList.remove('show');
      judgeOverlay.classList.remove('show');
      clearTimeout(resultTimer);
      resultOverlay.classList.remove('show');
      playArea.classList.remove('show');
      waiting.classList.remove('hide');
      lastName = '';
      clearRows();
      resetThink();
    }
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function setRoute(route) {
    $('routeBadge').textContent =
      route === 'tfjs-node' ? '路线① 本机 TFJS' :
      route === 'onnx' ? '路线② ONNX CPU' :
      route === 'browser' ? '路线③ 平板推理' : '路线检测中';
  }

  function setRoundPlayer(p) {
    if (!p) return;
    $('playerBadge').style.display = '';
    $('playerBadge').textContent = '✎ ' + p.name;
    const bar = $('curPlayerBar');
    bar.style.display = '';
    bar.querySelector('b').textContent = p.name;
  }

  function renderPlayerBar() {
    if (!playerState || !playerState.players || !playerState.players.length) {
      $('curPlayerBar').style.display = 'none';
      return;
    }
    // 结束回合后不在这里改顶部徽章（保留本轮选手）；仅维护底部当前选手
    const cur = playerState.players.find(p => p.id === playerState.currentId);
    if (cur) {
      const bar = $('curPlayerBar');
      bar.style.display = '';
      bar.querySelector('b').textContent = cur.name;
    }
  }

  function showDrawLost() {
    $('statusText').textContent = '平板断连，等待自动重连…';
    $('statusText').classList.add('warn');
  }

  function startVisualRound(seconds, endTimeValue) {
    clearTimeout(resultTimer);
    resultOverlay.classList.remove('show');
    judgeOverlay.classList.remove('show');
    app.classList.remove('locked');
    $('lockOverlay').classList.remove('show');
    playArea.classList.add('show');
    waiting.classList.add('hide');
    lastName = '';
    clearRows();
    resetThink();
    endTime = endTimeValue || Date.now() + seconds * 1000;
  }

  function resetThink() {
    history = [];
    frameCount = 0;
    $('frameCount').textContent = '0';
    $('inferMs').textContent = '0';
    $('top1zh').textContent = '—';
    $('thumb').classList.remove('show');
    $('thumbEmpty').style.display = '';
    drawCurve();
  }

  function clearRows() {
    rows.forEach(row => {
      row.querySelector('.name').textContent = '—';
      row.querySelector('.fill').style.width = '0%';
      row.querySelector('.pct').textContent = '0%';
    });
  }

  function renderGuess(m) {
    const top5 = m.top5;
    if (!Array.isArray(top5)) return;
    const changed = top5.length && top5[0].zh !== lastName;
    if (changed) lastName = top5[0].zh;

    rows.forEach((row, i) => {
      const item = top5[i];
      const nameEl = row.querySelector('.name');
      const fill = row.querySelector('.fill');
      const pct = row.querySelector('.pct');
      if (!item) {
        nameEl.textContent = '—';
        fill.style.width = '0%';
        pct.textContent = '0%';
        return;
      }
      if (nameEl.textContent !== item.zh) {
        nameEl.textContent = item.zh;
        if (i === 0 && changed) {
          row.classList.remove('flip');
          void row.offsetWidth;
          row.classList.add('flip');
        }
      }
      const value = Math.round(item.score * 100);
      fill.style.width = value + '%';
      pct.textContent = value + '%';
    });

    if (m.thumb) {
      $('thumb').src = 'data:image/png;base64,' + m.thumb;
      $('thumb').classList.add('show');
      $('thumbEmpty').style.display = 'none';
    }
    frameCount++;
    $('frameCount').textContent = String(frameCount);
    $('inferMs').textContent = String(m.inferMs || 0);
    $('top1zh').textContent = top5[0] ? top5[0].zh : '—';
    history.push(top5[0] ? top5[0].score : 0);
    if (history.length > 120) history.shift();
    drawCurve();
  }

  function drawCurve() {
    const w = curve.width, h = curve.height;
    cctx.clearRect(0, 0, w, h);
    cctx.strokeStyle = '#23315a';
    cctx.lineWidth = 1;
    [0.25, 0.5, 0.75].forEach(v => {
      const y = h * (1 - v);
      cctx.beginPath();
      cctx.moveTo(0, y);
      cctx.lineTo(w, y);
      cctx.stroke();
    });
    if (history.length < 2) return;
    const pts = history.map((v, i) => ({
      x: i / (history.length - 1) * w,
      y: h - Math.max(0, Math.min(1, v)) * h
    }));
    cctx.beginPath();
    cctx.moveTo(pts[0].x, h);
    pts.forEach(p => cctx.lineTo(p.x, p.y));
    cctx.lineTo(pts[pts.length - 1].x, h);
    cctx.closePath();
    cctx.fillStyle = 'rgba(97,213,255,.14)';
    cctx.fill();
    cctx.beginPath();
    pts.forEach((p, i) => i ? cctx.lineTo(p.x, p.y) : cctx.moveTo(p.x, p.y));
    cctx.strokeStyle = '#61d5ff';
    cctx.lineWidth = 3;
    cctx.stroke();
  }

  function showJudge(word, mode) {
    judgeOverlay.classList.add('show');
    if (mode === 'free') {
      $('judgeHeading').textContent = 'AI 给出了猜测 —— 请主持裁定';
      $('judgeLine').innerHTML = 'AI 猜的是「<b>' + escapeHtml(word || '—') + '</b>」';
      $('judgeHintLine').textContent = '主持人录入画手自述后裁定：同一种 → AI 得分　·　不是同一种 → 人类得分';
    } else {
      $('judgeHeading').textContent = 'AI 没认出来 —— 请主持裁定';
      $('judgeLine').innerHTML = '谜底是「<b>' + escapeHtml(word || '—') + '</b>」';
      $('judgeHintLine').textContent = '画得像 → AI 翻车，人类得分　·　画得太抽象 → 无人得分';
    }
  }

  function showResult(result, board) {
    if (!result) return;
    resultOverlay.className = 'show ' + (result.key || '');
    $('resultTitle').textContent = result.title;
    $('resultDetail').textContent = result.detail;
    if (board) scoreboard = board;
    updateScore();
    // 本轮选手得分
    const aw = result.playerAward;
    $('resultPlayer').textContent = aw
      ? `本轮选手 ${aw.name} +${aw.gained} 分（累计 ${aw.score} 分 · ${aw.rounds} 轮）`
      : '';
    // 发奖榜（前 5）
    const rank = playerState && playerState.ranking ? playerState.ranking : [];
    if (rank.length) {
      $('resultBoard').innerHTML = '<div style="color:#7f93c4;font-size:17px;margin-bottom:6px">当前发奖榜</div>' +
        rank.slice(0, 5).map(r => {
          const medal = r.rank === 1 ? '冠军' : r.rank === 2 ? '亚军' : r.rank === 3 ? '季军' : ('第' + r.rank + '名');
          const me = aw && r.id === aw.id ? ' class="me"' : '';
          return `<span${me}>${medal} ${escapeHtml(r.name)} <b>${r.score}</b></span>`;
        }).join('　·　');
    } else {
      $('resultBoard').innerHTML = '';
    }
    $('resultScore').textContent =
      `AI ${scoreboard.ai} : ${scoreboard.human} 人类 · 平局 ${scoreboard.draws || 0} · 共 ${scoreboard.rounds || 0} 轮`;
    clearTimeout(resultTimer);
    resultTimer = setTimeout(() => {
      resultOverlay.classList.remove('show');
      playArea.classList.remove('show');
      waiting.classList.remove('hide');
      clearRows();
      resetThink();
    }, 9000);
  }

  function updateScore() {
    $('score').textContent =
      `AI ${scoreboard.ai || 0} : ${scoreboard.human || 0} 人类 · 平局 ${scoreboard.draws || 0}`;
    $('roundNo').textContent = `第 ${scoreboard.rounds || 0} 轮`;
  }

  setInterval(() => {
    const now = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    $('clock').textContent = now;
    if ($('rulesClock')) $('rulesClock').textContent = now;
    if (endTime) {
      const left = Math.max(0, Math.ceil((endTime - Date.now()) / 1000));
      if (left <= 10 && left > 0 && playArea.classList.contains('show')) {
        $('statusText').textContent = `最后 ${left} 秒`;
        $('statusText').classList.add('warn');
      }
    }
  }, 250);

  connect();
})();
