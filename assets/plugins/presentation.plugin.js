// presentation.api.js — Intro de viñetas automática (cinemática)
(function (W, D) {
  'use strict';

  // --- configuración de viñetas (26)
  const FRAME_NUMBERS = Array.from({length: 26}, (_, i) => i + 1);
  const LOGO_FRAME = 26; // ← viñeta del logo final (vuelo obligatorio)
  const BOOK_FRAMES = new Set([4,5,6,7,11,15,21]); // páginas de "libro": +tiempo
  const IMG_PATH  = n => `./assets/images/Intro/vineta-${n}.png`;


  // --- estado
  let overlay, img, started = false, idx = -1, timer = 0;

  // --- DOM overlay
  function ensureDOM(){
    overlay = D.getElementById('introOverlay');
    if (!overlay){
      overlay = D.createElement('div');
      overlay.id = 'introOverlay';
      overlay.innerHTML = `<img id="introFrame" alt="intro frame" />
        <div id="intro-ui-layer" class="ui intro-ui-layer" aria-live="polite" aria-atomic="true">
          <span class="hint intro-message intro-skip-hint">Pulsa una tecla o haz clic para comenzar.</span>
        </div>`;
      D.body.appendChild(overlay);
    }
    img = overlay.querySelector('#introFrame');
    // estilo mínimo para el fade del propio <img>
    img.style.opacity = 0;
    img.style.transition = 'opacity .45s ease';
  }

  // --- util: carga con fallback (con/sin tilde) + último recurso (logo_juego.png)
  function setSrc(n, cb){
    const primary = IMG_PATH(n);

    img.onerror = () => {
      img.onerror = null;
      if (n === LOGO_FRAME) img.src = './assets/images/logo_juego.png';
      cb && cb();
    };
    img.onload  = () => cb && cb();
    img.src = primary;
  }


  // --- tiempos por viñeta (sincronía ligera con la música)
  function msFor(n){
    const base = 2100;           // 2.1s por defecto
    const extra= BOOK_FRAMES.has(n) ? 1100 : 0;  // +1.1s si es “libro”
    return base + extra;
  }

  const __PRES_LISTENERS__ = [];
  function __on(el, ev, fn, opts){ el?.addEventListener?.(ev, fn, opts); __PRES_LISTENERS__.push([el,ev,fn,opts]); }
  function __unbindAll__(){ for (const [el,ev,fn,opts] of __PRES_LISTENERS__) { try{ el?.removeEventListener?.(ev, fn, opts); }catch(_){ } } __PRES_LISTENERS__.length = 0; }

  // --- NUEVO: permitir saltar la intro con tecla/clic (una sola vez)
function bindSkip(){
  if (W.__introSkipBound) return;
  W.__introSkipBound = true;

  let unlocked = false;
  let skipArmed = false;
  const hint = () => overlay && overlay.querySelector('.hint');

  // 1º gesto → activa audio y COMIENZA el pase de viñetas
  const unlock = () => {
    if (unlocked) return;
    unlocked = true;
    try {
      if (window.MusicManager?.fadeTo) {
        if (!window.__introMusicStarted) {
          window.__introMusicStarted = true;      // ← marca que ya suena la intro
          MusicManager.fadeTo('intro', { fadeTime: 0.2 });
        }
      }
    } catch(_) {}
    if (hint()) hint().textContent = 'Intro en curso… pulsa cualquier tecla o clic para saltarla.';
    beginSlides(); // programa next() a partir de la viñeta 1

    // Evita que el mismo gesto dispare el salto
    setTimeout(() => { skipArmed = true; }, 280);

    // 2º gesto → SALTO al final (vuelo del logo)
    const skip = () => { if (!skipArmed) return; logoFly(); };
  __on(window, 'keydown',     skip, { once:true, capture:true });
  __on(window, 'pointerdown', skip, { once:true, passive:true, capture:true });
  __on(overlay, 'pointerdown', skip, { once:true, passive:true, capture:true });
  };

__on(window, 'keydown',     unlock, { once:true, capture:true });
__on(window, 'pointerdown', unlock, { once:true, passive:true, capture:true });
__on(overlay, 'pointerdown', unlock, { once:true, passive:true, capture:true });
}

  // --- iniciar el pase automático de viñetas DESPUÉS del primer gesto
  function beginSlides(){
    if (W.__slidesRunning) return;
    W.__slidesRunning = true;
    clearTimeout(timer);
    // ya estamos mostrando la 1; programa salto a la 2 cuando toque
    timer = setTimeout(next, msFor(1));
  }

  // --- pasar a la siguiente viñeta con fade in/out
  function next(){
    idx++;
    if (idx >= FRAME_NUMBERS.length) return logoFly();

    const n = FRAME_NUMBERS[idx];
    img.style.opacity = 0;

    setTimeout(() => {
      setSrc(n, () => {
        requestAnimationFrame(() => { img.style.opacity = 1; });
        clearTimeout(timer);
        timer = setTimeout(next, msFor(n));
      });
    }, 220);
  }

  function start(){
    if (started) return;
    started = true;

    try {
      D?.body?.classList?.add('intro-playing');
    } catch (_) {}

    const menu = D.getElementById('start-screen');
    if (menu){
      menu.classList.add('hidden', 'intro-hide-ui', 'intro-disable-ui');
    }

    // Muestra la PRIMERA viñeta en pausa (sin música aún)
    overlay.style.display = 'grid';
    overlay.classList.add('visible');

    // Marca que la 1 ya está en pantalla y deja la animación parada
    idx = 1;
    setSrc(1, () => { requestAnimationFrame(() => { img.style.opacity = 1; }); });

    // El primer gesto desbloquea audio y DA COMIENZO a las diapositivas
    bindSkip();
  }

  // VUELO OBLIGATORIO: muestra el LOGO_FRAME, lo encoge y lo mueve a la esquina con destello.
  function logoFly(){
    if (W.__logoFlew) return finish();   // evita doble ejecución
    W.__logoFlew = true;

    clearTimeout(timer);
    overlay.classList.add('visible');

    // Asegura que, si el navegador bloqueó audio, al primer gesto o aquí suene.
    try{
      if (W.MusicManager && MusicManager.fadeTo) {
        if (!window.__introMusicStarted) { window.__introMusicStarted = true; MusicManager.fadeTo('intro', { fadeTime: 0.3 }); } // no reintentar si ya sonaba
      }
    }catch(_){}

    // Carga la viñeta del LOGO y ANIMA hacia la esquina
    setSrc(LOGO_FRAME, () => {
      img.style.opacity = 1;                 // logo a pantalla
      img.classList.remove('to-corner');     // reinicia anim por si ya estaba
      void img.offsetWidth;                  // fuerza reflow del navegador
// Calcula destino (esquina sup-dcha de la FOTO del start-screen)
const menu = D.getElementById('start-screen');
if (menu) menu.classList.remove('hidden');        // visible para medir
const sr = menu ? menu.getBoundingClientRect() : D.body.getBoundingClientRect();
const r0 = img.getBoundingClientRect();
const MARGIN = 16;
const targetScale = 0.14;                          // tamaño final del logo
const targetW = r0.width  * targetScale;
const targetH = r0.height * targetScale;

// Centro actual del logo (antes de volar)
const curCx = r0.left + r0.width  / 2;
const curCy = r0.top  + r0.height / 2;
// Centro objetivo del logo arriba-dcha de la foto
const tgtCx = sr.right - MARGIN - targetW/2;
const tgtCy = sr.top   + MARGIN + targetH/2;

// Traducciones para @keyframes (desde el centro al centro)
overlay.style.setProperty('--tc-x', (tgtCx - curCx) + 'px');
overlay.style.setProperty('--tc-y', (tgtCy - curCy) + 'px');
overlay.style.setProperty('--tc-scale', targetScale);

// Lanza la animación
img.classList.add('to-corner');

// Al terminar, mueve logo+halo DENTRO del start-screen en la MISMA posición/tamaño
img.addEventListener('animationend', () => {
  img.classList.remove('to-corner');
  img.style.opacity = '1';

  const r = img.getBoundingClientRect();          // posición final en viewport

  // Crea el contenedor definitivo dentro del start-screen
  let wrap = D.getElementById('brandWrap');
  if (!wrap) {
    wrap = D.createElement('div');
    wrap.id = 'brandWrap';
    wrap.className = 'brand-wrap';
    menu.appendChild(wrap);
  }
  // Posición y tamaño EXACTOS usando las mismas metas del vuelo (sin “medir” nada)
  // (coinciden con la última keyframe de la animación)
  const finalLeft = tgtCx - targetW / 2;   // coordenadas absolutas en viewport
  const finalTop  = tgtCy - targetH / 2;

  // Posiciona el wrap respecto al #start-screen
  const Wpx = Math.round(targetW) + 'px';
  const Hpx = Math.round(targetH) + 'px';
  wrap.style.left   = Math.round(finalLeft - sr.left) + 'px';
  wrap.style.top    = Math.round(finalTop  - sr.top ) + 'px';
  wrap.style.width  = Wpx;
  wrap.style.height = Hpx;
  wrap.style.setProperty('--brand-w', Wpx); // por si tu CSS lo usa

  // Mueve el <img> dentro del wrap, fija su tamaño y limpia transform
  img.style.transform = 'none';
  img.style.width  = Wpx;
  img.style.height = 'auto';
  wrap.appendChild(img);

  // Crea/ajusta el halo “fuego” por detrás del logo (centrado y proporcional)
  let halo = wrap.querySelector('.brand-halo');
  if (!halo) {
    halo = D.createElement('div');
    halo.className = 'brand-halo';
    wrap.appendChild(halo);
  }
  halo.style.position = 'absolute';
  halo.style.left = '-10%';
  halo.style.top  = '-10%';
  halo.style.transform = 'translate(-50%,-50%)';
  halo.style.width  = `calc(${Wpx} * 1.25)`;   // 125% del logo
  halo.style.height = `calc(${Hpx} * 1.25)`;
  halo.style.pointerEvents = 'none';
  halo.style.zIndex = '0';

  // Quita el overlay: ya no se necesita
  overlay.remove();

  // Muestra el menú y dispara el evento de fin
  finish();
}, { once: true });
    });
  }

function finish(){
  __unbindAll__();   // ← elimina cualquier listener de la intro
  clearTimeout(timer);
  const menu = document.getElementById('start-screen');
  if (menu){
    menu.classList.remove('hidden');
    menu.style.animation = 'pa2FadeIn .45s ease';
  }
  window.dispatchEvent(new Event('intro:complete'));
}

  // —— helpers compartidos para overlays in-game ——
  const SCOREBOARD_STATE = {
    listeners: [],
    rows: [],
    overlay: null,
    button: null,
    totalEl: null,
    totalTarget: 0,
    running: false,
    finished: false,
    skip: false,
    proceed: null
  };

  function addScoreboardListener(el, ev, fn, opts){
    if (!el || typeof el.addEventListener !== 'function') return;
    el.addEventListener(ev, fn, opts);
    SCOREBOARD_STATE.listeners.push([el, ev, fn, opts]);
  }

  function clearScoreboardListeners(){
    for (const [el, ev, fn, opts] of SCOREBOARD_STATE.listeners.splice(0)) {
      try { el.removeEventListener(ev, fn, opts); } catch (_) {}
    }
  }

  function formatPoints(n){
    const value = Number(n) || 0;
    return value.toLocaleString('es-ES');
  }

  const easeOutCubic = (t) => (1 - Math.pow(1 - t, 3));

  function animateValue(el, target, onDone){
    if (!el){ onDone && onDone(); return; }
    if (SCOREBOARD_STATE.skip){
      el.textContent = formatPoints(target);
      onDone && onDone();
      return;
    }
    const start = performance.now();
    const duration = 520 + Math.min(780, Math.abs(Number(target) || 0) * 4);

    function step(ts){
      if (SCOREBOARD_STATE.skip){
        el.textContent = formatPoints(target);
        onDone && onDone();
        return;
      }
      const t = Math.min(1, (ts - start) / duration);
      const eased = easeOutCubic(t);
      const value = Math.round((Number(target) || 0) * eased);
      el.textContent = formatPoints(value);
      if (t < 1) {
        requestAnimationFrame(step);
      } else {
        onDone && onDone();
      }
    }

    requestAnimationFrame(step);
  }

  function finishScoreboard(){
    if (!SCOREBOARD_STATE.running) return;
    SCOREBOARD_STATE.running = false;
    SCOREBOARD_STATE.skip = false;
    SCOREBOARD_STATE.finished = false;
    clearScoreboardListeners();
    if (SCOREBOARD_STATE.overlay){
      SCOREBOARD_STATE.overlay.classList.add('hidden');
      SCOREBOARD_STATE.overlay.classList.remove('scoreboard-ready');
      SCOREBOARD_STATE.overlay.removeAttribute('data-scoreboard-level');
    }
    SCOREBOARD_STATE.rows.length = 0;
    SCOREBOARD_STATE.overlay = null;
    SCOREBOARD_STATE.button = null;
    SCOREBOARD_STATE.totalEl = null;
    SCOREBOARD_STATE.totalTarget = 0;
    const proceed = SCOREBOARD_STATE.proceed;
    SCOREBOARD_STATE.proceed = null;
    proceed && proceed();
  }

  function skipScoreboard(){
    if (!SCOREBOARD_STATE.running || SCOREBOARD_STATE.skip) return;
    SCOREBOARD_STATE.skip = true;
    for (const row of SCOREBOARD_STATE.rows){
      if (!row) continue;
      row.el?.classList.add('revealed');
      if (row.valueEl) row.valueEl.textContent = formatPoints(row.points);
    }
    if (SCOREBOARD_STATE.totalEl){
      SCOREBOARD_STATE.totalEl.textContent = formatPoints(SCOREBOARD_STATE.totalTarget || 0);
    }
    scoreboardComplete();
  }

  function scoreboardComplete(){
    if (!SCOREBOARD_STATE.running || SCOREBOARD_STATE.finished) return;
    SCOREBOARD_STATE.finished = true;
    if (SCOREBOARD_STATE.overlay){
      SCOREBOARD_STATE.overlay.classList.add('scoreboard-ready');
    }
    if (SCOREBOARD_STATE.button){
      SCOREBOARD_STATE.button.disabled = false;
      SCOREBOARD_STATE.button.focus?.();
    }
  }

  function ensureReadyOverlay(){
    return D.getElementById('ready-overlay');
  }

  function runLevelIntro(level, done){
    const overlayReady = ensureReadyOverlay();
    if (!overlayReady){ done && done(); return; }
    const levelEl = overlayReady.querySelector('#ready-level');
    const countEl = overlayReady.querySelector('#ready-count');
    const msgEl   = overlayReady.querySelector('#ready-message');
    if (levelEl) levelEl.textContent = `Turno ${level}`;
    overlayReady.classList.remove('hidden');
    overlayReady.classList.add('ready-visible');

    const phases = [
      { count: '3', message: '¡Preparados!' },
      { count: '2', message: '¡Listos!' },
      { count: '1', message: '¡Ya casi!' },
      { count: '¡YA!', message: '¡A atender!' }
    ];

    let idx = 0;
    function showPhase(){
      const phase = phases[idx++];
      if (!phase){ return finishIntro(); }
      if (countEl){
        countEl.textContent = phase.count;
        countEl.classList.remove('animate');
        void countEl.offsetWidth; // reflow para reiniciar animación
        countEl.classList.add('animate');
      }
      if (msgEl) msgEl.textContent = phase.message;
      const delay = idx === phases.length ? 720 : 560;
      setTimeout(() => {
        if (idx >= phases.length){
          finishIntro();
        } else {
          showPhase();
        }
      }, delay);
    }

    function finishIntro(){
      setTimeout(() => {
        countEl?.classList.remove('animate');
        overlayReady.classList.add('hidden');
        overlayReady.classList.remove('ready-visible');
        done && done();
      }, 360);
    }

    showPhase();
  }

  function runScoreboard(level, data, proceed){
    const overlay = D.getElementById('level-complete-screen');
    const rowsWrap = overlay?.querySelector('#scoreboard-rows');
    const totalEl = overlay?.querySelector('#scoreboard-total');
    const button = overlay?.querySelector('#scoreboard-continue');
    const title = overlay?.querySelector('#scoreboard-title');
    const subtitle = overlay?.querySelector('#scoreboard-subtitle');
    if (!overlay || !rowsWrap || !totalEl || !button){
      proceed && proceed();
      return;
    }

    overlay.classList.remove('hidden');
    overlay.classList.remove('scoreboard-ready');
    overlay.setAttribute('data-scoreboard-level', String(level));
    if (title) title.textContent = `¡Nivel ${level} completado!`;
    if (subtitle) subtitle.textContent = 'Desglose de puntuación';
    button.disabled = true;
    rowsWrap.innerHTML = '';
    totalEl.textContent = '0';

    const breakdown = Array.isArray(data?.breakdown) && data.breakdown.length
      ? data.breakdown
      : [{ label: 'Puntos del nivel', points: Number(data?.total || 0) }];

    SCOREBOARD_STATE.listeners.length = 0;
    SCOREBOARD_STATE.rows.length = 0;
    SCOREBOARD_STATE.overlay = overlay;
    SCOREBOARD_STATE.button = button;
    SCOREBOARD_STATE.totalEl = totalEl;
    SCOREBOARD_STATE.totalTarget = Number(data?.total);
    if (!Number.isFinite(SCOREBOARD_STATE.totalTarget)){
      SCOREBOARD_STATE.totalTarget = breakdown.reduce((acc, row) => acc + (Number(row.points) || 0), 0);
    }
    SCOREBOARD_STATE.running = true;
    SCOREBOARD_STATE.finished = false;
    SCOREBOARD_STATE.skip = false;
    SCOREBOARD_STATE.proceed = proceed;

    breakdown.forEach((entry, idx) => {
      const row = {
        label: entry?.label || entry?.reason || `Entrada ${idx + 1}`,
        points: Number(entry?.points ?? entry?.pts ?? 0) || 0,
        el: null,
        valueEl: null
      };
      const node = D.createElement('div');
      node.className = 'score-row';
      node.setAttribute('role', 'listitem');
      const labelEl = D.createElement('span');
      labelEl.className = 'score-label';
      labelEl.textContent = row.label;
      const valueEl = D.createElement('span');
      valueEl.className = 'score-value';
      valueEl.textContent = '0';
      node.appendChild(labelEl);
      node.appendChild(valueEl);
      rowsWrap.appendChild(node);
      row.el = node;
      row.valueEl = valueEl;
      SCOREBOARD_STATE.rows.push(row);
    });

    let revealIndex = 0;

    function revealNext(){
      if (!SCOREBOARD_STATE.running) return;
      if (revealIndex >= SCOREBOARD_STATE.rows.length){
        animateValue(totalEl, SCOREBOARD_STATE.totalTarget || 0, scoreboardComplete);
        return;
      }
      const row = SCOREBOARD_STATE.rows[revealIndex++];
      if (row?.el){
        row.el.classList.add('revealed');
      }
      animateValue(row?.valueEl, row?.points || 0, () => {
        if (SCOREBOARD_STATE.skip) return;
        revealNext();
      });
    }

    revealNext();

    const overlayClick = (ev) => {
      if (!SCOREBOARD_STATE.running) return;
      if (ev.target === overlay) {
        ev.preventDefault();
        if (!SCOREBOARD_STATE.finished) {
          skipScoreboard();
        } else {
          finishScoreboard();
        }
      }
    };

    const keyHandler = (ev) => {
      if (!SCOREBOARD_STATE.running) return;
      const key = ev.key?.toLowerCase();
      if (key === 'enter' || key === ' '){
        ev.preventDefault();
        if (!SCOREBOARD_STATE.finished) {
          skipScoreboard();
        } else {
          finishScoreboard();
        }
      }
      if (key === 'escape' && SCOREBOARD_STATE.finished){
        ev.preventDefault();
        finishScoreboard();
      }
    };

    const buttonHandler = (ev) => {
      ev.preventDefault();
      if (!SCOREBOARD_STATE.finished){
        skipScoreboard();
      } else {
        finishScoreboard();
      }
    };

    addScoreboardListener(overlay, 'click', overlayClick);
    addScoreboardListener(window, 'keydown', keyHandler, true);
    addScoreboardListener(button, 'click', buttonHandler);
  }

  function animateGameOver(){
    const overlay = D.getElementById('game-over-screen');
    const box = overlay?.querySelector('.menu-box');
    if (!overlay || !box) return;
    overlay.classList.remove('hidden');
    box.classList.remove('shake');
    void box.offsetWidth; // reinicia animación CSS
    box.classList.add('shake');
  }

  // API pública
  W.PresentationAPI = Object.assign(W.PresentationAPI || {}, {
    playIntroSequence(){
      ensureDOM();
      // intentamos arrancar inmediatamente (si el navegador bloquea audio,
      // la secuencia sigue pero quizá muteada; el usuario lo puede activar luego)
      start();
    },

    levelIntro(level, done){
      runLevelIntro(level, done);
    },

    levelComplete(level, data, proceed){
      runScoreboard(level, data, proceed);
    },

    gameOver(){
      animateGameOver();
    }
  });

})(window, document);
