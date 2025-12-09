(() => {
  'use strict';

  // === Config/tema por defecto ===
  const THEME = {
    bg:    'rgba(0,0,0,0.65)',
    text:  '#ffffff',
    ok:    '#19c37d',
    warn:  '#ffd166',
    accent:'#19c37d',
    stroke:'#ff5a6b',
  };

  const S = {
    position: (('ontouchstart' in window) ? 'bottom' : 'top'), // móvil: abajo; PC: arriba
    height: 104,
    pad: 16,
    font: '15px "IBM Plex Mono", monospace',
  };

  // Helpers
  const W = window;
  const getG = () => (W.G || {});
  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));

  const FloatingMessages = [];

  const HUD_DOM = {
    root: null,
    left: null,
    center: null,
    right: null,
    heartsCanvas: null,
    heartsCtx: null,
    heroFace: null,
    patientsValue: null,
    pendingValue: null,
    furiousValue: null,
    urgenciasValue: null,
    scoreValue: null,
    objectiveText: null,
    objectiveWrapper: null,
    carryBox: null,
    carryWrapper: null,
    carryPrimary: null,
    carrySecondary: null,
    bellsPanel: null,
    bellsList: null,
    bellsCount: null,
    bellsEmpty: null,
  };
  let objectiveOverride = null;

  function createHudStat(label, valueClass) {
    const wrap = document.createElement('div');
    wrap.className = 'hud-item';
    const strong = document.createElement('strong');
    strong.textContent = label;
    const span = document.createElement('span');
    span.className = `hud-value ${valueClass || ''}`.trim();
    wrap.appendChild(strong);
    wrap.appendChild(span);
    return { wrap, value: span };
  }

  function setHudPositionAttr(pos){
    if (!HUD_DOM.root) return;
    HUD_DOM.root.dataset.position = pos;
    HUD_DOM.root.classList.toggle('hud-bottom', pos === 'bottom');
  }

  function ensureHudDom(){
    if (HUD_DOM.root || typeof document === 'undefined') return HUD_DOM;
    const container = document.getElementById('game-container') || document.body;
    if (!container) {
      if (!HUD_DOM._waitDom && typeof document !== 'undefined') {
        HUD_DOM._waitDom = true;
        document.addEventListener('DOMContentLoaded', () => {
          HUD_DOM._waitDom = false;
          ensureHudDom();
        }, { once: true });
      }
      return HUD_DOM;
    }
    const root = document.createElement('div');
    root.id = 'hud';

    const bar = document.createElement('div');
    bar.className = 'hud-bar';

    const left = document.createElement('div');
    left.className = 'hud-left';
    const leftStack = document.createElement('div');
    leftStack.className = 'hud-column-stack';

    const center = document.createElement('div');
    center.className = 'hud-center';
    const centerStack = document.createElement('div');
    centerStack.className = 'hud-column-stack';

    const right = document.createElement('div');
    right.className = 'hud-right';
    const rightStack = document.createElement('div');
    rightStack.className = 'hud-column-stack';

    const heartsCanvas = document.createElement('canvas');
    heartsCanvas.className = 'hud-hearts';
    const heartsCtx = heartsCanvas.getContext('2d');
    left.appendChild(heartsCanvas);

    const heroFace = document.createElement('div');
    heroFace.className = 'hud-hero-face';
    heroFace.title = 'Héroe seleccionado';
    left.appendChild(heroFace);

    const patientsStat = createHudStat('Pacientes', 'hud-patients');
    const pendingStat = createHudStat('Pendientes', 'hud-pending');
    const furiousStat = createHudStat('Furiosas activas', 'hud-furious');
    leftStack.appendChild(patientsStat.wrap);
    leftStack.appendChild(pendingStat.wrap);
    leftStack.appendChild(furiousStat.wrap);

    const objective = document.createElement('div');
    objective.className = 'hud-objective';
    objective.textContent = 'Objetivo: ninguno';
    const objectiveWrapper = document.createElement('div');
    objectiveWrapper.className = 'hud-objective-wrapper hud-scroll';
    objectiveWrapper.appendChild(objective);

    const carryBox = document.createElement('div');
    carryBox.className = 'hud-carry';
    carryBox.hidden = true;
    const carryWrapper = document.createElement('div');
    carryWrapper.className = 'hud-carry-wrapper hud-scroll';
    carryWrapper.hidden = true;
    const carryPrimary = document.createElement('div');
    carryPrimary.className = 'pill pill-label';
    const carrySecondary = document.createElement('div');
    carrySecondary.className = 'pill pill-target';
    carryBox.appendChild(carryPrimary);
    carryBox.appendChild(carrySecondary);
    carryWrapper.appendChild(carryBox);

    centerStack.appendChild(objectiveWrapper);
    centerStack.appendChild(carryWrapper);

    const urgenciasStat = createHudStat('Urgencias', 'hud-urgencias');
    const scoreStat = createHudStat('Puntos', 'hud-score');
    rightStack.appendChild(urgenciasStat.wrap);
    rightStack.appendChild(scoreStat.wrap);

    left.appendChild(leftStack);
    center.appendChild(centerStack);
    right.appendChild(rightStack);

    bar.appendChild(left);
    bar.appendChild(center);
    bar.appendChild(right);
    root.appendChild(bar);

    const bellsPanel = document.createElement('section');
    bellsPanel.className = 'hud-bells-panel';
    const bellsHeader = document.createElement('header');
    const bellsTitle = document.createElement('span');
    bellsTitle.textContent = 'Timbres activos';
    const bellsCount = document.createElement('span');
    bellsCount.className = 'hud-bells-count';
    bellsHeader.appendChild(bellsTitle);
    bellsHeader.appendChild(bellsCount);
    const bellsList = document.createElement('div');
    bellsList.className = 'hud-bells-list hud-scroll';
    const bellsEmpty = document.createElement('p');
    bellsEmpty.className = 'hud-bells-empty';
    bellsEmpty.textContent = 'Sin timbres activos';
    bellsPanel.appendChild(bellsHeader);
    bellsPanel.appendChild(bellsList);
    bellsPanel.appendChild(bellsEmpty);

    root.appendChild(bellsPanel);
    container.appendChild(root);

    setHeroFace(window.SELECTED_HERO_ID || window.START_HERO_ID || window.selectedHeroKey || 'enrique');

    HUD_DOM.root = root;
    HUD_DOM.left = left;
    HUD_DOM.center = center;
    HUD_DOM.right = right;
    HUD_DOM.heartsCanvas = heartsCanvas;
    HUD_DOM.heartsCtx = heartsCtx;
    HUD_DOM.heroFace = heroFace;
    HUD_DOM.patientsValue = patientsStat.value;
    HUD_DOM.pendingValue = pendingStat.value;
    HUD_DOM.furiousValue = furiousStat.value;
    HUD_DOM.urgenciasValue = urgenciasStat.value;
    HUD_DOM.scoreValue = scoreStat.value;
    HUD_DOM.objectiveText = objective;
    HUD_DOM.objectiveWrapper = objectiveWrapper;
    HUD_DOM.carryBox = carryBox;
    HUD_DOM.carryWrapper = carryWrapper;
    HUD_DOM.carryPrimary = carryPrimary;
    HUD_DOM.carrySecondary = carrySecondary;
    HUD_DOM.bellsPanel = bellsPanel;
    HUD_DOM.bellsList = bellsList;
    HUD_DOM.bellsCount = bellsCount;
    HUD_DOM.bellsEmpty = bellsEmpty;

    setHudPositionAttr(S.position);
    return HUD_DOM;
  }

  const numberFormatter = (typeof Intl !== 'undefined' && typeof Intl.NumberFormat === 'function')
    ? new Intl.NumberFormat('es-ES')
    : null;

  function formatNumber(value){
    const safe = Number.isFinite(value) ? value : 0;
    if (numberFormatter) return numberFormatter.format(safe);
    return `${safe}`;
  }

  function getPatientCounters(G){
    const baseSnapshot = (typeof window.patientsSnapshot === 'function')
      ? window.patientsSnapshot()
      : {
          total: G?.stats?.totalPatients || 0,
          pending: G?.stats?.remainingPatients || 0,
          cured: G?.stats?.furiosasNeutralized || G?.stats?.patientsAttended || 0,
          furious: G?.stats?.activeFuriosas || 0,
        };
    const store = (!Array.isArray(G?.patients) && typeof G?.patients === 'object') ? G.patients : null;
    return {
      total: Number.isFinite(store?.total) ? store.total : (baseSnapshot.total || 0),
      pending: Number.isFinite(store?.pending) ? store.pending : (baseSnapshot.pending || 0),
      cured: Number.isFinite(store?.cured) ? store.cured : (baseSnapshot.cured || 0),
      furious: Number.isFinite(store?.furious) ? store.furious : (baseSnapshot.furious || 0),
    };
  }

  function updateHeartsCanvas(G){
    if (!HUD_DOM.heartsCanvas || !HUD_DOM.heartsCtx) return;
    const canvas = HUD_DOM.heartsCanvas;
    const ctx = HUD_DOM.heartsCtx;
    const halves = Number.isFinite(G?.health) ? G.health : Math.max(0, (G?.player?.hp || 0) * 2);
    const maxHearts = Math.max(1, ((G?.healthMax | 0) ? (G.healthMax | 0) / 2 : (G?.player?.hpMax || 3)));
    const healthRatio = maxHearts > 0 ? Math.max(0, Math.min(1, halves / (maxHearts * 2))) : 1;
    const tNow = (G?.time != null) ? G.time : (performance.now() / 1000);
    const bps = 1.2 + (3.0 * (1 - healthRatio));
    const phase = (tNow * bps) % 1;
    const p1 = Math.pow(Math.max(0, 1 - Math.abs((phase - 0.06) / 0.12)), 3.2);
    const p2 = Math.pow(Math.max(0, 1 - Math.abs((phase - 0.38) / 0.18)), 3.0);
    const pulse = Math.min(1, p1 * 1.0 + p2 * 0.85);
    const amp = 0.16 + 0.28 * (1 - healthRatio);
    const squash = 0.10 + 0.24 * (1 - healthRatio);
    const scaleX = 1 + amp * pulse;
    const scaleY = 1 - squash * pulse;
    const glow = 0.25 + 0.65 * pulse;

    const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    const cssW = Math.max(120, 24 * maxHearts + 28);
    const cssH = 48;
    const width = Math.round(cssW * dpr);
    const height = Math.round(cssH * dpr);
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
      canvas.style.width = `${cssW}px`;
      canvas.style.height = `${cssH}px`;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    drawHearts(ctx, 12, 6, halves, maxHearts, scaleX, scaleY, glow);
  }

  function formatBellTime(seconds){
    const safe = Math.max(0, seconds);
    const whole = Math.floor(safe);
    const mins = Math.floor(whole / 60);
    const secs = whole % 60;
    if (mins > 0) return `${mins}:${String(secs).padStart(2, '0')}`;
    return `${secs}s`;
  }

  function collectBellSnapshot(){
    const api = window.BellsAPI;
    if (!api || !Array.isArray(api.bells)) return [];
    const now = Date.now();
    const durationFallback = Number.isFinite(api.cfg?.ringDuration) ? api.cfg.ringDuration : 45;
    const snapshot = [];
    for (const entry of api.bells) {
      if (!entry || entry.state !== 'ringing') continue;
      const patient = entry.patient;
      const label = patient?.displayName || patient?.name || patient?.keyName || entry.e?.label || 'Paciente';
      const total = Number.isFinite(entry.ringDuration) ? Math.max(1, entry.ringDuration) : durationFallback;
      let timeLeft = Number.isFinite(entry.tLeft) ? entry.tLeft : null;
      if (!Number.isFinite(timeLeft) && Number.isFinite(entry.ringDeadline)) {
        timeLeft = Math.max(0, (entry.ringDeadline - now) / 1000);
      }
      const safeTime = Number.isFinite(timeLeft) ? Math.max(0, timeLeft) : total;
      snapshot.push({
        id: patient?.id || entry.e?.id || label,
        name: label,
        timeLeft: safeTime,
        total,
        urgent: !!(patient?.ringingUrgent || entry.e?._warning)
      });
    }
    snapshot.sort((a, b) => a.timeLeft - b.timeLeft);
    return snapshot;
  }

  function updateBellsPanel(){
    if (!HUD_DOM.bellsPanel) return;
    const entries = collectBellSnapshot();
    const count = entries.length;
    if (HUD_DOM.bellsCount) HUD_DOM.bellsCount.textContent = `${count}`;
    if (HUD_DOM.bellsEmpty) HUD_DOM.bellsEmpty.hidden = count > 0;
    if (HUD_DOM.bellsList) HUD_DOM.bellsList.hidden = count === 0;
    HUD_DOM.bellsPanel.classList.toggle('has-items', count > 0);
    if (!count) {
      if (HUD_DOM.bellsList) HUD_DOM.bellsList.textContent = '';
      HUD_DOM._bellsHash = '';
      return;
    }
    const hash = entries.map((e) => `${e.id}:${Math.round(e.timeLeft * 10)}:${Math.round(e.total * 10)}:${e.urgent ? 1 : 0}`).join('|');
    const now = performance.now();
    const shouldRefresh = !HUD_DOM._bellsHash
      || HUD_DOM._bellsHash !== hash
      || !HUD_DOM._bellsStamp
      || (now - HUD_DOM._bellsStamp) > 120;
    if (!shouldRefresh) return;
    HUD_DOM._bellsStamp = now;
    HUD_DOM._bellsHash = hash;
    if (HUD_DOM.bellsList) HUD_DOM.bellsList.textContent = '';
    for (const entry of entries) {
      const row = document.createElement('div');
      row.className = 'hud-bell-row';
      if (entry.urgent) row.classList.add('is-urgent');
      const head = document.createElement('div');
      head.className = 'hud-bell-head';
      const name = document.createElement('span');
      name.className = 'hud-bell-name';
      name.textContent = entry.name;
      const timer = document.createElement('span');
      timer.className = 'hud-bell-timer';
      timer.textContent = formatBellTime(entry.timeLeft);
      head.appendChild(name);
      head.appendChild(timer);
      const bar = document.createElement('div');
      bar.className = 'hud-bell-bar';
      const fill = document.createElement('div');
      fill.className = 'hud-bell-fill';
      const ratio = entry.total > 0 ? Math.max(0, Math.min(entry.timeLeft / entry.total, 1)) : 0;
      fill.style.width = `${Math.round(ratio * 100)}%`;
      bar.appendChild(fill);
      row.appendChild(head);
      row.appendChild(bar);
      HUD_DOM.bellsList?.appendChild(row);
    }
  }

  function updateCarryInfo(carry){
    if (!HUD_DOM.carryBox) return;
    if (carry) {
      HUD_DOM.carryBox.hidden = false;
      if (HUD_DOM.carryWrapper) HUD_DOM.carryWrapper.hidden = false;
      if (HUD_DOM.carryWrapper) HUD_DOM.carryWrapper.classList.add('show');
      if (HUD_DOM.carryPrimary) HUD_DOM.carryPrimary.textContent = carry.label || 'Pastilla';
      if (HUD_DOM.carrySecondary) {
        const who = carry.patientName || carry.pairName || 'Paciente asignado';
        HUD_DOM.carrySecondary.textContent = `Para: ${who}`;
      }
    } else {
      HUD_DOM.carryBox.hidden = true;
      if (HUD_DOM.carryWrapper) {
        HUD_DOM.carryWrapper.hidden = true;
        HUD_DOM.carryWrapper.classList.remove('show');
      }
    }
  }

  function setHeroFace(heroId){
    if (!HUD_DOM.heroFace) return;
    const key = (heroId || 'enrique').toLowerCase();
    const cssVar = `--sprite-player-${key}`;
    HUD_DOM.heroFace.style.backgroundImage = `var(${cssVar})`;
    HUD_DOM.heroFace.dataset.hero = key;
  }

  function updateDomHud(G){
    if (!G) return;
    ensureHudDom();
    if (!HUD_DOM.root) return;
    const heroId = (G?.player?.heroId || G?.player?.hero || G?.selectedHero || window.SELECTED_HERO_ID || window.START_HERO_ID || 'enrique');
    setHeroFace(heroId);
    const counters = getPatientCounters(G);
    if (HUD_DOM.patientsValue) HUD_DOM.patientsValue.textContent = `${counters.cured}/${counters.total}`;
    if (HUD_DOM.pendingValue) HUD_DOM.pendingValue.textContent = `${counters.pending}`;
    if (HUD_DOM.furiousValue) {
      HUD_DOM.furiousValue.textContent = `${counters.furious}`;
      HUD_DOM.furiousValue.classList.toggle('is-alert', counters.furious > 0);
    }
    const urgOpen = !!(G?.urgenciasOpen || (counters.pending === 0 && counters.furious === 0));
    if (HUD_DOM.urgenciasValue) {
      HUD_DOM.urgenciasValue.textContent = urgOpen ? 'ABIERTO' : 'CERRADO';
      HUD_DOM.urgenciasValue.classList.toggle('is-open', urgOpen);
      HUD_DOM.urgenciasValue.classList.toggle('is-closed', !urgOpen);
    }
    if (HUD_DOM.scoreValue) HUD_DOM.scoreValue.textContent = formatNumber(G?.score || 0);
    const explicitObjective = objectiveOverride || G?.currentObjectiveLabel || G?.currentObjective?.label;
    const objectiveText = explicitObjective || computeObjective(G);
    if (HUD_DOM.objectiveText) HUD_DOM.objectiveText.textContent = objectiveText;
    const carry = G?.player?.carry || G?.carry || null;
    updateCarryInfo(carry);
    updateHeartsCanvas(G);
    updateBellsPanel();
  }

  (function ensurePatientStore(){
    const G = getG();
    if (!G) return;
    if (!Array.isArray(G.patients)) G.patients = G.patients || [];
    if (typeof G.patients.total !== 'number') {
      G.patients.total = 0;
      G.patients.pending = 0;
      G.patients.cured = 0;
      G.patients.furious = 0;
    }
  })();

  function findEntityById(G, id) {
    if (!id) return null;
    if (typeof G?.byId === 'function') {
      try { const e = G.byId(id); if (e) return e; } catch (_) {}
    }
    return (G?.entities || []).find(e => e && e.id === id) || null;
  }

  function toScreen(camera, canvas, worldX, worldY) {
    if (typeof window.toScreen === 'function') {
      try {
        const res = window.toScreen(camera, canvas, worldX, worldY);
        if (res && typeof res.x === 'number' && typeof res.y === 'number') return res;
      } catch (_) {}
    }
    const cam = camera || { x: 0, y: 0, zoom: 1 };
    const zoom = cam.zoom || 1;
    const cx = canvas ? canvas.width * 0.5 : 0;
    const cy = canvas ? canvas.height * 0.5 : 0;
    return {
      x: (worldX - cam.x) * zoom + cx,
      y: (worldY - cam.y) * zoom + cy
    };
  }

  // —— Lógica de “objetivo” (trasladada del motor) ——
  // Mantiene exactamente los casos especiales, carga de pastilla, apertura de puerta, etc.
  // Basado en drawHUD() actual del juego. 2
  function computeObjective(G) {
    // 1) Flags especiales (incendio/psiquiátrica)
    if (G.fireActive === true && G.psySaved !== true) {
      return 'Objetivo: salva a la paciente psiquiátrica del incendio';
    }
    if (G.fireActive === true && G.psySaved === true) {
      return 'Objetivo: vuelve al control para salir antes de que se queme todo';
    }

    // 2) Si llevas una pastilla → entregarla a su paciente
    const carryingPill = (G.player?.carry?.kind === 'PILL') || (G.carry?.kind === 'PILL');
    if (carryingPill) {
      return 'Objetivo: entrega Pastilla al paciente asignado';
    }
    const carry = G.player?.carry || G.carry;
    if (carry && (carry.label || carry.patientName)) {
      const pill = carry.label || 'la pastilla';
      const who  = carry.patientName || 'el paciente asignado';
      return `Objetivo: entrega ${pill} a ${who}`;
    }

    // 3) Si no llevas → buscar una para un paciente (usa vínculos si existen)
    const hayPacientes = Array.isArray(G.patients) && G.patients.length > 0;
    const hayPills     = Array.isArray(G.pills)     && G.pills.length     > 0;
    if (!carry && hayPacientes) {
      if (hayPills) {
        const linked = G.pills.find(p => p.targetName || p.label) || G.pills[0];
        const pill = linked?.label || 'la pastilla';
        const who  = linked?.targetName || (G.patients[0]?.name || 'el paciente');
        return `Objetivo: busca ${pill} para ${who}`;
      }
      const who = G.patients[0]?.name || 'el paciente';
      return `Objetivo: busca la pastilla para ${who}`;
    }

    // 4) Si ya no quedan pacientes → carro + boss (puerta)
    const sinPacientes = Array.isArray(G.patients) && G.patients.length === 0;
    if (sinPacientes) {
      const puertaAbierta = !!(G.door && (G.door.open === true || G.door.solid === false));
      if (puertaAbierta && G.cart && G.boss) return 'Objetivo: acerca el carro de urgencias al paciente final';
      return 'Objetivo: abre la puerta y lleva el carro al final';
    }

    // 5) Fallback
    return 'Objetivo: ninguno';
  }

  // —— Corazones 2.0: latido “lub-dub”, squash & stretch y halo ——
  function drawHearts(ctx, x, y, halves, maxHearts, scaleX = 1, scaleY = 1, glow = 0) {
    const STEP = 22;
    const N = (maxHearts != null)
      ? maxHearts
      : Math.max(1, ((window.G?.healthMax | 0) ? (window.G.healthMax | 0) / 2
                                              : (window.G?.player?.hpMax || 3)));

    for (let i = 0; i < N; i++) {
      const v = halves - i * 2;
      const state = v >= 2 ? 2 : (v === 1 ? 1 : 0);
      drawHeart(ctx, x + i * STEP, y, state, scaleX, scaleY, glow);
    }
  }

  function drawHeart(ctx, x, y, state, scaleX = 1, scaleY = 1, glow = 0) {
    ctx.save();

    // Centro aproximado del corazón para escalar alrededor
    const ax = 10, ay = 18;
    ctx.translate(x + ax * (1 - scaleX), y + ay * (1 - scaleY));
    ctx.scale(scaleX, scaleY);

    // Halo/brillo + grosor de trazo aumentan con el pulso
    const glowPx = 10 + 40 * glow;             // 10..50 px
    ctx.shadowColor = 'rgba(255,107,107,0.85)';
    ctx.shadowBlur  = glowPx;
    ctx.lineWidth   = 2 + 2.2 * glow;          // 2..4.2 px
    ctx.strokeStyle = THEME.stroke;

    const outline = () => {
      ctx.beginPath();
      ctx.moveTo(10, 18);
      ctx.bezierCurveTo(10, 10, 0, 10, 0, 18);
      ctx.bezierCurveTo(0, 26, 10, 28, 10, 34);
      ctx.bezierCurveTo(10, 28, 20, 26, 20, 18);
      ctx.bezierCurveTo(20, 10, 10, 10, 10, 18);
      ctx.closePath();
    };

    // Relleno según estado
    if (state === 2) {
      outline(); ctx.fillStyle = '#ff6b6b'; ctx.fill(); ctx.stroke(); ctx.restore(); return;
    }
    if (state === 1) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, -6, 10, 40); // clip mitad izda
      ctx.clip(); outline(); ctx.fillStyle = '#ff6b6b'; ctx.fill(); ctx.restore();
      outline(); ctx.stroke(); ctx.restore(); return;
    }

    outline(); ctx.stroke(); ctx.restore();
  }


  // Ellipsis si el texto no cabe
  function ellipsize(ctx, text, maxWidth) {
    if (ctx.measureText(text).width <= maxWidth) return text;
    let out = text;
    while (out.length > 4 && ctx.measureText(out + '…').width > maxWidth) {
      out = out.slice(0, -1);
    }
    return out + '…';
  }

  // Envuelve por palabras hasta 'maxLines' líneas (la última absorbe el resto)
  function wrapText(ctx, text, maxWidth, maxLines = 2) {
    const words = String(text).split(/\s+/);
    const lines = [];
    let line = '';

    for (let i = 0; i < words.length; i++) {
      const test = line ? (line + ' ' + words[i]) : words[i];
      if (ctx.measureText(test).width <= maxWidth) {
        line = test;
      } else {
        lines.push(line || words[i]);
        line = words[i];
        if (lines.length === maxLines - 1) {
          // Última línea: mete todo lo que queda y salimos
          line = words.slice(i + 1).length ? (line + ' ' + words.slice(i + 1).join(' ')) : line;
          break;
        }
      }
    }
    if (line) lines.push(line);
    return lines;
  }

  // Reduce el tamaño de fuente (px) hasta que quepa en 1–2 líneas
  function fitAndWrap(ctx, basePx, text, maxWidth, maxLines = 2, minPx = 11) {
    let px = basePx, lines = [];
    while (px >= minPx) {
      ctx.font = `${px}px monospace`;
      lines = wrapText(ctx, text, maxWidth, maxLines);
      if (lines.length <= maxLines && lines.every(l => ctx.measureText(l).width <= maxWidth)) break;
      px--;
    }
    return { px, lines };
  }

  function drawNameTags(ctx, camera, G) {
    if (!ctx || !G) return;
    const canvas = ctx.canvas;
    for (const pat of G.patients || []) {
      if (!pat || pat.dead || pat.attended) continue;
      const name = pat.displayName || pat.name || 'Paciente';
      const centerX = (pat.x || 0) + (pat.w || 0) * 0.5;
      const offsetBase = Number.isFinite(pat.nameTagYOffset) ? pat.nameTagYOffset : 0;
      const pos = toScreen(camera, canvas, centerX, (pat.y || 0) - offsetBase - 30);
      ctx.save();
      ctx.font = 'bold 13px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(0,0,0,0.55)';
      ctx.strokeText(name, pos.x, pos.y);
      ctx.fillStyle = '#ffe27a';
      ctx.fillText(name, pos.x, pos.y);
      ctx.restore();
    }
  }

  function drawFloatingMessages(ctx, camera, G) {
    if (!ctx) return;
    const now = performance.now();
    const canvas = ctx.canvas;
    for (let i = FloatingMessages.length - 1; i >= 0; i--) {
      const msg = FloatingMessages[i];
      const life = (now - msg.created) / 1000;
      if (life >= msg.dur) {
        FloatingMessages.splice(i, 1);
        continue;
      }
      const ent = findEntityById(G, msg.targetId) || msg.fallback;
      if (!ent) { FloatingMessages.splice(i, 1); continue; }
      const baseX = (ent.x || 0) + (ent.w || 0) * 0.5;
      const baseY = (ent.y || 0) - (msg.offset || ent.nameTagYOffset || 18);
      const rise = (msg.rise || 18) * (life / msg.dur);
      const pos = toScreen(camera, canvas, baseX, baseY - rise);
      const alpha = Math.max(0, 1 - (life / msg.dur));
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.font = 'bold 14px sans-serif';
      ctx.textAlign = 'center';
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(0,0,0,0.6)';
      ctx.strokeText(msg.text, pos.x, pos.y);
      ctx.fillStyle = '#ffffff';
      ctx.fillText(msg.text, pos.x, pos.y);
      ctx.restore();
    }
  }

  function showFloatingMessage(entity, text, seconds = 1.8) {
    if (!entity || !text) return;
    FloatingMessages.push({
      targetId: entity.id || null,
      fallback: entity,
      text: String(text),
      created: performance.now(),
      dur: Math.max(0.2, seconds),
      offset: entity.nameTagYOffset || 18,
      rise: 28
    });
  }

  // API pública
  const HUD = {
    position: S.position, // 'top' | 'bottom'
    setPosition(pos){
      if (pos==='top' || pos==='bottom') {
        S.position = pos;
        HUD.position = pos;
        setHudPositionAttr(pos);
      }
    },
    togglePosition(){
      S.position = (S.position === 'top') ? 'bottom' : 'top';
      HUD.position = S.position;
      setHudPositionAttr(S.position);
    },

    init(opts){
      if (opts && opts.position) HUD.setPosition(opts.position);
      // Tecla H para conmutar arriba/abajo (opcional)
      window.addEventListener('keydown', (e) => {
        if (e.key === 'h' || e.key === 'H') HUD.togglePosition();
      });
      ensureHudDom();
      setHudPositionAttr(S.position);
      const G = getG();
      if (G && typeof G === 'object' && typeof G.onUrgenciasStateChanged !== 'function') {
        G.onUrgenciasStateChanged = (open) => {
          G.urgenciasOpen = !!open;
        };
      }
    },

    // Render principal del HUD como BARRA superior o inferior
    render(ctx, _camera, Gref){
      const G = Gref || getG();
      if (!G) return;
      ensureHudDom();
      updateDomHud(G);
      if (!ctx) return;
      const canvas = ctx.canvas;
      if (!canvas) return;
      const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
      const cssW = canvas.clientWidth || canvas.width || 0;
      const cssH = canvas.clientHeight || canvas.height || 0;
      if (canvas.__hudDpr !== dpr){
        canvas.__hudDpr = dpr;
        canvas.width = Math.max(1, Math.round(cssW * dpr));
        canvas.height = Math.max(1, Math.round(cssH * dpr));
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cssW, cssH);
    }
  };

  HUD.drawWorldOverlays = function(ctx, camera, G) {
    drawNameTags(ctx, camera, G);
    drawFloatingMessages(ctx, camera, G);
  };

  HUD.showFloatingMessage = showFloatingMessage;
  HUD.setObjectiveText = function (text) {
    objectiveOverride = text || null;
    ensureHudDom();
    if (HUD_DOM.objectiveText) {
      const fallback = computeObjective(getG());
      HUD_DOM.objectiveText.textContent = objectiveOverride || fallback;
    }
  };
  HUD.setHeroFace = setHeroFace;

  W.HUD = HUD;
  // Inicializa con posición por defecto (móvil abajo / PC arriba)
  HUD.init({});
})();