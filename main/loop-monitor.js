/**
 * WO-38: main-process event-loop lag monitor.
 *
 * "Not Responding" happens when the event loop is blocked. This module watches
 * the loop with perf_hooks.monitorEventLoopDelay and reports:
 *   - any lag sample > 500 ms  -> who was running (current IPC handler / engine phase)
 *   - any IPC handler taking > 200 ms -> its duration
 *
 * Everything funnels into one log function (the app log in production).
 */
'use strict';

const { monitorEventLoopDelay } = require('perf_hooks');

const LAG_THRESHOLD_MS = 500;
const IPC_SLOW_MS = 200;

let _currentOp = null;   // e.g. 'ipc:takeone:installEngine' or 'engine-phase:venv'
let _monitor = null;
let _interval = null;

function setCurrentOp(name) { _currentOp = name; }
function clearCurrentOp() { _currentOp = null; }
function currentOp() { return _currentOp; }

/**
 * Start the lag monitor. onLag({ lagMs, at, op }) is called for every sample
 * over LAG_THRESHOLD_MS. Returns a stop function.
 */
function startLoopMonitor(onLag, opts = {}) {
  const lagThreshold = opts.lagThresholdMs || LAG_THRESHOLD_MS;
  const pollMs = opts.pollMs || 1000;
  if (_monitor) return stopLoopMonitor;
  _monitor = monitorEventLoopDelay({ resolution: 20 });
  _monitor.enable();
  _interval = setInterval(() => {
    const lagMs = _monitor.mean / 1e6;
    _monitor.reset();
    if (lagMs > lagThreshold) {
      try { onLag({ lagMs: Math.round(lagMs), at: new Date().toISOString(), op: _currentOp }); }
      catch { /* the monitor never breaks the app */ }
    }
  }, pollMs);
  if (_interval.unref) _interval.unref();
  return stopLoopMonitor;
}

function stopLoopMonitor() {
  if (_interval) { clearInterval(_interval); _interval = null; }
  if (_monitor) { _monitor.disable(); _monitor = null; }
}

/**
 * Wrap an IPC handler: sets the current op while it runs and reports
 * durations over IPC_SLOW_MS via onSlow({ name, durationMs }).
 */
function wrapIpcHandler(name, fn, onSlow) {
  return async (...args) => {
    const prev = _currentOp;
    _currentOp = 'ipc:' + name;
    const t0 = Date.now();
    try {
      return await fn(...args);
    } finally {
      const durationMs = Date.now() - t0;
      _currentOp = prev;
      if (durationMs > IPC_SLOW_MS) {
        try { onSlow && onSlow({ name, durationMs }); } catch { /* never break */ }
      }
    }
  };
}

/**
 * Wrap an engine-phase emitter: sets the current op to the engine phase so a
 * lag spike during install names the phase (venv, downloading, ...).
 */
function trackEnginePhase(onEvent) {
  return (type, data) => {
    if (type === 'phase' && data && data.phase) setCurrentOp('engine-phase:' + data.phase);
    if (type === 'phase' && data && data.phase === 'ready') clearCurrentOp();
    try { onEvent(type, data); } catch { /* never break */ }
  };
}

module.exports = {
  startLoopMonitor, stopLoopMonitor,
  wrapIpcHandler, trackEnginePhase,
  setCurrentOp, clearCurrentOp, currentOp,
  LAG_THRESHOLD_MS, IPC_SLOW_MS,
};
