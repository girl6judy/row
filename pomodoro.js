// =============================================================
// Pomodoro timer engine (logic only, no layout).
// Exposes window.Pomodoro. The FOCUS card in index.html and the
// FOCUS chip in topbar.js both subscribe to it.
//
// Accuracy: the remaining time is always computed from a saved end
// timestamp (endAt), never by counting down, so it stays right when
// the tab is in the background or the computer sleeps.
//
// Storage (same JSON-in-localStorage approach as the goals):
//   pomo:settings  { focusMin, shortMin, longMin, longEvery, dailyTarget, autoStart }
//   pomo:state     { phase, status, endAt, remainingMs, totalMs, startedAt,
//                    roundDone, focusGoal, prompt, today: { date, count } }
// =============================================================
(function () {
  'use strict';
  if (window.Pomodoro) return;

  const SETTINGS_KEY = 'pomo:settings';
  const STATE_KEY = 'pomo:state';
  const DEFAULTS = { focusMin: 25, shortMin: 5, longMin: 15, longEvery: 4, dailyTarget: 4, autoStart: false };
  const LIMITS = { focusMin: [1, 180], shortMin: [1, 60], longMin: [1, 90], longEvery: [2, 8], dailyTarget: [1, 24] };
  const PHASES = {
    focus: { label: 'Focus', emoji: '🍅' },
    short: { label: 'Short break', emoji: '☕' },
    long:  { label: 'Long break', emoji: '🌿' },
  };
  const LATE_CHIME_MS = 60 * 1000; // don't chime for a phase that ended long ago (e.g. tab was closed)

  // ---------- storage ----------
  function read(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } }
  function write(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }

  // Same 6 AM rollover as the goals' "Today".
  function activeDate() {
    const d = new Date();
    if (d.getHours() < 6) d.setDate(d.getDate() - 1);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  function loadSettings() {
    const raw = read(SETTINGS_KEY) || {};
    const out = Object.assign({}, DEFAULTS);
    Object.keys(DEFAULTS).forEach((k) => {
      if (typeof raw[k] === typeof DEFAULTS[k]) out[k] = raw[k];
    });
    Object.keys(LIMITS).forEach((k) => {
      const [lo, hi] = LIMITS[k];
      out[k] = Math.min(hi, Math.max(lo, Math.round(Number(out[k]) || DEFAULTS[k])));
    });
    out.autoStart = !!out.autoStart;
    return out;
  }

  function durMs(phase, s) {
    const min = phase === 'focus' ? s.focusMin : phase === 'short' ? s.shortMin : s.longMin;
    return min * 60 * 1000;
  }

  function freshState(s) {
    const total = durMs('focus', s);
    return {
      phase: 'focus', status: 'idle', endAt: null, remainingMs: total, totalMs: total,
      startedAt: null, roundDone: 0, focusGoal: null, prompt: null,
      today: { date: activeDate(), count: 0 },
    };
  }

  function loadState(s) {
    const st = read(STATE_KEY);
    if (!st || !PHASES[st.phase] || ['idle', 'running', 'paused'].indexOf(st.status) === -1) return freshState(s);
    if (st.status === 'running' && typeof st.endAt !== 'number') st.status = 'idle';
    if (typeof st.totalMs !== 'number' || st.totalMs <= 0) st.totalMs = durMs(st.phase, s);
    if (typeof st.remainingMs !== 'number') st.remainingMs = st.totalMs;
    if (typeof st.roundDone !== 'number') st.roundDone = 0;
    if (!st.today || typeof st.today.count !== 'number') st.today = { date: activeDate(), count: 0 };
    rollToday(st);
    return st;
  }

  // Reset today's count (and the round) when the day rolls over.
  function rollToday(st) {
    const today = activeDate();
    if (st.today.date === today) return;
    st.today = { date: today, count: 0 };
    st.prompt = null;
    if (st.status !== 'running') st.roundDone = 0;
  }

  let settings = loadSettings();
  let state = loadState(settings);
  const subscribers = new Set();
  let timer = null;
  let audioCtx = null;
  const baseTitle = document.title;

  function save() { write(STATE_KEY, state); }

  function remainingMs() {
    return state.status === 'running' ? Math.max(0, state.endAt - Date.now()) : Math.max(0, state.remainingMs);
  }

  function format(ms) {
    const t = Math.max(0, Math.ceil(ms / 1000));
    return String(Math.floor(t / 60)).padStart(2, '0') + ':' + String(t % 60).padStart(2, '0');
  }

  function snapshot() {
    const total = state.totalMs || durMs(state.phase, settings);
    const rem = remainingMs();
    return {
      phase: state.phase,
      phaseLabel: PHASES[state.phase].label,
      emoji: PHASES[state.phase].emoji,
      status: state.status,
      remainingMs: rem,
      totalMs: total,
      fractionLeft: total ? Math.min(1, Math.max(0, rem / total)) : 0,
      startedAt: state.startedAt,
      endAt: state.status === 'running' ? state.endAt : null,
      roundDone: state.roundDone,
      longEvery: settings.longEvery,
      sessionNumber: Math.min(state.roundDone + 1, settings.longEvery),
      todayCount: state.today.count,
      dailyTarget: settings.dailyTarget,
      focusGoal: state.focusGoal,
      prompt: state.prompt,
      settings: Object.assign({}, settings),
    };
  }

  function updateTitle(snap) {
    document.title = snap.status === 'running'
      ? snap.emoji + ' ' + format(snap.remainingMs) + ' · ' + snap.phaseLabel
      : baseTitle;
  }

  function emit(evt) {
    const snap = snapshot();
    updateTitle(snap);
    subscribers.forEach((fn) => { try { fn(snap, evt || { type: 'change' }); } catch (e) {} });
  }

  function ensureTimer() {
    if (state.status === 'running') {
      if (!timer) timer = setInterval(check, 1000);
    } else if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  // ---------- sound + notifications ----------
  function getAudio() {
    if (!audioCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      try { audioCtx = new AC(); } catch (e) { return null; }
    }
    if (audioCtx.state === 'suspended') { try { audioCtx.resume(); } catch (e) {} }
    return audioCtx;
  }

  // Soft three-note chime: sine tones with a gentle attack and long fade.
  function chime() {
    const ctx = getAudio();
    if (!ctx) return;
    try {
      const t = ctx.currentTime + 0.02;
      [[659.25, 0], [880, 0.18], [1318.5, 0.36]].forEach(([freq, delay]) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.0001, t + delay);
        gain.gain.exponentialRampToValueAtTime(0.16, t + delay + 0.03);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + delay + 1.3);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(t + delay);
        osc.stop(t + delay + 1.4);
      });
    } catch (e) {}
  }

  function askNotificationPermission() {
    if (!('Notification' in window) || Notification.permission !== 'default') return;
    try {
      const p = Notification.requestPermission();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch (e) {}
  }

  function notify(from, to, autoStarted) {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    let title, body;
    if (from === 'focus') {
      title = '🍅 Focus session done';
      body = (to === 'long' ? 'Long break' : 'Short break') + ' — ' +
        Math.round(durMs(to, settings) / 60000) + ' min' + (autoStarted ? ', started.' : '. Press Start when ready.');
    } else {
      title = (from === 'long' ? '🌿' : '☕') + " Break's over";
      body = autoStarted ? 'Next focus session started.' : 'Ready for the next focus session?';
    }
    try { new Notification(title, { body, tag: 'pomodoro' }); } catch (e) { /* e.g. mobile Chrome needs a service worker */ }
  }

  // ---------- phase transitions ----------
  function setPhase(phase, autoStart) {
    state.phase = phase;
    state.totalMs = durMs(phase, settings);
    state.remainingMs = state.totalMs;
    if (autoStart) {
      state.status = 'running';
      state.startedAt = Date.now();
      state.endAt = state.startedAt + state.totalMs;
    } else {
      state.status = 'idle';
      state.startedAt = null;
      state.endAt = null;
    }
  }

  function completePhase(natural) {
    const from = state.phase;
    const lateBy = state.status === 'running' && state.endAt ? Date.now() - state.endAt : 0;
    let next;
    if (from === 'focus') {
      if (natural) {
        rollToday(state);
        state.today.count += 1;
        state.roundDone += 1;
        if (state.focusGoal) state.prompt = { goal: state.focusGoal, at: Date.now() };
      }
      next = state.roundDone >= settings.longEvery ? 'long' : 'short';
    } else {
      if (from === 'long') state.roundDone = 0;
      next = 'focus';
    }
    const autoStarted = settings.autoStart;
    setPhase(next, autoStarted);
    save();
    ensureTimer();
    if (natural && lateBy < LATE_CHIME_MS) {
      chime();
      notify(from, next, autoStarted);
    }
    emit({ type: natural ? 'phase-end' : 'skip', from, to: next, autoStarted });
  }

  // Runs every second while running, and when the tab becomes visible.
  function check() {
    if (state.status === 'running' && Date.now() >= state.endAt) {
      // Another open tab may have completed this phase already; trust storage.
      const stored = read(STATE_KEY);
      if (stored && (stored.status !== 'running' || stored.endAt !== state.endAt || stored.phase !== state.phase)) {
        state = loadState(settings);
        ensureTimer();
        emit({ type: 'sync' });
        return;
      }
      completePhase(true);
      return;
    }
    if (state.status === 'running') emit({ type: 'tick' });
  }

  // ---------- public API ----------
  function start() {
    getAudio();                    // unlock audio on this user gesture
    askNotificationPermission();   // asks only the first time (permission still "default")
    if (state.status === 'running') return;
    rollToday(state);
    const now = Date.now();
    if (state.status === 'idle' || !state.startedAt) state.startedAt = now;
    state.status = 'running';
    state.endAt = now + Math.max(1000, state.remainingMs);
    save();
    ensureTimer();
    emit({ type: 'start' });
  }

  function pause() {
    if (state.status !== 'running') return;
    state.remainingMs = Math.max(0, state.endAt - Date.now());
    state.status = 'paused';
    state.endAt = null;
    save();
    ensureTimer();
    emit({ type: 'pause' });
  }

  function toggle() { if (state.status === 'running') pause(); else start(); }

  function reset() {
    setPhase(state.phase, false);
    save();
    ensureTimer();
    emit({ type: 'reset' });
  }

  function skip() { completePhase(false); }

  function setFocusGoal(text) {
    const next = text ? String(text) : null;
    if (state.focusGoal === next) return;
    state.focusGoal = next;
    save();
    emit({ type: 'goal' });
  }

  function dismissPrompt() {
    if (!state.prompt) return;
    state.prompt = null;
    save();
    emit({ type: 'prompt' });
  }

  function updateSettings(partial) {
    write(SETTINGS_KEY, Object.assign({}, settings, partial || {}));
    settings = loadSettings();
    if (state.status === 'idle') {
      state.totalMs = durMs(state.phase, settings);
      state.remainingMs = state.totalMs;
    }
    save();
    emit({ type: 'settings' });
  }

  function subscribe(fn) {
    subscribers.add(fn);
    try { fn(snapshot(), { type: 'init' }); } catch (e) {}
    return () => subscribers.delete(fn);
  }

  // ---------- keep in sync with other tabs + wake from sleep ----------
  window.addEventListener('storage', (e) => {
    if (e.key !== STATE_KEY && e.key !== SETTINGS_KEY) return;
    settings = loadSettings();
    state = loadState(settings);
    ensureTimer();
    emit({ type: 'sync' });
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { check(); emit({ type: 'visible' }); } });
  window.addEventListener('focus', check);

  // A phase that ended while every tab was closed completes on load (quietly if it was long ago).
  if (state.status === 'running' && Date.now() >= state.endAt) completePhase(true);
  ensureTimer();
  updateTitle(snapshot());

  window.Pomodoro = {
    getState: snapshot, subscribe, start, pause, toggle, reset, skip,
    setFocusGoal, dismissPrompt, updateSettings, format, PHASES, LIMITS,
  };
})();
