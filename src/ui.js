/**
 * DOM UI：HUD（血条/能量条/回合计时/连击数）、中央公告、结算、选人界面
 */

const $ = (id) => document.getElementById(id);

export class UI {
  constructor() {
    this.hpView = { p1: { cur: 1, ghost: 1 }, p2: { cur: 1, ghost: 1 } };
    this.meterView = { p1: 0, p2: 0 };
    this.announceTimer = null;
    // DOM 引用缓存 + 上次写入值（避免每帧重复样式计算）
    this.el = {
      p1fill: $('p1-fill'), p1ghost: $('p1-ghost'), p1meter: $('p1-meter'), p1glow: $('p1-meter-glow'), p1pips: $('p1-pips'),
      p2fill: $('p2-fill'), p2ghost: $('p2-ghost'), p2meter: $('p2-meter'), p2glow: $('p2-meter-glow'), p2pips: $('p2-pips'),
      timer: $('timer'),
    };
    this._last = { p1fill: -1, p1ghost: -1, p1meter: -1, p2fill: -1, p2ghost: -1, p2meter: -1, timer: '', glow1: null, glow2: null, pips1: 0, pips2: 0 };
  }

  _setBar(elRef, key, v) {
    if (Math.abs(this._last[key] - v) > 0.001) {
      this._last[key] = v;
      elRef.style.transform = `scaleX(${v})`;
    }
  }

  // ---------- 界面切换 ----------
  show(id) { $(id).classList.remove('hidden'); }
  hide(id) { $(id).classList.add('hidden'); }
  showOnly(ids) {
    for (const s of ['screen-title', 'screen-select', 'screen-result', 'hud', 'ctrl-hint']) this.hide(s);
    for (const s of ids) this.show(s);
  }

  // ---------- HUD ----------
  bindHud(f1, f2) {
    $('p1-name').textContent = `P1 ${f1.char.name}`;
    $('p2-name').textContent = `P2 ${f2.char.name}`;
  }

  updateHud(f1, f2, dt) {
    const E = this.el, L = this._last;
    const side = (p, f) => {
      const v = this.hpView[p];
      const ratio = Math.max(0, f.hp / f.maxHp);
      v.cur += (ratio - v.cur) * Math.min(1, dt * 22);
      if (v.ghost > ratio) v.ghost = Math.max(ratio, v.ghost - dt * 0.22);
      else v.ghost = ratio;
      this._setBar(E[`${p}fill`], `${p}fill`, v.cur);
      this._setBar(E[`${p}ghost`], `${p}ghost`, v.ghost);
      const mt = f.meter / 100;
      this.meterView[p] += (mt - this.meterView[p]) * Math.min(1, dt * 14);
      this._setBar(E[`${p}meter`], `${p}meter`, this.meterView[p]);
      const glowOn = f.meter >= 100;
      if (L[`${p === 'p1' ? 'glow1' : 'glow2'}`] !== glowOn) {
        L[`${p === 'p1' ? 'glow1' : 'glow2'}`] = glowOn;
        E[`${p}glow`].classList.toggle('hidden', !glowOn);
      }
      const pipKey = p === 'p1' ? 'pips1' : 'pips2';
      if (L[pipKey] !== f.roundsWon) {
        L[pipKey] = f.roundsWon;
        const children = E[`${p}pips`].children;
        for (let i = 0; i < children.length; i++) children[i].classList.toggle('won', i < f.roundsWon);
      }
    };
    side('p1', f1); side('p2', f2);
  }

  setTimer(t) {
    const el = this.el.timer;
    const s = String(Math.max(0, Math.ceil(t)));
    if (this._last.timer !== s) {
      this._last.timer = s;
      el.textContent = s;
      el.style.color = Number(s) <= 10 ? '#ff6a4d' : '';
    }
  }

  showCombo(pid, count) {
    if (count < 2) return;
    const el = $(`combo-${pid}`);
    el.textContent = `${count} 连击!`;
    el.classList.remove('show');
    void el.offsetWidth;
    el.classList.add('show');
  }

  /** 立即清空连击弹幕（回合切换用，避免上一回合的连击数残留） */
  clearCombo() {
    for (const pid of ['p1', 'p2']) {
      const el = $(`combo-${pid}`);
      if (!el) continue;
      el.textContent = '';
      el.classList.remove('show');
    }
  }

  /**
   * 回合切换：HUD 数值直接对齐新一回合（不做上一回合残血的缓动/幽灵条衰减），
   * 并清空连击弹幕。主机本地重置与客机收到新回合快照时都调用。
   */
  resetRound(f1, f2) {
    this.clearCombo();
    const snap = (p, f) => {
      const ratio = Math.max(0, Math.min(1, f.hp / f.maxHp));
      this.hpView[p].cur = ratio;
      this.hpView[p].ghost = ratio;
      this.meterView[p] = f.meter / 100;
      this._last[`${p}fill`] = ratio;
      this._last[`${p}ghost`] = ratio;
      this._last[`${p}meter`] = this.meterView[p];
      this.el[`${p}fill`].style.transform = `scaleX(${ratio})`;
      this.el[`${p}ghost`].style.transform = `scaleX(${ratio})`;
      this.el[`${p}meter`].style.transform = `scaleX(${this.meterView[p]})`;
      const glowKey = p === 'p1' ? 'glow1' : 'glow2';
      const glowOn = f.meter >= 100;
      this._last[glowKey] = glowOn;
      this.el[`${p}glow`].classList.toggle('hidden', !glowOn);
      const pipKey = p === 'p1' ? 'pips1' : 'pips2';
      this._last[pipKey] = f.roundsWon;
      const children = this.el[`${p}pips`].children;
      for (let i = 0; i < children.length; i++) children[i].classList.toggle('won', i < f.roundsWon);
    };
    snap('p1', f1); snap('p2', f2);
  }

  // ---------- 中央公告 ----------
  announce(text, { dur = 1.1, size = null } = {}) {
    const el = $('announce-text');
    el.textContent = text;
    if (size) el.style.fontSize = size;
    el.classList.remove('slam');
    void el.offsetWidth;
    el.classList.add('slam');
    clearTimeout(this.announceTimer);
    this.announceTimer = setTimeout(() => { el.classList.remove('slam'); el.style.opacity = 0; }, dur * 1000);
    el.style.opacity = '';
  }

  // ---------- 结算 ----------
  showResult(winnerName, winnerLabel, s1, s2) {
    $('result-winner').textContent = `${winnerLabel} ${winnerName} 获胜！`;
    $('result-score').textContent = `${s1} - ${s2}`;
    this.show('screen-result');
  }
}
