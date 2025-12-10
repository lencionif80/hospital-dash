// filename: logs.plugin.js
// Sistema de diagnóstico para Il Divo: Hospital Dash!
// Provee LOG.* con buffer circular, overlay in-game y exportación.
(function (W) {
  'use strict';

  W.LOG = W.LOG || {};
  W.LOG.counter = W.LOG.counter || function counter(_k, _v) {};
  W.LOG.event = W.LOG.event || function event(_tag, _payload) {};

  const searchParams = (typeof location !== 'undefined' && typeof location.search === 'string')
    ? new URLSearchParams(location.search)
    : null;
  const debugParam = searchParams ? (searchParams.get('debug') || '') : '';
  const collisionsFromQuery = debugParam.split(',').some((p) => p.trim().toLowerCase() === 'collisions');
  W.DEBUG_COLLISIONS = typeof W.DEBUG_COLLISIONS === 'boolean' ? W.DEBUG_COLLISIONS : collisionsFromQuery;
  function logCollision(event, data) {
    const payload = data || {};
    try {
      W.LOG?.event?.('COLLISION', { event, ...payload });
    } catch (_) {}
    if (!W.DEBUG_COLLISIONS) return;
    try {
      console.log('[COLLISION]', event, payload);
    } catch (_) {}
  }
  W.LogCollision = logCollision;

  function patientsSnapshot() {
    try {
      if (typeof W.PatientsAPI?.counterSnapshot === 'function') {
        return W.PatientsAPI.counterSnapshot();
      }
    } catch (_) {}
    const G = W.G || {};
    return {
      total: G.patientsTotal | 0,
      pending: G.patientsPending | 0,
      cured: G.patientsCured | 0,
      furious: G.patientsFurious | 0,
    };
  }

  W.patientsSnapshot = patientsSnapshot;

  if (W.LOG && typeof W.LOG.init === 'function' && W.LOG.__hdDiagnostics === true) {
    return; // ya instalado
  }

  const LOG_VERSION = '3.1.0';
  const LEVELS = ['debug', 'info', 'warn', 'error'];
  const LEVEL_WEIGHT = { debug: 0, info: 1, warn: 2, error: 3 };
  const NOISE_PATTERNS = [/^chrome-extension:\/\//i, /^The message port closed/i];
  const PERSIST_KEY = 'HD_LOG_BUFFER_V1';

  const originalConsole = {
    log: console.log.bind(console),
    info: (console.info || console.log).bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
  };

  const state = {
    entries: [],
    counters: new Map(),
    bufferSize: 2000,
    minLevel: 'info',
    filterLevel: null,
    filterRegex: null,
    uiHotkey: 'F10',
    verbose: false,
    overlayBuilt: false,
    overlayVisible: false,
    panicShown: false,
    persistTimer: null,
    seq: 0,
    availableTags: new Set(),
    tagFilter: '',
    tagOptionsDirty: false,
  };

  let overlay = null;
  let listNode = null;
  let countersNode = null;
  let levelSelect = null;
  let filterInput = null;
  let tagSelect = null;
  let versionBadge = null;

  function levelWeight(level) {
    return LEVEL_WEIGHT[level] ?? LEVEL_WEIGHT.info;
  }

  function activeThreshold() {
    const f = state.filterLevel;
    if (f && levelWeight(f) > levelWeight(state.minLevel)) return f;
    return state.minLevel;
  }

  function passesFilters(entry) {
    if (!entry) return false;
    if (levelWeight(entry.level) < levelWeight(activeThreshold())) return false;
    if (state.tagFilter && state.tagFilter !== '__all__') {
      const tag = entry.tag || '';
      if (tag !== state.tagFilter) return false;
    }
    if (state.filterRegex) {
      const sample = [entry.tag, entry.text, entry.source].filter(Boolean).join(' ');
      try {
        if (!state.filterRegex.test(sample)) return false;
      } catch (_) {
        // Si la RegExp dejó de ser válida, resetea
        state.filterRegex = null;
      }
    }
    return true;
  }

  function toText(arg) {
    if (typeof arg === 'string') return arg;
    if (arg instanceof Error && arg.stack) return arg.stack;
    try {
      return JSON.stringify(arg);
    } catch (_) {
      return String(arg);
    }
  }

  function normaliseArgs(args) {
    const arr = Array.isArray(args) ? args : [args];
    return arr.map((a) => (a instanceof Error ? (a.stack || a.message || String(a)) : a));
  }

  function sendConsoleExport(level, args, meta = {}) {
    if (typeof fetch !== 'function') return;
    try {
      const payload = {
        level,
        message: normaliseArgs(args).map(toText).join(' '),
        meta: {
          tag: meta.tag || null,
          source: meta.source || null,
          stack: meta.stack || null,
        },
      };
      fetch('console_export.php', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } catch (_) {
      // evitar loops de error
    }
  }

  function shouldIgnore(entry) {
    if (!entry || !entry.text) return false;
    return NOISE_PATTERNS.some((re) => re.test(entry.text));
  }

  function formatEntry(entry) {
    const ts = entry.time.toISOString();
    const tag = entry.tag ? `[${entry.tag}]` : '';
    return `[${ts}] ${entry.level.toUpperCase()}${tag} ${entry.text}`;
  }

  function schedulePersist() {
    if (state.persistTimer) return;
    state.persistTimer = W.setTimeout(() => {
      state.persistTimer = null;
      try {
        const snapshot = state.entries.slice(-200).map((e) => ({
          level: e.level,
          text: e.text,
          tag: e.tag,
          time: e.time.toISOString(),
          source: e.source || null,
        }));
        localStorage.setItem(PERSIST_KEY, JSON.stringify(snapshot));
      } catch (_) {}
    }, 450);
  }

  function loadPersisted() {
    try {
      const raw = localStorage.getItem(PERSIST_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return;
      for (const item of parsed) {
        const entry = {
          id: ++state.seq,
          level: item.level || 'info',
          text: item.text || '',
          tag: item.tag || null,
          source: item.source || 'persisted',
          time: item.time ? new Date(item.time) : new Date(),
          data: null,
          args: [],
        };
        if (shouldIgnore(entry)) continue;
        state.entries.push(entry);
        if (entry.tag) {
          state.availableTags.add(entry.tag);
          state.tagOptionsDirty = true;
        }
      }
    } catch (_) {}
  }

  function ensureTagOptions() {
    if (!tagSelect || !state.tagOptionsDirty) return;
    state.tagOptionsDirty = false;
    const current = state.tagFilter;
    const existing = new Set();
    for (const opt of Array.from(tagSelect.options)) {
      existing.add(opt.value || '');
    }
    const sorted = Array.from(state.availableTags).filter(Boolean).sort();
    // ensure default option first
    if (!existing.has('')) {
      const defOpt = document.createElement('option');
      defOpt.value = '';
      defOpt.textContent = 'tag: todos';
      tagSelect.appendChild(defOpt);
    }
    for (const tag of sorted) {
      if (existing.has(tag)) continue;
      const opt = document.createElement('option');
      opt.value = tag;
      opt.textContent = `tag: ${tag}`;
      tagSelect.appendChild(opt);
    }
    // remove orphaned options (except default)
    for (const opt of Array.from(tagSelect.options)) {
      if (!opt.value) continue;
      if (!state.availableTags.has(opt.value)) {
        if (opt.selected) {
          tagSelect.value = '';
          state.tagFilter = '';
        }
        opt.remove();
      }
    }
    if (tagSelect.value !== (current || '')) {
      const desired = state.availableTags.has(current) ? current : '';
      tagSelect.value = desired;
      state.tagFilter = desired;
    }
  }

  function ensureOverlay() {
    if (state.overlayBuilt) return;
    state.overlayBuilt = true;

    const style = document.createElement('style');
    style.id = 'hd-log-style';
    style.textContent = `
      .hd-log-overlay{position:fixed;inset:32px;z-index:10000;display:flex;flex-direction:column;background:rgba(5,8,11,0.92);color:#f0f6fc;font:12px/1.5 'Fira Code',monospace;border:1px solid #1f6feb;border-radius:10px;box-shadow:0 20px 60px rgba(0,0,0,0.55);backdrop-filter:blur(6px);}
      .hd-log-overlay.hidden{display:none;}
      .hd-log-header{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:10px 14px;border-bottom:1px solid rgba(255,255,255,0.07);}
      .hd-log-header button,.hd-log-header select,.hd-log-header input{background:#0d1117;color:#f0f6fc;border:1px solid #1f6feb;border-radius:6px;padding:4px 8px;font:12px 'Fira Code',monospace;}
      .hd-log-header button:hover,.hd-log-header select:hover,.hd-log-header input:hover{border-color:#58a6ff;}
      .hd-log-header .hd-log-version{margin-left:auto;color:#8b949e;font-size:11px;padding:4px 0;}
      .hd-log-body{flex:1 1 auto;overflow:auto;padding:8px 14px;}
      .hd-log-entry{margin:0 0 6px;padding-bottom:6px;border-bottom:1px solid rgba(255,255,255,0.05);white-space:pre-wrap;word-break:break-word;}
      .hd-log-entry[data-level="debug"]{color:#8b949e;}
      .hd-log-entry[data-level="info"]{color:#f0f6fc;}
      .hd-log-entry[data-level="warn"]{color:#f2cc60;}
      .hd-log-entry[data-level="error"]{color:#f85149;}
      .hd-log-entry .hd-log-meta{font-size:11px;opacity:0.65;}
      .hd-log-footer{padding:6px 14px;border-top:1px solid rgba(255,255,255,0.07);display:flex;flex-wrap:wrap;gap:8px;color:#8b949e;font-size:11px;}
      .hd-log-counter{display:inline-flex;align-items:center;padding:2px 6px;background:rgba(88,166,255,0.12);border-radius:4px;color:#58a6ff;}
      body.hd-log-panic #game-container canvas{filter:blur(4px) brightness(0.4);}
      .hd-log-panic-overlay{position:fixed;inset:0;z-index:10001;background:rgba(2,6,12,0.96);display:flex;align-items:center;justify-content:center;padding:32px;}
      .hd-log-panic-box{max-width:640px;width:100%;background:#0d1117;border:1px solid #f85149;border-radius:12px;padding:24px;color:#f0f6fc;box-shadow:0 30px 80px rgba(0,0,0,0.55);}
      .hd-log-panic-box h2{margin:0 0 12px;font-size:20px;color:#ff7b72;}
      .hd-log-panic-box pre{max-height:260px;overflow:auto;background:#010409;padding:12px;border-radius:8px;color:#f0f6fc;font:12px/1.4 'Fira Code',monospace;}
      .hd-log-actions{display:flex;flex-wrap:wrap;gap:10px;margin-top:18px;}
      .hd-log-actions button{flex:1 1 auto;background:#161b22;color:#f0f6fc;border:1px solid #30363d;border-radius:6px;padding:10px;font-weight:600;cursor:pointer;}
      .hd-log-actions button.copy{border-color:#1f6feb;color:#58a6ff;}
      .hd-log-actions button.retry{border-color:#2ea043;color:#2ea043;}
    `;
    document.head.appendChild(style);

    overlay = document.createElement('section');
    overlay.className = 'hd-log-overlay hidden';
    overlay.setAttribute('role', 'log');
    overlay.setAttribute('aria-live', 'polite');

    const header = document.createElement('header');
    header.className = 'hd-log-header';

    levelSelect = document.createElement('select');
    levelSelect.setAttribute('aria-label', 'Nivel mínimo');
    LEVELS.forEach((lvl) => {
      const opt = document.createElement('option');
      opt.value = lvl;
      opt.textContent = `nivel ≥ ${lvl}`;
      if (lvl === state.minLevel) opt.selected = true;
      levelSelect.appendChild(opt);
    });
    levelSelect.addEventListener('change', () => {
      LOG.level = levelSelect.value;
    });

    tagSelect = document.createElement('select');
    tagSelect.setAttribute('aria-label', 'Filtrar por tag');
    const defaultTagOpt = document.createElement('option');
    defaultTagOpt.value = '';
    defaultTagOpt.textContent = 'tag: todos';
    tagSelect.appendChild(defaultTagOpt);
    tagSelect.addEventListener('change', () => {
      state.tagFilter = tagSelect.value || '';
      rerenderList();
    });

    filterInput = document.createElement('input');
    filterInput.type = 'search';
    filterInput.placeholder = 'Filtrar tag / texto (regex opcional)';
    filterInput.addEventListener('change', () => {
      const raw = filterInput.value.trim();
      if (!raw) {
        state.filterRegex = null;
      } else {
        try {
          state.filterRegex = new RegExp(raw, 'i');
        } catch (_) {
          state.filterRegex = null;
        }
      }
      rerenderList();
    });

    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.textContent = 'Copiar log';
    copyBtn.addEventListener('click', () => {
      const text = LOG.export();
      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(text).catch(() => {
          const ta = document.createElement('textarea');
          ta.value = text;
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          ta.remove();
        });
      } else {
        const ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
      }
    });

    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.textContent = 'Vaciar';
    clearBtn.addEventListener('click', () => {
      state.entries = [];
      rerenderList();
      schedulePersist();
    });

    header.appendChild(levelSelect);
    header.appendChild(tagSelect);
    header.appendChild(filterInput);
    header.appendChild(copyBtn);
    header.appendChild(clearBtn);

    versionBadge = document.createElement('span');
    versionBadge.className = 'hd-log-version';
    versionBadge.textContent = `logVersion ${LOG_VERSION}`;
    header.appendChild(versionBadge);

    listNode = document.createElement('div');
    listNode.className = 'hd-log-body';

    const footer = document.createElement('footer');
    footer.className = 'hd-log-footer';
    countersNode = document.createElement('div');
    countersNode.className = 'hd-log-counters';
    footer.appendChild(countersNode);

    overlay.appendChild(header);
    overlay.appendChild(listNode);
    overlay.appendChild(footer);
    document.body.appendChild(overlay);
  }

  function rerenderList() {
    if (!listNode) return;
    ensureTagOptions();
    listNode.innerHTML = '';
    const threshold = activeThreshold();
    if (levelSelect && levelSelect.value !== threshold) {
      levelSelect.value = threshold;
    }

    for (const entry of state.entries) {
      if (!passesFilters(entry)) continue;
      const node = document.createElement('article');
      node.className = 'hd-log-entry';
      node.dataset.level = entry.level;
      const tag = entry.tag ? ` [${entry.tag}]` : '';
      const source = entry.source ? ` · ${entry.source}` : '';
      const meta = document.createElement('div');
      meta.className = 'hd-log-meta';
      meta.textContent = `${entry.time.toLocaleTimeString()} · ${entry.level.toUpperCase()}${tag}${source}`;
      const body = document.createElement('div');
      body.textContent = entry.text;
      node.appendChild(meta);
      node.appendChild(body);
      listNode.appendChild(node);
    }
    listNode.scrollTop = listNode.scrollHeight;
  }

  function updateCounters() {
    if (!countersNode) return;
    countersNode.innerHTML = '';
    state.counters.forEach((value, key) => {
      const badge = document.createElement('span');
      badge.className = 'hd-log-counter';
      badge.textContent = `${key}: ${value}`;
      countersNode.appendChild(badge);
    });
  }

  function record(level, args, meta = {}) {
    try {
      const entry = {
        id: ++state.seq,
        level,
        args: normaliseArgs(args),
        data: meta.data || null,
        tag: meta.tag || null,
        source: meta.source || null,
        stack: meta.stack || null,
        time: new Date(),
      };
      entry.text = entry.args.map(toText).join(' ');
      if (meta.append) entry.text += ` ${meta.append}`;
      if (shouldIgnore(entry)) return entry;

      state.entries.push(entry);
      if (state.entries.length > state.bufferSize) {
        state.entries.splice(0, state.entries.length - state.bufferSize);
      }
      if (entry.tag) {
        state.availableTags.add(entry.tag);
        state.tagOptionsDirty = true;
        ensureTagOptions();
      }
      if (passesFilters(entry)) {
        appendEntry(entry);
      }
      schedulePersist();
      return entry;
    } catch (err) {
      try {
        originalConsole?.error?.('[LOGS_PLUGIN_ERROR] record', String((err && err.message) || err));
      } catch (_) {}
      return {
        id: ++state.seq,
        level: level || 'error',
        args: [],
        data: null,
        tag: meta.tag || null,
        source: meta.source || 'logs.plugin',
        stack: meta.stack || null,
        time: new Date(),
        text: String((err && err.message) || err || 'log_error'),
      };
    }
  }

  function appendEntry(entry) {
    if (!listNode) return;
    ensureTagOptions();
    const node = document.createElement('article');
    node.className = 'hd-log-entry';
    node.dataset.level = entry.level;
    const tag = entry.tag ? ` [${entry.tag}]` : '';
    const source = entry.source ? ` · ${entry.source}` : '';
    const meta = document.createElement('div');
    meta.className = 'hd-log-meta';
    meta.textContent = `${entry.time.toLocaleTimeString()} · ${entry.level.toUpperCase()}${tag}${source}`;
    const body = document.createElement('div');
    body.textContent = entry.text;
    node.appendChild(meta);
    node.appendChild(body);
    listNode.appendChild(node);
    listNode.scrollTop = listNode.scrollHeight;
  }

  function toggleOverlay(force) {
    ensureOverlay();
    const target = (typeof force === 'boolean') ? force : !state.overlayVisible;
    state.overlayVisible = target;
    overlay.classList.toggle('hidden', !target);
    if (target) rerenderList();
  }

  function panic(message, error) {
    if (state.panicShown) return;
    state.panicShown = true;
    ensureOverlay();
    document.body.classList.add('hd-log-panic');

    const overlayNode = document.createElement('div');
    overlayNode.className = 'hd-log-panic-overlay';
    const box = document.createElement('div');
    box.className = 'hd-log-panic-box';
    const title = document.createElement('h2');
    title.textContent = 'Se ha detenido el arranque';
    const desc = document.createElement('p');
    desc.textContent = 'Detectamos un error crítico. Revisa los detalles o copia el log para depurar.';
    const pre = document.createElement('pre');
    pre.textContent = message || 'Error desconocido';

    const actions = document.createElement('div');
    actions.className = 'hd-log-actions';
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'copy';
    copy.textContent = 'Copiar log';
    copy.addEventListener('click', () => {
      const text = LOG.export();
      navigator.clipboard?.writeText?.(text).catch(() => {
        const ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
      });
    });

    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'retry';
    retry.textContent = 'Reintentar arranque';
    retry.addEventListener('click', () => {
      overlayNode.remove();
      document.body.classList.remove('hd-log-panic');
      if (typeof W.startGame === 'function') {
        try {
          W.startGame();
        } catch (err) {
          originalConsole.error('[panic retry] startGame falló', err);
        }
      } else {
        W.location.reload();
      }
    });

    const close = document.createElement('button');
    close.type = 'button';
    close.textContent = 'Cerrar';
    close.addEventListener('click', () => {
      overlayNode.remove();
      document.body.classList.remove('hd-log-panic');
    });

    actions.appendChild(copy);
    actions.appendChild(retry);
    actions.appendChild(close);

    box.appendChild(title);
    box.appendChild(desc);
    box.appendChild(pre);
    box.appendChild(actions);
    overlayNode.appendChild(box);
    document.body.appendChild(overlayNode);

    record('error', [message], { tag: 'PANIC', data: { error: error?.stack || null }, source: 'panic' });
  }

  function handleGlobalError(ev) {
    const { message, filename, lineno, colno, error } = ev;
    const meta = {
      tag: 'ERROR',
      data: { filename, lineno, colno },
      source: 'window.onerror',
      stack: error?.stack || null,
    };
    record('error', [message], meta);
    if (error instanceof SyntaxError || error instanceof ReferenceError) {
      const snippet = `${message}\n${filename || ''}:${lineno || 0}:${colno || 0}`;
      panic(snippet, error);
    }
  }

  function handleRejection(ev) {
    const reason = ev.reason;
    const message = reason?.message || String(reason);
    const meta = {
      tag: 'PROMISE',
      source: 'unhandledrejection',
      stack: reason?.stack || null,
    };
    record('error', [message], meta);
  }

  function adjustLevel(delta) {
    const current = LEVELS.indexOf(LOG.level);
    if (current < 0) return;
    let next = current + delta;
    next = Math.max(0, Math.min(LEVELS.length - 1, next));
    LOG.level = LEVELS[next];
    if (levelSelect) levelSelect.value = LOG.level;
  }

  function installHotkeys() {
    W.addEventListener('keydown', (ev) => {
      if (ev.key === state.uiHotkey || ev.code === state.uiHotkey) {
        ev.preventDefault();
        toggleOverlay();
      } else if (ev.key === '[') {
        adjustLevel(1);
      } else if (ev.key === ']') {
        adjustLevel(-1);
      }
    });
  }

  function patchConsole() {
    if (console.__hdLogPatched) return;
    console.__hdLogPatched = true;
    console.log = function (...args) {
      try { originalConsole.log(...args); } catch (_) {}
      try { record('info', args, { source: 'console.log' }); } catch (err) { try { originalConsole?.error?.('[LOGS_PLUGIN_ERROR] console.log', err); } catch (_) {} }
      try { sendConsoleExport('log', args, { source: 'console.log' }); } catch (_) {}
    };
    console.info = function (...args) {
      try { originalConsole.info(...args); } catch (_) {}
      try { record('info', args, { source: 'console.info' }); } catch (err) { try { originalConsole?.error?.('[LOGS_PLUGIN_ERROR] console.info', err); } catch (_) {} }
      try { sendConsoleExport('log', args, { source: 'console.info' }); } catch (_) {}
    };
    console.warn = function (...args) {
      try { originalConsole.warn(...args); } catch (_) {}
      try { record('warn', args, { source: 'console.warn' }); } catch (err) { try { originalConsole?.error?.('[LOGS_PLUGIN_ERROR] console.warn', err); } catch (_) {} }
      try { sendConsoleExport('warn', args, { source: 'console.warn' }); } catch (_) {}
    };
    console.error = function (...args) {
      try { originalConsole.error(...args); } catch (_) {}
      try { record('error', args, { source: 'console.error' }); } catch (err) { try { originalConsole?.error?.('[LOGS_PLUGIN_ERROR] console.error', err); } catch (_) {} }
      try { sendConsoleExport('error', args, { source: 'console.error' }); } catch (_) {}
    };
  }

  function init(options = {}) {
    state.bufferSize = Number(options.buffer) > 0 ? Number(options.buffer) : state.bufferSize;
    state.uiHotkey = options.uiHotkey || state.uiHotkey;
    state.verbose = !!options.verbose;
    if (typeof options.level === 'string' && LEVEL_WEIGHT[options.level] != null) {
      state.minLevel = options.level;
    }
    ensureOverlay();
    patchConsole();
    installHotkeys();
    updateCounters();
    rerenderList();
  }

  function setFilter(opts = {}) {
    if (typeof opts.levelMin === 'string' && LEVEL_WEIGHT[opts.levelMin] != null) {
      state.filterLevel = opts.levelMin;
    } else {
      state.filterLevel = null;
    }
    if (typeof opts.tag === 'string') {
      state.tagFilter = opts.tag || '';
      if (tagSelect) {
        state.tagOptionsDirty = true;
        ensureTagOptions();
        tagSelect.value = state.tagFilter;
      }
    }
    if (opts.tagRegex instanceof RegExp) {
      state.filterRegex = opts.tagRegex;
    } else if (typeof opts.tagRegex === 'string' && opts.tagRegex.trim()) {
      try { state.filterRegex = new RegExp(opts.tagRegex, 'i'); }
      catch (_) { state.filterRegex = null; }
    } else if (opts.tagRegex === null) {
      state.filterRegex = null;
    }
    rerenderList();
  }

  function exportAll() {
    return state.entries.map(formatEntry).join('\n');
  }

  function counter(name, value) {
    state.counters.set(String(name), value);
    updateCounters();
  }

  function coerceNumber(value, fallback = 0) {
    if (typeof value === 'number') {
      return Number.isFinite(value) ? value : fallback;
    }
    const num = Number(value);
    return Number.isFinite(num) ? num : fallback;
  }

  function bumpCounter(name, delta = 1, fallback = 0) {
    const key = String(name);
    const prev = coerceNumber(state.counters.get(key), fallback);
    const next = prev + delta;
    state.counters.set(key, next);
    updateCounters();
    return next;
  }

  function event(tag, data) {
    record('info', [`[${tag}]`, data], { tag: tag || null, data, source: 'event' });
    const norm = (tag || '').toString().toUpperCase();
    switch (norm) {
      case 'SPAWN':
        bumpCounter('spawns', 1, 0);
        break;
      case 'DESPAWN': {
        const next = bumpCounter('spawns', -1, 0);
        if (next < 0) counter('spawns', 0);
        break;
      }
      case 'PILL_PICKUP':
        bumpCounter('pills.pickup', 1, 0);
        break;
      case 'PILL_DELIVER':
        bumpCounter('pills.deliver', 1, 0);
        break;
      case 'BELL_ON':
        bumpCounter('bells.ringing', 1, 0);
        break;
      case 'BELL_OFF': {
        const next = bumpCounter('bells.ringing', -1, 0);
        if (next < 0) counter('bells.ringing', 0);
        break;
      }
      case 'PATIENT_CREATE':
        bumpCounter('patients.total', 1, 0);
        break;
      case 'PATIENTS_COUNTER':
        if (data && typeof data === 'object') {
          counter('patients.pending', coerceNumber(data.pending, 0));
          counter('patients.cured', coerceNumber(data.cured, 0));
          counter('patients.furious', coerceNumber(data.furious, 0));
          if (Object.prototype.hasOwnProperty.call(data, 'total')) {
            counter('patients.total', coerceNumber(data.total, 0));
          }
        }
        break;
      default:
        break;
    }
    if (data && typeof data === 'object' && data.duplicatePlacement) {
      bumpCounter('duplicates', 1, 0);
    }
  }

  function info(...args) {
    if (state.verbose || levelWeight('info') >= levelWeight(state.minLevel)) {
      originalConsole.info(...args);
    }
    record('info', args, { source: 'LOG.info' });
  }

  function debug(...args) {
    if (state.verbose) originalConsole.log(...args);
    record('debug', args, { source: 'LOG.debug' });
  }

  function warn(...args) {
    originalConsole.warn(...args);
    record('warn', args, { source: 'LOG.warn' });
  }

  function error(...args) {
    originalConsole.error(...args);
    record('error', args, { source: 'LOG.error' });
  }

  const LOG = {
    __hdDiagnostics: true,
    init,
    toggleUI: toggleOverlay,
    setFilter,
    export: exportAll,
    counter,
    bumpCounter,
    event,
    info,
    debug,
    warn,
    error,
    logVersion: LOG_VERSION,
  };

  Object.defineProperty(LOG, 'level', {
    get() { return state.minLevel; },
    set(value) {
      if (typeof value === 'string' && LEVEL_WEIGHT[value] != null) {
        state.minLevel = value;
        rerenderList();
      }
    },
  });

  W.LOG = LOG;

  loadPersisted();
  ensureOverlay();
  patchConsole();
  installHotkeys();
  rerenderList();
  updateCounters();

  W.addEventListener('error', handleGlobalError);
  W.addEventListener('unhandledrejection', handleRejection);

})(window);
