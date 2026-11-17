'use strict';
/**
 * 选手个人计分模块。
 *
 * 计分规则（与团队「人类分」完全一致）：
 *   - AI 一眼认出(Top-1)      → 选手 +1（画得传神）
 *   - 险胜(AI 第 2~3 位认出)  → 选手 +2（画面有辨识度）
 *   - AI 翻车(裁判判画得像)   → 选手 +2
 *   - 画得太抽象(无人得分)    → 选手 +0
 * 因此「人类团队总分」恒等于所有选手个人分之和，两套口径不会打架。
 *
 * 持久化：仅保存选手名单与分数到 data/players.json（发奖用，重启不丢）。
 * 不含任何画面 / 笔画数据 —— 原始的「画面不落盘」约束保持不变。
 */
const fs = require('fs');
const path = require('path');
const { ROOT } = require('./config');

const DATA_DIR = path.join(ROOT, 'data');
const DATA_FILE = path.join(DATA_DIR, 'players.json');

let players = [];
let currentId = null;
let autoRotate = true;
let seq = 0;
let log = () => {};

function setLogger(fn) { if (typeof fn === 'function') log = fn; }

function load() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(DATA_FILE)) {
      const d = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      if (Array.isArray(d.players)) players = d.players.map(p => ({
        id: Number(p.id) || 0,
        name: String(p.name || '').slice(0, 24),
        score: Number(p.score) || 0,
        rounds: Number(p.rounds) || 0,
        wins: Number(p.wins) || 0
      }));
      currentId = d.currentId != null ? Number(d.currentId) : null;
      autoRotate = d.autoRotate !== false;
      seq = players.reduce((m, p) => Math.max(m, p.id), 0);
    }
  } catch (e) {
    log('[选手] 读取存档失败，从空名单开始：' + e.message);
  }
}

function save() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify({
      players, currentId, autoRotate, savedAt: new Date().toISOString()
    }, null, 2));
  } catch (e) {
    log('[选手] 保存存档失败：' + e.message);
  }
}

function snapshot() {
  return {
    players: players.map(p => ({ ...p })),
    currentId,
    autoRotate,
    ranking: rank()
  };
}

// 排名：分高者在前；同分则轮数少者在前（效率更高），再同分则按名字
function rank() {
  return players.slice().sort((a, b) =>
    (b.score - a.score) || (a.rounds - b.rounds) || a.name.localeCompare(b.name, 'zh')
  ).map((p, i) => ({ rank: i + 1, id: p.id, name: p.name, score: p.score, rounds: p.rounds, wins: p.wins }));
}

function add(name) {
  name = String(name || '').trim().slice(0, 24);
  if (!name) return { ok: false, error: '名字不能为空' };
  if (players.some(p => p.name === name)) return { ok: false, error: '该选手已存在' };
  const p = { id: ++seq, name, score: 0, rounds: 0, wins: 0 };
  players.push(p);
  if (currentId == null) currentId = p.id;
  save();
  log(`[选手] 添加：${name}`);
  return { ok: true, snapshot: snapshot() };
}

function remove(id) {
  id = Number(id);
  const idx = players.findIndex(p => p.id === id);
  if (idx < 0) return { ok: false, error: '选手不存在' };
  const [gone] = players.splice(idx, 1);
  if (currentId === id) currentId = players.length ? players[0].id : null;
  save();
  log(`[选手] 删除：${gone.name}`);
  return { ok: true, snapshot: snapshot() };
}

function select(id) {
  id = Number(id);
  if (!players.some(p => p.id === id)) return { ok: false, error: '选手不存在' };
  currentId = id;
  save();
  const p = players.find(p => p.id === id);
  log(`[选手] 当前作画：${p.name}`);
  return { ok: true, snapshot: snapshot() };
}

function setAutoRotate(enabled) {
  autoRotate = !!enabled;
  save();
  log(`[选手] 自动轮转：${autoRotate ? '开' : '关'}`);
  return { ok: true, snapshot: snapshot() };
}

// 回合开始时确定本轮选手：直接用当前选中的（主持端高亮谁就谁画，最直观）。
// 自动轮转的「切到下一位」放在结算之后（见 award），这样下一轮开始前高亮已指向下一位。
function beginRound() {
  if (!players.length) return null;
  return players.find(p => p.id === currentId) || players[0] || null;
}

// 推进到下一位选手，为下一轮做准备
function advance() {
  if (!autoRotate || players.length < 2) return;
  const idx = players.findIndex(p => p.id === currentId);
  currentId = players[(idx + 1) % players.length].id;
}

// 结算记分：把本轮「人类得分」记到该选手名下，随后自动轮转到下一位
function award(playerId, humanPoints, winner, resultKey) {
  const p = players.find(x => x.id === playerId);
  if (!p) return null;
  p.score += Number(humanPoints) || 0;
  p.rounds += 1;
  if (winner === 'human') p.wins += 1;
  advance();
  save();
  log(`[选手] ${p.name} +${Number(humanPoints) || 0} 分（累计 ${p.score}，${p.rounds} 轮）`);
  return { id: p.id, name: p.name, score: p.score, rounds: p.rounds, wins: p.wins, gained: Number(humanPoints) || 0 };
}

// 清空分数与名单，重新开始一局（保留 autoRotate 设置）
function clear() {
  players = [];
  currentId = null;
  seq = 0;
  save();
  log('[选手] 已清空名单与分数');
  return { ok: true, snapshot: snapshot() };
}

module.exports = {
  setLogger, load, snapshot, rank, add, remove, select,
  setAutoRotate, beginRound, award, clear
};
