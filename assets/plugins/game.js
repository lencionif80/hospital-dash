/* Il Divo: Hospital Dash! — Motor central
   - Núcleo autosuficiente y estable para integrar plugins/APIs sin romper el loop.
   - Mantiene: física AABB con subpasos, empuje “Rompers”, cámara con zoom, HUD nítido,
     luces con cono del héroe (oscurece y desenfoca fuera), mapa ASCII mínimo con secuencia base.
   - Plugin de luces opcional (window.LightingAPI). El motor no depende de él.
*/
(() => {
  'use strict';

  // ------------------------------------------------------------
  // Parámetros globales y utilidades
  // ------------------------------------------------------------
  const TILE = 32;
  const VIEW_W = 960;
  const VIEW_H = 540;
  const FORCE_PLAYER = 40.0;

  const ENT = {
    PLAYER: 1,
    PATIENT: 2,
    PILL: 3,
    BED: 4,
    CART: 5,
    RAT: 6,
    MOSQUITO: 7,
    DOOR: 8,
    BOSS: 9,
  };

  const COLORS = {
    floor: '#111418',
    wall: '#31363f',
    bed: '#6ca0dc',
    cart: '#b0956c',
    doorClosed: '#7f8c8d',
    doorOpen: '#2ecc71',
    patient: '#ffd166',
    pill: '#a0ffcf',
    rat: '#c7c7c7',
    mosquito: '#ff77aa',
    boss: '#e74c3c',
    player: '#9cc2ff',
    hudText: '#e6edf3',
    hudBg: '#0b0d10',
  };

  // Balance (ligero; extensible sin romper APIs)
  const BALANCE = {
    physics: {
      substeps: 4,
      friction: 0.90,
      playerFriction: 0.86,
      restitution: 0.65,
      pushImpulse: 340,
      maxSpeedPlayer: 165,
      maxSpeedObject: 360
    },
    enemies: {
      mosquito: {
        speed: 10,
        max: 1,
        // ahora en MINUTOS (2–4 min aleatorio por spawn)
        respawnDelayMin: 120,   // 2 minutos
        respawnDelayMax: 240,   // 4 minutos
        zigzag: 42
      }
    },
    cycle: { secondsFullLoop: 1800 },
    hearts: { max: 6, halfHearts: true },
  };

  // Estado global visible
  const G = {
    state: 'START', // START | PLAYING | PAUSED | COMPLETE | GAMEOVER
    time: 0,
    score: 0,
    health: 6, // medias vidas (0..6)
    entities: [],
    movers: [],
    enemies: [],
    patients: [],
    pills: [],
    lights: [],       // lógicas (para info)
    roomLights: [],   // focos de sala
    npcs: [],         // (los pacientes cuentan como NPC)
    mosquitoSpawn: null,
    door: null,
    cart: null,
    boss: null,
    player: null,
    map: [],
    mapW: 0,
    mapH: 0,
    timbresRest: 1,
    delivered: 0,
    lastPushDir: { x: 1, y: 0 },
    carry: null,      // <- lo que llevas en la mano (pastilla)
    cycleSeconds: 0
  };
  window.G = G; // (expuesto)

  // ------------------------------------------------------------
  // Exportador de mapas ASCII para debug
  // ------------------------------------------------------------
  window.DebugMapExport = window.DebugMapExport || {};
  const DebugMapExport = window.DebugMapExport;

  DebugMapExport.buildAsciiDump = function(levelState){
    const state = levelState || {};
    const meta = state.meta || {};
    const asciiRows = Array.isArray(state.asciiRows) ? state.asciiRows.map(String) : [];

    const width = meta.width ?? (asciiRows[0] ? asciiRows[0].length : 0);
    const height = meta.height ?? asciiRows.length;
    const roomsRequested = meta.roomsRequested ?? meta.rooms ?? meta.level?.rooms;
    const roomsGenerated = meta.roomsGenerated ?? meta.roomsCount;
    const floorPercent = meta.floorPercent ?? null;
    const generationBase = { ...(meta.generation || {}) };

    const generation = {
      ...generationBase,
      roomsRequested: generationBase.roomsRequested ?? roomsRequested,
      roomsGenerated: generationBase.roomsGenerated ?? roomsGenerated,
      corridorWidthUsed: generationBase.corridorWidthUsed ?? meta.corridorWidth ?? generationBase.corridorWidth,
      corridorsBuilt: generationBase.corridorsBuilt ?? meta.corridorsBuilt ?? meta.generation?.corridorsBuilt,
      culling: generationBase.culling ?? meta.culling ?? meta.level?.culling ?? meta.globals?.culling,
      cooling: generationBase.cooling ?? meta.cooling ?? meta.level?.cooling ?? meta.globals?.cooling,
      floorPercent: generationBase.floorPercent ?? floorPercent,
      walkableTiles: generationBase.walkableTiles ?? meta.walkableTiles,
      totalTiles: generationBase.totalTiles ?? meta.totalTiles,
      allRoomsReachable: generationBase.allRoomsReachable ?? meta.allRoomsReachable,
      bossReachable: generationBase.bossReachable ?? meta.bossReachable,
      boss: generationBase.boss ?? meta.boss ?? meta.level?.boss,
      difficulty: generationBase.difficulty ?? meta.difficulty ?? meta.level?.difficulty
    };

    const normalizedMeta = {
      ...meta,
      width,
      height,
      generation,
      roomsRequested,
      roomsGenerated,
      floorPercent,
      meta_extra: meta.meta_extra || meta.metaExtra || null
    };

    const lines = [];
    lines.push('timestamp: ' + new Date().toISOString());
    if (meta.levelId != null)  lines.push('levelId: ' + meta.levelId);
    if (meta.mode)             lines.push('mode: ' + meta.mode);
    if (meta.seed != null)     lines.push('seed: ' + meta.seed);
    if (generation.culling != null) lines.push('culling: ' + generation.culling);
    lines.push('source: level_rules.xml');
    lines.push('[globals]');
    lines.push(JSON.stringify(meta.globals || {}, null, 2));
    lines.push('[level]');
    lines.push(JSON.stringify(meta.level || {}, null, 2));
    lines.push('[rules]');
    lines.push(JSON.stringify(meta.rules || [], null, 2));
    lines.push('[generation]');
    lines.push(JSON.stringify(generation, null, 2));
    if (meta.meta_extra || meta.metaExtra) {
      lines.push('[meta_extra]');
      lines.push(JSON.stringify(meta.meta_extra || meta.metaExtra, null, 2));
    }
    lines.push('');

    for (let i = 0; i < asciiRows.length; i++) {
      lines.push(asciiRows[i]);
    }
    lines.push('');

    return {
      meta: normalizedMeta,
      ascii: asciiRows.join('\n'),
      textBlock: lines.join('\n')
    };
  };

  DebugMapExport.sendToServer = function(dump){
    if (!dump) return Promise.resolve();
    return fetch('debug-export.php', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        meta: dump.meta || {},
        ascii: dump.ascii || ''
      })
    }).catch(function(err){
      console.error('[DebugMapExport] Error al enviar mapa al servidor', err);
    });
  };
  // Control de respawn diferido (solo al morir)
  const SPAWN = {
    max: BALANCE.enemies.mosquito.max,
    cooldown: rngRange(
      BALANCE.enemies.mosquito.respawnDelayMin,
      BALANCE.enemies.mosquito.respawnDelayMax
    ),
    pending: 0,
    t: 0
  };

  // Canvas principal + fog + HUD (capas independientes)
  const canvas    = document.getElementById('gameCanvas');
  const ctx       = canvas.getContext('2d');
  const fogCanvas = document.getElementById('fogCanvas');
  const hudCanvas = document.getElementById('hudCanvas');
  const hudCtx    = hudCanvas.getContext('2d');

  window.DEBUG_POPULATE = window.DEBUG_POPULATE || { LOG:false, VERBOSE:false };
  // SkyFX listo desde el menú (antes de startGame)
  window.SkyFX?.init?.({
    canvas,
    getCamera: () => ({ x: camera.x, y: camera.y, zoom: camera.zoom }),
    getMapAABB: () => ({ x: 0, y: 0, w: G.mapW * TILE, h: G.mapH * TILE }),
    worldToScreen: (x, y) => ({
      x: (x - camera.x) * camera.zoom + VIEW_W * 0.5,
      y: (y - camera.y) * camera.zoom + VIEW_H * 0.5
    })
  });
  if (fogCanvas){ fogCanvas.width = VIEW_W; fogCanvas.height = VIEW_H; }
  if (hudCanvas){ hudCanvas.width = VIEW_W; hudCanvas.height = VIEW_H; }

  // === Sprites (plugin unificado) ===
  Sprites.init({ basePath: './assets/images/', tile: TILE });
  Sprites.preload && Sprites.preload();
  // --- INIT de sistemas que pueblan enemigos (antes de los placements) ---
  try { window.MosquitoAPI && MosquitoAPI.init(window.G); } catch(e){}
  try { window.RatsAPI && RatsAPI.init(window.G); } catch(e){}
  // (si tienes otro sistema parecido, inícialo aquí también)

  // === Luces + Niebla ===
  if (window.LightingAPI){
    LightingAPI.init({ gameCanvasId:'gameCanvas', containerId:'game-container', rays:96 });
    LightingAPI.setEnabled(true);
    LightingAPI.setGlobalAmbient(0.35); // luz ambiente leve por si quieres tono cálido
  }
  if (window.FogAPI){
    FogAPI.init({ fogCanvasId:'fogCanvas', gameCanvasId:'gameCanvas' });
    FogAPI.setEnabled(true);
    FogAPI.setSoftness(0.70);
    // 👇 Importante: no fijamos radios aquí. Los pondrá el héroe (Heroes API)
  }


  // Overlays UI (ids reales del index.html)
  const startScreen = document.getElementById('start-screen');
  const pausedScreen = document.getElementById('pause-screen');
  const levelCompleteScreen = document.getElementById('level-complete-screen');
  const gameOverScreen = document.getElementById('game-over-screen');

  // ---- Construye desglose de puntuación para el scoreboard ---------------
  function buildLevelBreakdown(){
    // Si existe ScoreAPI con breakdown, lo usamos. Si no, mostramos un único renglón.
    const totals = (window.ScoreAPI && typeof ScoreAPI.getTotals === 'function')
      ? ScoreAPI.getTotals() : { total: 0, breakdown: [] };

    // Adaptamos {reason/label, pts/points} a {label, points}
    if (Array.isArray(totals.breakdown) && totals.breakdown.length) {
      return totals.breakdown.map(r => ({
        label: r.label || r.reason || 'Puntos',
        points: Number(r.points ?? r.pts ?? 0)
      }));
    }
    // Fallback mínimo
    return [{ label: 'Puntos del nivel', points: Number(totals.total || 0) }];
  }
  // --- Selección de héroe en el menú ---
  (function setupHeroSelection(){
    const cards = document.querySelectorAll('#start-screen .char-card');
    if (!cards.length) return;

    const HERO_AVATAR_SELECTOR = '.hero-avatar';
    const HERO_SELECTED_CLASS = 'is-selected';
    const HERO_DESELECTED_CLASS = 'is-deselected';

    // Estado inicial: lo que esté marcado con .selected en el HTML
    const selInit = document.querySelector('#start-screen .char-card.selected');
    window.G = window.G || {};
    window.selectedHeroKey = (selInit?.dataset?.hero || 'enrique').toLowerCase();
    window.SELECTED_HERO_ID = window.selectedHeroKey;
    G.selectedHero = window.selectedHeroKey;

    let currentCard = selInit || cards[0];
    const initialAvatar = currentCard?.querySelector(HERO_AVATAR_SELECTOR);
    initialAvatar?.classList.add(HERO_SELECTED_CLASS);

    // Limpia clases temporales tras animaciones de salida
    cards.forEach(btn => {
      btn.querySelector(HERO_AVATAR_SELECTOR)?.addEventListener('animationend', (ev) => {
        if (ev.animationName === 'heroSelectedExit') {
          ev.currentTarget.classList.remove(HERO_DESELECTED_CLASS);
        }
      });
    });

    // Al hacer clic en una tarjeta: marcar visualmente y guardar clave
    cards.forEach(btn => {
      btn.addEventListener('click', () => {
        const previousCard = currentCard;
        const previousAvatar = previousCard?.querySelector(HERO_AVATAR_SELECTOR);

        cards.forEach(b => { b.classList.remove('selected'); b.setAttribute('aria-selected','false'); });
        btn.classList.add('selected');
        btn.setAttribute('aria-selected','true');
        const hero = (btn.dataset.hero || 'enrique').toLowerCase();
        window.selectedHeroKey = hero;
        window.SELECTED_HERO_ID = hero;
        window.G.selectedHero = hero;

        if (previousAvatar && previousCard !== btn) {
          previousAvatar.classList.remove(HERO_SELECTED_CLASS);
          previousAvatar.classList.add(HERO_DESELECTED_CLASS);
        }

        const newAvatar = btn.querySelector(HERO_AVATAR_SELECTOR);
        if (newAvatar) {
          newAvatar.classList.remove(HERO_DESELECTED_CLASS);
          newAvatar.classList.add(HERO_SELECTED_CLASS);
        }

        currentCard = btn;
      });
    });

    // Al pulsar "Empezar turno", asegúrate de tener una clave
    document.getElementById('start-button')?.addEventListener('click', () => {
      if (!window.selectedHeroKey) {
        const first = document.querySelector('#start-screen .char-card[data-hero]');
        window.selectedHeroKey = (first?.dataset?.hero || 'enrique').toLowerCase();
      }
      window.SELECTED_HERO_ID = window.selectedHeroKey;
      window.G.selectedHero = window.selectedHeroKey;
    });
  })();
  const metrics = document.getElementById('metricsOverlay') || document.createElement('pre'); // por si no existe

  // Cámara
  const CAMERA_DEFAULT_ZOOM = 0.45;
  const CAMERA_MIN_ZOOM = 0.1;
  const CAMERA_MAX_ZOOM = 3.0;
  const camera = {
    x: 0,
    y: 0,
    zoom: CAMERA_DEFAULT_ZOOM,
    zoomTarget: CAMERA_DEFAULT_ZOOM,
    offsetX: 0,
    offsetY: 0,
    minZoom: CAMERA_MIN_ZOOM,
    maxZoom: CAMERA_MAX_ZOOM,
    defaultZoom: CAMERA_DEFAULT_ZOOM,
  }; // ⬅️ arranca ya alejado

  // RNG simple (semilla fija por demo)
  function mulberry32(a){return function(){var t=a+=0x6D2B79F5;t=Math.imul(t^t>>>15,t|1);t^=t+Math.imul(t^t>>>7,t|61);return((t^t>>>14)>>>0)/4294967296}}
  let RNG = mulberry32(0xC0FFEE);
  function rngRange(a,b){ return a + Math.random()*(b-a); }


// === INPUT CORE (único, sin duplicados) ===
const keys = Object.create(null);
function __preventNavKeys__(k, e){
  if (['arrowup','arrowdown','arrowleft','arrowright',' '].includes(k)) e.preventDefault();
}
function __clearAllKeys__(){ for (const k in keys) keys[k] = false; }

function __onKeyUp__(e){
  try {
    const k = e.key.toLowerCase();
    keys[k] = false;
    __preventNavKeys__(k, e);
  } catch(err){
    console.warn('[INPUT] keyup error:', err);
  }
}

function __onKeyDown__(e){
  try{
    const k = e.key.toLowerCase();
    const code = e.code;

    // Escudo: si el juego está en curso, no dejes que otras capas capten la tecla
    if (window.G?.state === 'PLAYING') {
      e.stopPropagation();
      e.stopImmediatePropagation?.();
    }

    keys[k] = true;
    __preventNavKeys__(k, e);

    // === Atajos comunes ===
    if (k === '0'){ e.preventDefault(); fitCameraToMap(); }
    if (k === 'q'){ addCameraZoom(-0.1); }
    if (k === 'r'){
      if (G.state === 'GAMEOVER' || G.state === 'COMPLETE'){
        e.preventDefault();
        try { PresentationAPI.levelIntro(G.level || 1, () => startGame()); }
        catch(_){ startGame(); }
        return;
      }else{
        addCameraZoom(0.1);
      }
    }
    if (k === 'f1'){ e.preventDefault(); metrics.style.display = (metrics.style.display === 'none' ? 'block' : 'none'); }
    if (k === 'escape'){ togglePause(); }

    // === Clima/Fog — protegidas con try/catch ===
    if (code === 'Digit1'){ e.preventDefault(); try{ SkyFX?.setLevel?.(1); FogAPI?.setEnabled?.(true); FogAPI?.setDarkness?.(0); if (window.DEBUG_FORCE_ASCII) console.log('[Key1] Día'); }catch(err){ console.warn('[Key1] error:', err); } }
    if (code === 'Digit2'){ e.preventDefault(); try{ SkyFX?.setLevel?.(2); FogAPI?.setEnabled?.(true); FogAPI?.setDarkness?.(1); if (window.DEBUG_FORCE_ASCII) console.log('[Key2] Noche'); }catch(err){ console.warn('[Key2] error:', err); } }
    if (code === 'Digit3'){ e.preventDefault(); try{ SkyFX?.setLevel?.(3); FogAPI?.setEnabled?.(true); FogAPI?.setDarkness?.(1); if (window.DEBUG_FORCE_ASCII) console.log('[Key3] Tormenta'); }catch(err){ console.warn('[Key3] error:', err); } }
    if (code === 'Digit4'){ // Sólo alterna FOW, NUNCA salir del juego
      e.preventDefault();
      try{
        const next = !(window.FogAPI && FogAPI._enabled);
        FogAPI?.setEnabled?.(next);
        if (window.DEBUG_FORCE_ASCII) console.log('[Key4] FOW', next ? 'ON' : 'OFF');
      }catch(err){ console.warn('[Key4] error:', err); }
      return; // <- no dejes que nada más maneje esta tecla
    }
    if (code === 'Digit5'){ e.preventDefault(); try{ window.ArrowGuide?.setEnabled?.(!window.ArrowGuide?.enabled); if (window.DEBUG_FORCE_ASCII) console.log('[Key5] ArrowGuide toggled'); }catch(err){ console.warn('[Key5] error:', err); } }

  }catch(err){
    console.warn('[INPUT] keydown error:', err);
  }
}

// Registro ÚNICO en captura (bloquea otras capas)
document.removeEventListener('keydown', __onKeyDown__, true);
document.removeEventListener('keyup', __onKeyUp__, true);
document.addEventListener('keydown', __onKeyDown__, { capture:true });
document.addEventListener('keyup',   __onKeyUp__,   { capture:true });
window.addEventListener('blur', __clearAllKeys__);

// Acción con E (usar/empujar) — también en captura
document.addEventListener('keydown', (e)=>{
  if (e.key.toLowerCase() === 'e'){ e.preventDefault(); doAction(); }
}, { capture:true });




  // si la ventana pierde el foco, vaciamos todas las teclas
  window.addEventListener('blur', () => {
    for (const key in keys) keys[key] = false;
  });

  function setCameraZoom(z, immediate = false){
    const zc = clamp(z, CAMERA_MIN_ZOOM, CAMERA_MAX_ZOOM);
    camera.zoomTarget = zc;
    if (immediate) camera.zoom = zc;
  }

  function addCameraZoom(dz){
    setCameraZoom(camera.zoomTarget + dz);
  }

  function resetCameraView(){
    camera.offsetX = 0;
    camera.offsetY = 0;
    setCameraZoom(CAMERA_DEFAULT_ZOOM, true);
  }

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const dz = e.deltaY > 0 ? -0.1 : 0.1;
    addCameraZoom(dz);
  }, { passive: false });

  function fitCameraToMap(padding = 0.95){
    const W = G.mapW * TILE, H = G.mapH * TILE;
    if (!W || !H) return;
    const zx = VIEW_W / W, zy = VIEW_H / H;
    setCameraZoom(Math.max(0.1, Math.min(zx, zy) * padding), true);
    camera.x = W * 0.5;
    camera.y = H * 0.5;
  }

  function clamp(v, a, b){ return Math.max(a, Math.min(b, v)); }

  // Offscreens para composición (escena nítida y desenfocada)
  const sceneCanvas = document.createElement('canvas');
  const sceneCtx = sceneCanvas.getContext('2d');
  const blurCanvas = document.createElement('canvas');
  const blurCtx = blurCanvas.getContext('2d');

  function ensureBuffers(){
    if (sceneCanvas.width !== VIEW_W || sceneCanvas.height !== VIEW_H) {
      sceneCanvas.width = VIEW_W; sceneCanvas.height = VIEW_H;
      blurCanvas.width = VIEW_W; blurCanvas.height = VIEW_H;
    }
  }

  // ------------------------------------------------------------
  // Mapa ASCII — leyenda completa (usa placement.api.js)
  // S: spawn del héroe
  // P: paciente encamado
  // I: pastilla vinculada al paciente (target = primer P si no se indica)
  // D: puerta boss cerrada (se abre al terminar pacientes normales)
  // X: boss (inmóvil)
  // C: carro de urgencias (1º ER, 2º MED, resto FOOD)
  // M: spawner de mosquito (tiles)
  // R: spawner de rata (tiles)
  // m: enemigo directo mosquito (px)
  // r: enemigo directo rata (px)
  // E: ascensor
  // H: NPC médico    | U: supervisora | T: TCAE
  // G: guardia       | F: familiar    | N: enfermera sexy
  // L: luz de sala
  // #: pared  · .: suelo
  // ------------------------------------------------------------
    // Mapa por defecto (inmutable)
    const DEFAULT_ASCII_MAP = [
    "##############################",
    "#............................#",
    "#....####............####....#",
    "#......S#.......#....#..#....#",
    "#....#..#.......#....#.......#",
    "#....####.......#....####....#",
    "#...............#............#",
    "#...............#............#",
    "#............####............#",
    "#............#..#............#",
    "#...............#............#",
    "#............####............#",
    "##############################",
    ];
    // --- Flags globales de modo mapa ---
    const __qs = new URLSearchParams(location.search);
    const MAP_MODE = (__qs.get('map') || '').toLowerCase();
    window.__MAP_MODE = MAP_MODE;                 // para compatibilidad con código viejo

    const DEBUG_FORCE_ASCII = (window.DEBUG_FORCE_ASCII === true)
      || MAP_MODE === 'debug'
      || MAP_MODE === 'mini'
      || MAP_MODE === 'ascii';

    const DEBUG_MINIMAP = (window.DEBUG_MINIMAP === true)
      || MAP_MODE === 'mini'
      || __qs.get('mini') === '1'
      || __qs.get('mini') === 'true';

    window.DEBUG_FORCE_ASCII = DEBUG_FORCE_ASCII;
    window.DEBUG_MINIMAP = DEBUG_MINIMAP;

    window.G = window.G || {};
    G.flags = G.flags || {};
    G.flags.DEBUG_FORCE_ASCII = DEBUG_FORCE_ASCII;
    G.flags.DEBUG_MINIMAP = DEBUG_MINIMAP;

    // Mapa ASCII mini (para pruebas rápidas con ?map=mini)
    const DEBUG_ASCII_MINI = DEFAULT_ASCII_MAP;

// Mapa activo (se puede sustituir por el de MapGen)
let ASCII_MAP = DEFAULT_ASCII_MAP.slice();

    window.DEBUG_SPAWN_FALLBACKS = window.DEBUG_SPAWN_FALLBACKS || [];
    window.DEBUG_MAP_HAS_UNKNOWN_CHARS = false;
    window.DEBUG_ASCII_MAP_TEXT = window.DEBUG_ASCII_MAP_TEXT || null;

    function parseDebugAsciiMap(text){
      if (typeof text !== 'string') return null;
      const rows = [];
      const lines = text.split(/\r?\n/);
      for (const rawLine of lines) {
        const trimmed = rawLine.trim();
        if (!trimmed) continue;           // vacío
        if (trimmed.startsWith('#')) continue; // comentario
        rows.push(rawLine);
      }
      return rows.length ? rows : null;
    }

    function validateDebugAsciiRows(rows){
      window.DEBUG_MAP_HAS_UNKNOWN_CHARS = false;
      if (!Array.isArray(rows)) return false;
      const legend = window.AsciiLegend || {};
      let hasUnknown = false;
      for (let y = 0; y < rows.length; y++) {
        const line = String(rows[y] ?? '');
        for (let x = 0; x < line.length; x++) {
          const ch = line[x];
          if (!legend[ch]) {
            hasUnknown = true;
            window.DEBUG_MAP_HAS_UNKNOWN_CHARS = true;
            try {
              console.warn('[MAP_DEBUG] Carácter no reconocido en debug-map.txt', { char: ch, x, y });
            } catch (_) {}
          }
        }
      }
      return hasUnknown;
    }

    function registerSpawnFallback(info){
      if (!info) return;
      if (!window.DEBUG_SPAWN_FALLBACKS) window.DEBUG_SPAWN_FALLBACKS = [];
      const entry = { ...info };
      if (Array.isArray(entry.world)) {
        entry.world = { x: entry.world[0], y: entry.world[1] };
      }
      window.DEBUG_SPAWN_FALLBACKS.push(entry);
    }

    async function tryLoadDebugMapText(){
      if (typeof fetch !== 'function') return null;
      if (typeof window.DEBUG_ASCII_MAP_TEXT === 'string' && window.DEBUG_ASCII_MAP_TEXT.length) {
        return window.DEBUG_ASCII_MAP_TEXT;
      }
      try {
        const res = await fetch('assets/config/debug-map.txt');
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const txt = await res.text();
        window.DEBUG_ASCII_MAP_TEXT = txt;
        return txt;
      } catch (err) {
        try {
          console.warn('[MAP_DEBUG] No se pudo cargar assets/config/debug-map.txt, se usará DEFAULT_ASCII_MAP interno');
        } catch (_) {}
        return null;
      }
    }

  // ------------------------------------------------------------
  // Creación de entidades
  // ------------------------------------------------------------
  // === Defaults de física por tipo (fallback si el spawn no los pasa) ===
  const PHYS_DEFAULTS = {};
  PHYS_DEFAULTS[ENT.PLAYER]   = { mass: 1.00, rest: 0.10, mu: 0.12 };
  PHYS_DEFAULTS[ENT.MOSQUITO] = { mass: 0.08, rest: 0.05, mu: 0.12 };
  PHYS_DEFAULTS[ENT.RAT]      = { mass: 0.12, rest: 0.08, mu: 0.12 };
  PHYS_DEFAULTS[ENT.CART]     = { mass: 6.00, rest: 0.65, mu: 0.06 };
  PHYS_DEFAULTS[ENT.BED]      = { mass: 4.00, rest: 0.25, mu: 0.08 };
  PHYS_DEFAULTS[ENT.PATIENT]  = { mass: 1.00, rest: 0.10, mu: 0.12 };
  PHYS_DEFAULTS[ENT.BOSS]     = { mass: 8.00, rest: 0.20, mu: 0.10 };
  PHYS_DEFAULTS[ENT.DOOR]     = { mass: 0.00, rest: 0.00, mu: 0.00 }; // estática

  function toWorld(tx, ty) {
      const TILE = window.TILE_SIZE || 32;
      return {
          x: tx * TILE + TILE * 0.5,
          y: ty * TILE + TILE * 0.5
      };
  }

  function makeRect(
    x, y, w, h,
    kind, color,
    pushable = false, solid = false,
    opts = {}
  ){
    const e = {
      x, y, w, h, kind, color,
      pushable, solid,
      vx: 0, vy: 0,
      bouncy: false,
      static: !!opts.static
    };
    // Física base por tipo (fallback)…
    const def = {
      mass: (typeof massFor === 'function') ? massFor(kind) : 1,
      rest: (typeof restitutionFor === 'function') ? restitutionFor(kind) : 0.1,
      mu:   (typeof frictionFor === 'function') ? frictionFor(kind) : 0.12,
    };
    // …pero **deja que el spawn lo sobreescriba**
    e.mass = (opts.mass ?? def.mass);
    e.rest = (opts.rest ?? def.rest);
    e.mu   = (opts.mu   ?? def.mu);
    e.invMass = e.mass > 0 ? 1 / e.mass : 0;
    return e;
  }

  function makePlayer(x, y) {
    // Lee la selección (si no la hay, cae en 'enrique')
    const key =
      (window.selectedHeroKey) ||
      ((window.G && G.selectedHero) ? G.selectedHero : null) ||
      'enrique';

    // Camino correcto: usa la API de héroes (aplica corazones y stats)
    if (window.Entities?.Hero?.spawnPlayer) {
      const p = window.Entities.Hero.spawnPlayer(x, y, { skin: key });
      // 🛡️ Defaults “sanos” si la skin no los define:
      p.mass     = (p.mass     != null) ? p.mass     : 1.00;
      p.rest     = (p.rest     != null) ? p.rest     : 0.10;
      p.mu       = (p.mu       != null) ? p.mu       : 0.12;
      p.maxSpeed = (p.maxSpeed != null) ? p.maxSpeed : (BALANCE.physics.maxSpeedPlayer || 165);
      p.accel    = (p.accel    != null) ? p.accel    : 800;
      p.pushForce= (p.pushForce!= null) ? p.pushForce: FORCE_PLAYER;
      p.facing   = p.facing || 'S';

      // === Giro más sensible por defecto ===
      p.turnSpeed = (p.turnSpeed != null) ? p.turnSpeed : 4.5;
      p.lookAngle = (typeof p.lookAngle === 'number')
        ? p.lookAngle
        : (p.facing === 'E' ? 0 :
           p.facing === 'S' ? Math.PI/2 :
           p.facing === 'W' ? Math.PI : -Math.PI/2);

      G.player = p;
      return p;
    }

    // Fallback de emergencia (por si faltara la API)
    const p = makeRect(x, y, TILE * 0.8, TILE * 0.8, ENT.PLAYER, COLORS.player, false);
    p.speed = 4.0;
    p.pushForce = FORCE_PLAYER;
    p.invuln = 0;
    p.facing = 'S';
    p.pushAnimT = 0;
    p.skin = key;

    // === Giro más sensible por defecto ===
    p.turnSpeed = 4.5;
    p.lookAngle = Math.PI / 2; // SUR
    // Asegura corazones mínimos si no hay API
    p.hp = p.hp || 3;
    p.hpMax = p.hpMax || 3;
    return p;
  }
  // --------- Spawn de mosquito (enemigo básico) ----------
  function spawnMosquito(x, y) {
    const e = makeRect(
      x - TILE*0.3, y - TILE*0.3,
      TILE*0.6, TILE*0.6,
      ENT.MOSQUITO, COLORS.mosquito,
      false,     // pushable
      true,      // sólido
      { mass: 0.08, rest: 0.05, mu: 0.12 }
    );
    e.t = 0; e.vx = 0; e.vy = 0;
    e.bouncy = false;
    e.static = false;
    G.entities.push(e);
    G.enemies.push(e);
    return e;
    if (window.Physics && typeof Physics.registerEntity === 'function') Physics.registerEntity(e);
  }

  async function loadLevelWithMapGen(level=1) {
    if (!window.MapGen) return false;            // fallback al ASCII si no está el plugin

    // Tamaños por nivel (ajústalos si quieres)
    const dims = (level===1) ? {w:60,h:40}
                : (level===2) ? {w:120,h:80}
                :               {w:180,h:120};

    // Limpieza de estado como haces al cargar ASCII
    G.entities = []; G.movers = []; G.enemies = []; G.npcs = [];
    G.patients = []; G.pills = []; G.map = []; G.mapW = dims.w; G.mapH = dims.h;
    G.player = null; G.cart = null; G.door = null; G.boss = null;

    MapGen.init(G);                               // vincula el estado del juego
    const res = await MapGen.generate({
      w: dims.w, h: dims.h, level,
      seed: Date.now(),                           // o un seed fijo si quieres reproducible
      place: true,                                // que coloque entidades vía callbacks
      callbacks: {
        placePlayer: (tx,ty) => {
          const key = (window.selectedHeroKey || (window.G && G.selectedHero) || null);
          const p =
            (window.Entities?.Hero?.spawnPlayer?.(tx*TILE+4, ty*TILE+4, { skin: key })) ||
            makePlayer(tx*TILE+4, ty*TILE+4);
          G.player = p;
          if (!G.entities.includes(p)) G.entities.push(p);
        },
        placeDoor: (tx,ty,opts={})=>{
          const e = makeRect(tx*TILE+6, ty*TILE+4, TILE, TILE,
                            ENT.DOOR, COLORS.doorClosed, false, true,
                            {mass:0, rest:0, mu:0, static:true});
          G.entities.push(e); G.door = e;
        },
        placeBoss: (kind,tx,ty)=>{
          const b = makeRect(tx*TILE+8, ty*TILE+8, TILE*1.2, TILE*1.2,
                            ENT.BOSS, COLORS.boss, false, true,
                            {mass:8, rest:0.1, mu:0.1, static:true});
          G.entities.push(b); G.boss = b;
        },
        placeEnemy: (kind,tx,ty)=>{
          if (kind==='mosquito') spawnMosquito(tx*TILE+TILE/2, ty*TILE+TILE/2);
          // añade aquí más tipos si MapGen los emite (ratas, etc.)
        },
        placeSpawner: (kind,tx,ty)=>{
          // si usas spawners, guarda sus coords para tus sistemas
          if (kind==='mosquito') G.mosquitoSpawn = {x:tx*TILE+TILE/2, y:ty*TILE+TILE/2, t:0, n:0};
        },
        placeNPC: (kind,tx,ty)=>{ /* según tus factories existentes */ },
        placeElevator: (tx,ty)=>{ /* si tienes elevators.plugin */ },
        placePatient: (tx,ty,opts)=>{ /* makePatient + timbre si lo usas aquí */ },
        placeBell: (tx,ty)=>{ /* crear timbre suelto */ }
      }
    });

    // Establece el mapa sólido para colisiones
    G.map   = res.map;             // matriz 0/1
    G.mapW  = res.width;
    G.mapH  = res.height;

    return true;
  }



// -------------------------------------------------------------------------------------------
// Función NUCLEO - Parseo mapa + colocación base (may/min OK, sin duplicar con placements)
// -------------------------------------------------------------------------------------------

 // === Parser ASCII → grid de colisiones (sin instanciar entidades) ===

  // Tinte de suelo por tipo de sala (control/boss/miniboss/normal).
  // Nota: reforzamos el color base y añadimos una segunda pasada "screen" para que
  // los suelos especiales destaquen incluso bajo la viñeta de luz/niebla.
  const FLOOR_SHADES = {
    control: { base: 'rgba(64, 140, 255, 0.58)', overlay: 'rgba(90, 175, 255, 0.42)', overlayMode: 'screen', tileAlpha: 0.8 },
    boss: { base: 'rgba(235, 72, 72, 0.60)', overlay: 'rgba(255, 125, 110, 0.42)', overlayMode: 'screen', tileAlpha: 0.82 },
    miniboss: { base: 'rgba(74, 200, 132, 0.56)', overlay: 'rgba(124, 255, 184, 0.40)', overlayMode: 'screen', tileAlpha: 0.8 },
    normal: { base: 'rgba(214, 214, 214, 0.08)', overlay: null, overlayMode: 'source-over', tileAlpha: 1 }
  };

  function normalizeRoomType(room, fallback){
    const t = typeof room === 'string' ? room : room?.type;
    const key = (t || fallback || '').toLowerCase();
    if (!key) return null;
    if (key === 'mini-boss' || key === 'mini_boss') return 'miniboss';
    if (key === 'boss' || key === 'miniboss' || key === 'control' || key === 'normal') return key;
    return fallback || 'normal';
  }

  function buildRoomTypeGrid(areas, width, height){
    if (!areas || !width || !height) return null;
    const grid = Array.from({ length: height }, () => Array(width).fill(null));
    const applyRoom = (room, fallbackType) => {
      if (!room || typeof room.x !== 'number' || typeof room.y !== 'number') return;
      const type = normalizeRoomType(room, fallbackType);
      if (!type) return;
      const rx = Math.max(0, room.x | 0);
      const ry = Math.max(0, room.y | 0);
      const rw = Math.max(1, room.w | 0);
      const rh = Math.max(1, room.h | 0);
      for (let y = ry; y < Math.min(height, ry + rh); y++) {
        const row = grid[y];
        for (let x = rx; x < Math.min(width, rx + rw); x++) {
          row[x] = type;
        }
      }
    };

    const rooms = Array.isArray(areas.rooms) ? areas.rooms : [];
    for (const r of rooms) applyRoom(r, r?.type);
    applyRoom(areas.control, 'control');
    applyRoom(areas.boss, 'boss');
    applyRoom(areas.miniboss, 'miniboss');

    return grid;
  }

  function getFloorShadeForRoomType(roomType){
    const key = (roomType || '').toLowerCase();
    if (!key) return null;
    switch (key) {
      case 'control': return FLOOR_SHADES.control;
      case 'boss': return FLOOR_SHADES.boss;
      case 'miniboss': return FLOOR_SHADES.miniboss;
      case 'normal': return FLOOR_SHADES.normal;
      default: return FLOOR_SHADES.normal;
    }
  }

  function normalizeFloorVisual(visual, fallbackColor){
    if (!visual && !fallbackColor) return null;
    if (visual && typeof visual === 'object') {
      return { ...visual, base: visual.base || fallbackColor || null };
    }
    return { base: visual || fallbackColor || null, overlay: null, overlayMode: 'source-over', tileAlpha: visual ? 0.82 : 1 };
  }


  function parseMap(lines){
    // === Reset de listas (como la antigua, estable) ===
    G.entities.length = 0;
    G.movers.length = 0;
    G.enemies.length = 0;
    G.patients.length = 0;
    G.pills.length = 0;
    G.npcs.length = 0;
    G.lights.length = 0;
    G.roomLights.length = 0;

    // === Constantes / fallback ===
    // Importante: NO redefinimos el TILE del motor aquí (evita la TDZ).
    // Usamos el valor global expuesto por el motor: window.TILE_SIZE (o window.TILE como compat),
    // y como último recurso 32.
    const TILE = (typeof window !== 'undefined' && (window.TILE_SIZE || window.TILE)) || 32;

    const legendApi = window.AsciiLegendAPI || window.PlacementAPI || {};
    const getAsciiDef = legendApi.getDefFromChar || legendApi.getDef || ((ch, opts) => {
      const def = (window.AsciiLegend && window.AsciiLegend[ch]) || null;
      if (!def && opts?.log !== false) {
        try { console.warn('[ASCII] Unknown char in map:', JSON.stringify(ch), opts?.context || 'parseMap'); } catch (_) {}
      }
      return def;
    });

    let roomTypeGrid = null;

    const ENTITY_FACTORIES = {
      hero_spawn(tx, ty) {
        const wx = tx * TILE;
        const wy = ty * TILE;
        const p = (typeof makePlayer === 'function')
          ? makePlayer(wx + 4, wy + 4)
          : (window.Entities?.Hero?.spawnPlayer?.(wx + 4, wy + 4, {}) || null);
        if (p) {
          G.player = p;
          G.safeRect = { x: wx - 2 * TILE, y: wy - 2 * TILE, w: 5 * TILE, h: 5 * TILE };
          G.roomLights.push({ x: (p.x || wx) + TILE / 2, y: (p.y || wy) + TILE / 2, r: 5.5 * TILE, baseA: 0.28 });
        }
        return p;
      }
    };

    const spawnFromKind = (def, tx, ty, ch) => {
      if (!def) return null;

      const TILE = (typeof window !== 'undefined' && (window.TILE_SIZE || window.TILE)) || 32;
      const wx = tx * TILE;
      const wy = ty * TILE;

      const factory = ENTITY_FACTORIES[def.kind] || ENTITY_FACTORIES[def.factoryKey];
      // Las factories internas ya trabajan en tiles, así que les pasamos tx/ty
      if (typeof factory === 'function') return factory(tx, ty, def);

      // El resto de entidades (PlacementAPI) lo hacemos en coordenadas de mundo
      if (window.PlacementAPI?.spawnFromAscii) {
        return window.PlacementAPI.spawnFromAscii(def, wx, wy, {
          G,
          map: G.map,
          char: ch,
          tx,
          ty
        });
      }
      return null;
    };

    const addEntity = (entity) => {
      if (!entity) return;
      if (!Array.isArray(G.entities)) G.entities = [];
      if (!G.entities.includes(entity)) G.entities.push(entity);
      if (!entity.static && (entity.dynamic || entity.pushable || entity.vx || entity.vy)) {
        if (!G.movers.includes(entity)) G.movers.push(entity);
      }
    };

    // === Validación mínima de entrada ===
    if (!Array.isArray(lines) || !lines.length){
      G.mapH = 1; G.mapW = 1;
      G.map = [[0]];
      G.floorColors = [[null]];
      // No colocamos nada más para no romper.
      return;
    }

    // === Tamaño y buffer de mapa ===
    G.mapH = lines.length;
    G.mapW = lines[0].length;
    roomTypeGrid = buildRoomTypeGrid(G.mapAreas, G.mapW, G.mapH);
    G.map = [];
    G.floorColors = [];

    // Recogeremos aquí los placements derivados del ASCII (en píxeles)
    const asciiPlacements = [];
    // Guarda referencia global para applyPlacementsFromMapgen
    G.__asciiPlacements = asciiPlacements;

    for (let y = 0; y < G.mapH; y++){
      const row = [];
      const colorRow = [];
      const line = lines[y] || '';
      for (let x = 0; x < G.mapW; x++){
        const ch = line[x] || ' ';
        const def = getAsciiDef(ch, { context: 'parseMap' });
        const blocking = def?.blocking === true || ch === '#';
        row.push(blocking ? 1 : 0);
        const roomType = roomTypeGrid ? roomTypeGrid[y]?.[x] : null;
        // Color del suelo según la sala a la que pertenece el tile (MapGen: control/boss/miniboss/normal).
        const visual = normalizeFloorVisual(getFloorShadeForRoomType(roomType), def?.color);
        colorRow.push(visual);

        if (!def) continue;
        if (def.kind === 'wall' || def.kind === 'void') continue;
        if (def.baseKind === 'floor' || def.kind === 'floor') continue;

        const entity = spawnFromKind(def, x, y, ch);
        if (entity) {
          addEntity(entity);
          if (!G.player && def.kind === 'hero_spawn') {
            G.player = entity;
          }
        } else if (def.isSpawn) {

            const entity = spawnFromKind(def, x, y, ch);
            if (!entity) {
              const wx = x * TILE;
              const wy = y * TILE;

              asciiPlacements.push({
                type: def.kind,
                x: wx + TILE * 0.5,   // centro del tile; ajusta si quieres +4 como antes
                y: wy + TILE * 0.5,
                _units: 'px',
                tx: x,
                ty: y,
                char: ch
              });
            }
          }
      }
      G.map.push(row);
      G.floorColors.push(colorRow);
    }

    // Mezclamos con placements del generador (si ya existían)
    // ========== DEBUG ASCII (mini) ==========
    try {
      // Guardar placements para usarlos en startGame cuando se autorice
      window.G = window.G || {};
      G.__asciiPlacements = asciiPlacements;
      // Señala que se está usando ASCII pero NO instanciamos aquí
      G.flags = G.flags || {};
      G.flags.DEBUG_FORCE_ASCII = true;
      G.usedMapASCII = true;

      // limpiar autorización
      G.__allowASCIIPlacements = false; delete G.__allowASCIIPlacements;
    } catch(_){}
    // =======================================

    // Fallback por si el mapa no trae 'S' (igual que la antigua)
    if (!G.player) {
      const p = (typeof makePlayer === 'function')
        ? makePlayer(TILE*2, TILE*2)
        : (window.Entities?.Hero?.spawnPlayer?.(TILE*2, TILE*2, {}) || null);
      if (p){ G.player = p; G.entities.push(p); }
    }
  }






///////////////////////////////////////////////////////////////////////////








  function initSpawnersForLevel(){
    G.spawners = [];
    if (G.mosquitoSpawn){
      G.spawners.push({
        kind: 'mosquito',
        x: G.mosquitoSpawn.x,
        y: G.mosquitoSpawn.y,
        cooldown: rngRange(
          BALANCE.enemies.mosquito.respawnDelayMin,
          BALANCE.enemies.mosquito.respawnDelayMax
        ),
        t: 0
      });
      // 1º mosquito inicial del nivel (solo uno)
      spawnMosquito(G.mosquitoSpawn.x, G.mosquitoSpawn.y);
    }
  }

  // ------------------------------------------------------------
  // Collisiones por tiles
  // ------------------------------------------------------------
  function inBoundsTile(tx, ty){
    const w = G?.mapW | 0;
    const h = G?.mapH | 0;
    return tx >= 0 && ty >= 0 && tx < w && ty < h;
  }
  function tileAt(tx, ty){
    if (!inBoundsTile(tx, ty)) return 1;
    const row = G?.map?.[ty];
    return Array.isArray(row) ? (row[tx] | 0) : 1;
  }
  function isWallAt(px, py, w, h){
    const T = window.TILE_SIZE || TILE;
    const tx = Math.floor(px / T);
    const ty = Math.floor(py / T);
    if (!G || !G.map || !inBoundsTile(tx, ty)) return true;
    return tileAt(tx, ty) === 1;
  }
  window.isWallAt = isWallAt; // contrato

  // === Física: tablas por entidad ===
  function massFor(kind){
    switch(kind){
      case ENT.PLAYER:    return 1.0;
      case ENT.MOSQUITO:  return 0.08; // muy ligero -> no empuja al héroe
      case ENT.RAT:       return 0.12;
      case ENT.CART:      return 6.0;  // carro pesado
      case ENT.BED:       return 4.0;
      case ENT.PATIENT:   return 1.0;
      case ENT.BOSS:      return 8.0;
      default:            return 1.0;
    }
  }
  function restitutionFor(kind){
    switch(kind){
      case ENT.CART:      return 0.35; // rebote “billar” suave
      case ENT.BED:       return 0.25;
      case ENT.MOSQUITO:  return 0.05;
      default:            return 0.10;
    }
  }
  function frictionFor(kind){
    // coeficiente “mu” (0..1) -> lo transformamos a factor más abajo
    switch(kind){
      case ENT.CART:      return 0.06;
      case ENT.BED:       return 0.08;
      default:            return 0.12;
    }
  }

  // ------------------------------------------------------------
  // Física con subpasos y empuje “Rompers”
  // ------------------------------------------------------------
  


  // Enrutadores de compatibilidad: mismas firmas, pero delegan en el plugin
  const moveWithCollisions   = (e, dt) => Physics.moveWithCollisions(e, dt);
  const resolveAgainstSolids = (e)     => Physics.resolveAgainstSolids(e);
  const resolveEntityPairs   = (dt)    => Physics.resolveEntityPairs(dt);
  const snapInsideMap        = (e)     => Physics.snapInsideMap(e);

  // (opcional) expón también en window por si algún script viejo los mira ahí
  window.moveWithCollisions   = moveWithCollisions;
  window.resolveAgainstSolids = resolveAgainstSolids;
  window.resolveEntityPairs   = resolveEntityPairs;
  window.snapInsideMap        = snapInsideMap;

  function AABB(a,b){ return a.x < b.x+b.w && a.x+a.w > b.x && a.y < b.y+b.h && a.y+a.h > b.y; }
  // Toca/roza con margen (sirve para "contacto" aunque la física los separe)
  // IDs simples para vincular pill → patient
  let NEXT_ID = 1;
  const uid = () => NEXT_ID++;

  // "Contacto" con margen (sirve para entregar sin tener que solaparse)
  function nearAABB(a, b, m = 10) {
    return (
      a.x < b.x + b.w + m &&
      a.x + a.w > b.x - m &&
      a.y < b.y + b.h + m &&
      a.y + a.h > b.y - m
    );
  }
  window.AABB = AABB;
  
  function killEnemy(e, meta){
      if (e.dead) return;
      e.dead = true;
      if (window.ScoreAPI){ try{ ScoreAPI.awardForDeath(e, Object.assign({cause:'killEnemy'}, meta||{})); }catch(_){} }
    // saca de las listas
    G.enemies = G.enemies.filter(x => x !== e);
    G.entities = G.entities.filter(x => x !== e);
    // notificar respawn diferido
    SPAWN.pending = Math.min(SPAWN.pending + 1, SPAWN.max);
    // Planificar respawn si hay spawner de este tipo
    if (e.kind === ENT.MOSQUITO && Array.isArray(G.spawners)){
      const s = G.spawners.find(s => s.kind === 'mosquito');
      if (s) { s.t = s.cooldown; }  // arranca cooldown
    }
  }

  function killEntityGeneric(e, meta){
    if (!e || e.dead) return;
    e.dead = true;
    if (window.ScoreAPI){ try{ ScoreAPI.awardForDeath(e, Object.assign({cause:'killEntityGeneric'}, meta||{})); }catch(_){} }

    // quítalo de todas las listas donde pueda estar
    G.entities = G.entities.filter(x => x !== e);
    G.movers   = G.movers.filter(x => x !== e);
    G.enemies  = G.enemies.filter(x => x !== e);
    G.npcs     = G.npcs.filter(x => x !== e);
    G.patients = G.patients.filter(x => x !== e);

    // si era enemigo “con vida”, respawn por su sistema
    if (e.kind === ENT.MOSQUITO) {
      SPAWN.pending = Math.min(SPAWN.pending + 1, SPAWN.max);
    }
  }

  // Cualquier enemigo o NPC que toque un CARRO en movimiento muere instantáneo.
  // Al jugador le hace daño según velocidad; puertas/estáticos no mueren.
  function cartImpactDamage(a, b){
    const cart = (a.kind === ENT.CART) ? a : (b.kind === ENT.CART ? b : null);
    if (!cart) return;

    const other = (cart === a) ? b : a;

    // velocidad del carro y relativa
    const spdC  = Math.hypot(cart.vx || 0, cart.vy || 0);
    const rel   = Math.hypot((cart.vx||0)-(other.vx||0), (cart.vy||0)-(other.vy||0));
    const nearWall = isWallAt(other.x-1, other.y-1, other.w+2, other.h+2);

    // umbrales
    const MIN_ENEMY_KILL_SPEED  = 6;   // “mínimo”: toca y muere
    const MIN_PLAYER_HURT_SPEED = 22;  // héroe no sufre si el carro casi parado

    // parado de verdad -> NO hace nada
    if (spdC <= 0.01 && rel <= 0.01 && !nearWall) return;

    // HÉROE: daño progresivo según velocidad
    if (other.kind === ENT.PLAYER){
      if (spdC > MIN_PLAYER_HURT_SPEED || rel > MIN_PLAYER_HURT_SPEED){
        if (rel > 360) { damagePlayer(cart, 6); return; } // golpe brutal
        if (rel > 240) { damagePlayer(cart, 2); return; } // fuerte
        if (rel > 120) { damagePlayer(cart, 1); return; } // leve
      }
      return;
    }

    // estáticos que NO se matan
    if (other.kind === ENT.DOOR || other.static) return;

    // ENEMIGOS / NPC: con movimiento mínimo o arrinconados -> MUEREN SIEMPRE
    if (spdC > MIN_ENEMY_KILL_SPEED || rel > MIN_ENEMY_KILL_SPEED || nearWall){
    const meta = {
      via:'cart',
      impactSpeed: Math.max(spdC, rel),
      killerTag: (cart._lastPushedBy || null),
      killerId:  (cart._lastPushedId || null),
      killerRef: (cart._pushedByEnt || cart._grabbedBy || null)
    };
    if (other.kind === ENT.MOSQUITO) killEnemy(other, meta);
    else                             killEntityGeneric(other, meta);
    }
  }

  function resolveOverlapPush(e, o){
    // separa a 'e' del sólido 'o' por el eje de mínima penetración
    const ax1 = e.x, ay1 = e.y, ax2 = e.x + e.w, ay2 = e.y + e.h;
    const bx1 = o.x, by1 = o.y, bx2 = o.x + o.w, by2 = o.y + o.h;
    const overlapX = (ax2 - bx1 < bx2 - ax1) ? ax2 - bx1 : -(bx2 - ax1);
    const overlapY = (ay2 - by1 < by2 - ay1) ? ay2 - by1 : -(by2 - ay1);

    if (Math.abs(overlapX) < Math.abs(overlapY)){
      e.x -= overlapX;
      if (e.pushable && o.pushable){ // choque entre objetos empujables
        const tmp = e.vx; e.vx = o.vx; o.vx = tmp;
      } else {
        e.vx = 0;
      }
    } else {
      e.y -= overlapY;
      if (e.pushable && o.pushable){
        const tmp = e.vy; e.vy = o.vy; o.vy = tmp;
      } else {
        e.vy = 0;
      }
    }
  }

  function clampOutOfWalls(e){
    // pequeño empujón hacia atrás si quedó tocando pared
    let tries = 8;
    while (tries-- > 0 && isWallAt(e.x, e.y, e.w, e.h)) {
      if (Math.abs(e.vx) > Math.abs(e.vy)) {
        e.x -= Math.sign(e.vx || 1) * 0.5;
      } else {
        e.y -= Math.sign(e.vy || 1) * 0.5;
      }
    }
  }

  // ------------------------------------------------------------
  // Input + empuje
  // ------------------------------------------------------------
  function softFacingFromKeys(p, dx, dy, dt){
    if (!dx && !dy) return;
    const want = Math.atan2(dy, dx);
    if (!isFinite(want)) return;

    const cur = (p.lookAngle ?? want);
    const maxTurn = (p.turnSpeed || 4.5) * dt;

    let diff = ((want - cur + Math.PI) % (2*Math.PI));
    if (diff > Math.PI) diff -= 2*Math.PI;

    const heavy = Math.abs(diff) > 2.7 ? 1.75 : 1.0; // turbo ~180º
    const step = Math.max(-maxTurn*heavy, Math.min(maxTurn*heavy, diff));
    p.lookAngle = cur + step;

    p._facingHold = Math.max(0, (p._facingHold || 0) - dt);
    if (p._facingHold <= 0){
      const ang = p.lookAngle;
      const deg = ang * 180/Math.PI;
      const newCard =
        (deg > -45 && deg <= 45)   ? 'E' :
        (deg > 45  && deg <= 135)  ? 'S' :
        (deg <= -45 && deg > -135) ? 'N' : 'W';
      if (newCard !== p.facing){ p.facing = newCard; p._facingHold = 0.08; }
    }
  }
  
  function handleInput(dt) {
    const p = G.player;
    if (!p) return;

    const R = !!keys['arrowright'], L = !!keys['arrowleft'];
    const D = !!keys['arrowdown'],  U = !!keys['arrowup'];
    let dx = (R ? 1 : 0) - (L ? 1 : 0);
    let dy = (D ? 1 : 0) - (U ? 1 : 0);

    if (window.DEBUG_FORCE_ASCII) {
      // log discreto solo en debug
      //console.log('[INPUT] arrows', {U,D,L,R, dx, dy});
    }

    if (dx && dy) { dx *= 0.7071; dy *= 0.7071; }

    // ROTACIÓN SUAVE DEL CONO (teclado)
    softFacingFromKeys(p, dx, dy, dt);

    // === NUEVO: aceleración y tope de velocidad ===
    const accel = (p.accel != null) ? p.accel
                : (p.speed != null) ? p.speed * 60    // compat viejo
                : 800;                                  // fallback seguro
    const maxSp = (p.maxSpeed != null) ? p.maxSpeed
                : (BALANCE?.physics?.maxSpeedPlayer ?? 165);

    // aplicar aceleración por dt
    p.vx += dx * accel * dt;
    p.vy += dy * accel * dt;

    // limitar velocidad máxima del jugador
    const sp = Math.hypot(p.vx || 0, p.vy || 0);
    if (sp > maxSp) { const s = maxSp / sp; p.vx *= s; p.vy *= s; }

    // --- Anti-atascos en pasillos 1-tile (centrado suave como MouseNav) ---
    (function antiStuckCorridor(){
      const t = TILE; // 32 px
      const pcx = p.x + p.w*0.5, pcy = p.y + p.h*0.5;
      const ptx = (pcx/t)|0, pty = (pcy/t)|0;
      const W = G.mapW, H = G.mapH;
      const isWalk = (x,y)=> x>=0 && y>=0 && x<W && y<H && G.map[y][x]===0;

      // si nos movemos mayormente en X y hay paredes arriba/abajo -> recentra en Y
      if (Math.abs(dx) > Math.abs(dy) && !isWalk(ptx,pty-1) && !isWalk(ptx,pty+1)){
        const cy = pty*t + t*0.5;           // centro del tile en Y
        p.vy += (cy - pcy) * 6.5 * dt;      // fuerza suave hacia el centro
      }
      // si nos movemos mayormente en Y y hay paredes izquierda/derecha -> recentra en X
      if (Math.abs(dy) > Math.abs(dx) && !isWalk(ptx-1,pty) && !isWalk(ptx+1,pty)){
        const cx = ptx*t + t*0.5;           // centro del tile en X
        p.vx += (cx - pcx) * 6.5 * dt;
      }
    })();

    if (dx || dy) G.lastPushDir = { x: Math.sign(dx || 0), y: Math.sign(dy || 0) };
  }

  function doAction() {
    const p = G.player;
    if (!p) return;

    // 1 segundo de anim de empuje
    p.pushAnimT = 1;

    // Dirección desde el facing actual
    const dir = facingDir(p.facing);
    const hit = findPushableInFront(p, dir);
    if (hit) {
      // 1) Desatasco preventivo: si está tocando muro, sácalo o colócalo en un punto libre cercano
      try { if (window.Physics?.snapInsideMap) Physics.snapInsideMap(hit); } catch(_){}
      if (typeof isWallAt === 'function' && isWallAt(hit.x, hit.y, hit.w, hit.h)) {
        // pequeño “paso atrás” de 2px alejándolo del muro antes del empuje
        hit.x -= dir.x * 2;
        hit.y -= dir.y * 2;
      }

      // 2) Empuje normal
      const F = (p.pushForce ?? p.push ?? FORCE_PLAYER);
      const scale = 1 / Math.max(1, (hit.mass || 1) * 0.5); // objetos muy pesados salen menos
      hit.vx += dir.x * F * scale;
      hit.vy += dir.y * F * scale;

      // 3) Marca de autor del empuje (para atribuir kills)
      hit._lastPushedBy   = (p.tag==='follower' ? 'HERO' : 'PLAYER');
      hit._lastPushedId   = p.id || p._nid || p._uid || 'player1';
      hit._pushedByEnt    = p;                // referencia útil si la necesitas
      hit._lastPushedTime = performance.now();
    }
  }

  function damagePlayer(src, amount=1){
    const p = G.player;
    const isRatHit = !!src && (src.kind === ENT.RAT || src.kindName === 'rat');
    const hearts = Math.max(0, (amount | 0) * 0.5);
    const source = (src && (src.kindName || src.kind)) || 'damage';
    const meta = {
      attacker: src,
      source,
      knockbackFrom: src,
      x: src?.x,
      y: src?.y,
      invuln: isRatHit ? 0.5 : 1.0
    };
    if (window.Damage?.applyToHero?.(hearts, source, meta)) return;
    if (!p) return;
    if (!isRatHit && p.invuln > 0) return;
    const halvesBefore = Math.max(0, ((G.player?.hp|0) * 2));
    const halvesAfter  = Math.max(0, halvesBefore - (amount|0));
    G.player.hp = Math.ceil(halvesAfter / 2);
    G.health     = halvesAfter;
    p.invuln = (isRatHit ? 0.50 : 1.0); // mordisco de rata: 0,5 s; resto: 1 s

    // knockback desde 'src' hacia fuera
    if (src){
      const dx = (p.x + p.w/2) - (src.x + src.w/2);
      const dy = (p.y + p.h/2) - (src.y + src.h/2);
      const n = Math.hypot(dx,dy) || 1;
      p.vx += (dx/n) * 160;
      p.vy += (dy/n) * 160;
    }

    if (G.health <= 0){
      G.state = 'GAMEOVER';
      gameOverScreen.classList.remove('hidden');
      // Muestra la viñeta animada "GAME OVER" (debajo o encima según zIndex)
      PresentationAPI.gameOver({ mode: 'under' }); // 'under' = deja ver tu texto de "El caos te ha superado"
    }
  }

  function facingDir(f) {
    switch (f) {
      case 'E': return {x: 1, y: 0};
      case 'W': return {x:-1, y: 0};
      case 'S': return {x: 0, y: 1};
      default : return {x: 0, y:-1}; // 'N'
    }
  }

  function findPushableInFront(p, dir) {
    // AABB delante del jugador
    const range = 18;
    const rx = p.x + p.w/2 + dir.x * (p.w/2 + 2);
    const ry = p.y + p.h/2 + dir.y * (p.h/2 + 2);
    const box = { x: rx - (dir.x ? range/2 : p.w/2),
                  y: ry - (dir.y ? range/2 : p.h/2),
                  w: dir.x ? range : p.w,
                  h: dir.y ? range : p.h };

    for (const e of G.movers) {
      if (!e.dead && e.pushable && AABB(box, e)) return e;
    }
    return null;
  }

  // Actualiza TODAS las entidades del juego: enemigos, NPC, carros, puertas, ascensores, etc.
  // - Llama al método update(dt) propio de cada entidad (IA y lógica de contacto).
  // - Gestiona movimiento y colisiones de forma uniforme.
  // - Ejecuta la lógica de respawn desde SpawnerManager (para enemigos, NPC y carros).
  // - Muestra logs de depuración en modo debug (?map=debug).
  // Actualiza TODAS las entidades (IA + física) evitando doble movimiento
function updateEntities(dt){
  const dbg = !!window.DEBUG_FORCE_ASCII;
  // sin lista, no hay nada que hacer
  if (!Array.isArray(G.entities)) return;
  const num = G.entities.length;
  //if (dbg) console.log('[updateEntities] dt:', (dt ?? 0).toFixed(4), 'ents:', num);

  for (const e of G.entities){
    if (!e || e.dead) continue;
    // posición inicial (para detectar saltos bruscos)
    const bx = e.x, by = e.y;

    // 1) IA propia
    if (typeof e.update === 'function'){
      try { e.update(dt); }
      catch(err){
        if (dbg) console.warn('[updateEntities] error update', e.id || e.kindName || e, err);
      }
    }

    // 2) Movimiento y colisiones — lo hace Physics.step(dt). No mover aquí para evitar doble integración.
    // (Dejamos un clamp suave de seguridad sobre la velocidad)
    if (typeof e.vx === 'number' && typeof e.vy === 'number'){
      const LIM = 160;
      e.vx = Math.max(-LIM, Math.min(LIM, e.vx));
      e.vy = Math.max(-LIM, Math.min(LIM, e.vy));
    }

    // 3) Anti‑warp: limita la distancia recorrida en un solo frame
    const dx = e.x - bx, dy = e.y - by;
    const step = Math.hypot(dx, dy);
    // Usa e.maxSpeed si existe, de lo contrario 90 px/s por defecto
    const maxStep = ((typeof e.maxSpeed === 'number' ? e.maxSpeed : 90) * dt * 1.5);
    if (step > maxStep && maxStep > 0){
      const s = maxStep / step;
      e.x = bx + dx * s;
      e.y = by + dy * s;
      if (dbg) console.warn('[updateEntities] CLAMP_WARP', e.id || e.kindName || e.kind, 'step', step.toFixed(3), 'limit', maxStep.toFixed(3));
    }
  }

  // 4) Actualiza spawners (mosquitos, ratas, etc.)
  if (window.SpawnerManager && typeof SpawnerManager.update === 'function'){
    try { SpawnerManager.update(dt); }
    catch(err){ if (dbg) console.warn('[updateEntities] error SpawnerManager.update', err); }
  }
}

  // ------------------------------------------------------------
  // Reglas de juego base (pill→patient→door→boss with cart)
  // ------------------------------------------------------------
  function gameplay(dt){
    // 1) Recoger píldora (ENT.PILL)
    if (!G.carry) {
      for (const e of [...G.entities]) {
        if (e.kind !== ENT.PILL || e.dead) continue;
        if (AABB(G.player, e)) {
          // Vinculada ya en parseMap (targetName o patientName)
          G.carry = { label: e.label, patientName: e.targetName };
          // Quita la píldora del mundo
          G.entities = G.entities.filter(x => x !== e);
          G.movers   = G.movers.filter(x => x !== e);
          break;
        }
      }
    }

    // 2) Entregar al paciente correcto tocándolo (ENT.PATIENT)
    if (G.carry) {
      for (const pac of [...G.patients]) {
        if (pac.dead) continue;
        const esCorrecto = (pac.name === G.carry.patientName);
        if (esCorrecto && nearAABB(G.player, pac, 12)) {
          pac.satisfied = true;
          pac.dead = true;
          pac.solid = false;
          // Elimina paciente del mundo
          G.entities = G.entities.filter(e => e !== pac);
          G.patients = G.patients.filter(e => e !== pac);
          G.npcs     = G.npcs.filter(e => e !== pac);
          // Actualiza HUD
          G.carry = null;
          G.delivered++;
          break;
        }
      }
    }

    // 3) Abrir puerta si ya no quedan pacientes
    if (G.door && G.patients.length === 0) {
      G.door.color = COLORS.doorOpen;
      G.door.solid = false;
    }

    // 4) Victoria: carro de urgencias cerca del boss con puerta abierta
    if (G.door && G.door.color===COLORS.doorOpen && G.cart && G.boss){
      const d = Math.hypot(G.cart.x-G.boss.x, G.cart.y-G.boss.y);
      if (d < TILE*2.2){
        G.state = 'COMPLETE';
        levelCompleteScreen.classList.remove('hidden');

        // Desglose + total (animado estilo Metal Slug) y botón "Ir al siguiente turno"
        const breakdown = buildLevelBreakdown();
        const total = (window.ScoreAPI && typeof ScoreAPI.getTotals === 'function')
          ? (ScoreAPI.getTotals().total || 0)
          : breakdown.reduce((a, r) => a + (r.points|0), 0);

        // Muestra la tarjeta "¡Nivel X completado!" con lista animada y botón
        PresentationAPI.levelComplete((window.G?.level || 1), { breakdown, total }, () => {
          // <<<< AQUÍ LO QUE YA USABAS PARA PASAR DE NIVEL >>>>
          // Si ya tienes una función nextLevel(), úsala:
          if (typeof nextLevel === 'function') { nextLevel(); return; }
          // Fallback sencillito: reinicia el turno actual
          if (typeof startGame === 'function') { startGame(); }
        });

        PresentationAPI.levelComplete(G.level || 1, { breakdown, total }, () => {
          // pasa al siguiente nivel
          nextLevel(); // o GameFlowAPI.nextLevel() si lo usas
        });
      }
    }
  }

    // === Flashlights (héroe + NPCs) con colores por entidad ===
    function flashlightColorFor(e){
      const k = ((e.skin || e.spriteKey || '') + '').toLowerCase();
      if (k.includes('enrique'))   return 'rgba(255,235,90,0.45)';   // amarillo
      if (k.includes('roberto'))   return 'rgba(255,170,90,0.45)';   // naranja cálido
      if (k.includes('francesco')) return 'rgba(80,160,255,0.45)';   // azul frío
      if (e.isNPC || e.kind === ENT.PATIENT) return 'rgba(255,245,170,0.85)'; // cálida suave
      return 'rgba(210,230,255,0.85)'; // neutro
    }

    function updateEntityFlashlights(){
      const list = [];
      const add = (e, fov = Math.PI * 0.55, dist = 620) => {
        const cx = e.x + e.w*0.5, cy = e.y + e.h*0.5;
        const ang = (typeof e.lookAngle === 'number')
          ? e.lookAngle
          : (Math.hypot(e.vx||0, e.vy||0) > 0.01 ? Math.atan2(e.vy||0, e.vx||0) : Math.PI/2);
        list.push({
          x: cx, y: cy, angle: ang,
          fov, dist, color: flashlightColorFor(e), softness: 0.70
        });
      };

      if (G.player && !G.player.dead) {
        const dist = (G.player._flashOuter || 740);   // ← del héroe
        add(G.player, Math.PI * 0.60, dist);
      }
      if (Array.isArray(G.npcs)) {
        for (const npc of G.npcs) { if (npc && !npc.dead) add(npc, Math.PI * 0.50, 520); }
      }
      G.lights = list;

      // Si tu plugin de luces acepta entrada directa
      try { window.LightingAPI?.setFlashlights?.(list); } catch(e){}
    }

  // ------------------------------------------------------------
  // Update principal
  // ------------------------------------------------------------
  function update(dt){
    const zoomDiff = camera.zoomTarget - camera.zoom;
    if (Math.abs(zoomDiff) > 0.0001) {
      // Suaviza el zoom para que los gestos/pulsaciones no salten brusco.
      camera.zoom += zoomDiff * Math.min(1, dt * 12);
    }

    window.SkyFX?.update?.(dt);
    try { window.ArrowGuide?.update?.(dt); } catch(e){}
    try { window.Narrator?.update?.(dt, G); } catch(e){}
    if (G.state !== 'PLAYING' || !G.player) return; // <-- evita tocar nada sin jugador
    G.time += dt;
    G.cycleSeconds += dt;

    // input
    handleInput(dt);
    // sincroniza ángulo continuo con la niebla (si la API lo soporta)
    try { window.FogAPI?.setFacingAngle?.(G.player?.lookAngle || 0); } catch(_) {}
    
    // alimenta al rig con el mismo ángulo (evita “héroe invertido”)
    if (G.player) G.player.facingAngle = G.player.lookAngle || 0;
    
    // jugador
    const p = G.player;
    if (p){
      // Desciende invulnerabilidad con “hard clamp” a cero
      p.invuln = Math.max(0, (p.invuln || 0) - dt);
      if (p.invuln < 0.0005) p.invuln = 0;
      if (p.pushAnimT>0) p.pushAnimT = Math.max(0, p.pushAnimT - dt);
    }

    // Posición del oyente (para paneo/atenuación en SFX posicionales)
    //if (G.player) AudioAPI.setListener(G.player.x + G.player.w/2, G.player.y + G.player.h/2);

    // objetos/movers (camas, carros, pastillas sueltas)
    for (const e of G.movers){
      if (e.dead) continue;
      // clamp velocidad máxima
      const ms = BALANCE.physics.maxSpeedObject;
      const sp = Math.hypot(e.vx, e.vy);
      if (sp>ms){ e.vx = e.vx*(ms/sp); e.vy = e.vy*(ms/sp); }
    }

    // Puppet: alimentar estado de animación
    if (G.player?.rig) { PuppetAPI.update(G.player.rig, dt); }  // el plugin deduce el estado del host

    // enemigos
    updateEntities(dt);
    // ascensores
    Entities?.Elevator?.update?.(dt);

    if (window.MouseNav && window._mouseNavInited) MouseNav.update(dt);

    // reglas
    gameplay(dt);
    // === paso de física (rebotes, empujes, aplastamientos, etc.)
    Physics.step(dt);

    updateEntityFlashlights();

    // Si quieres sincronizar la oscuridad con tu Fog/Luces:
    const amb = SkyFX.getAmbientLight();
    window.FogAPI?.setDarkness?.(amb.darkness);
    // si tu plugin expone este método, úsalo; si no, coméntalo:
    window.LightingAPI?.setAmbientTint?.(amb.tint);
  }

  // ------------------------------------------------------------
  // Dibujo: mundo → blur fuera de luz → HUD nítido
  // ------------------------------------------------------------
  function drawWorldTo(ctx2d){
    // fondo
    ctx2d.fillStyle = COLORS.floor;
    ctx2d.fillRect(0,0,VIEW_W,VIEW_H);

    // cámara
    ctx2d.save();
    ctx2d.translate(VIEW_W/2, VIEW_H/2);
    ctx2d.scale(camera.zoom, camera.zoom);
    ctx2d.translate(-camera.x, -camera.y);

    // mundo
    drawTiles(ctx2d);
    drawEntities(ctx2d);
    drawSpawnFallbacks(ctx2d);

    ctx2d.restore();
  }

  // Dibuja el suelo ajedrezado + paredes con SpriteManager
  function drawTiles(c2){
    Sprites.drawFloorAndWalls(c2, G);
  }

function drawEntities(c2){
  for (const e of G.entities){
    if (!e || e.dead) continue;

    // El jugador se pinta aparte con su rig (más nítido)
    if (e === G.player || e.kind === ENT.PLAYER) continue;

    if (e._debugSpawnPlaceholder) {
      if (typeof e.zIndex !== 'number') e.zIndex = 10; // encima del suelo, debajo del héroe

      const ctx = c2 || window.G?.ctx || window.G?.ctxMain || window.G?.canvasCtx;
      if (!ctx) continue;

      const cam = G?.camera;
      const screenX = (ctx === c2) ? e.x : (e.x - (cam?.x || 0));
      const screenY = (ctx === c2) ? e.y : (e.y - (cam?.y || 0));
      const halfW = (e.w || TILE) * 0.5;
      const halfH = (e.h || TILE) * 0.5;
      ctx.save();
      ctx.translate(screenX, screenY);

      ctx.fillStyle = e._debugColor || '#ff3366';
      ctx.globalAlpha = 0.95;
      ctx.fillRect(-halfW, -halfH, e.w || TILE, e.h || TILE);

      ctx.strokeStyle = '#000';
      ctx.lineWidth = 2;
      ctx.strokeRect(-halfW, -halfH, e.w || TILE, e.h || TILE);

      ctx.globalAlpha = 1;
      ctx.fillStyle = e._debugTextColor || '#ffffff';
      ctx.font = 'bold 16px monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(e._debugChar || '?', 0, 0);

      ctx.restore();
      continue;
    }

    // 1) Si la entidad tiene "muñeco" (rig), dibújalo
    const rig = e._rig || e.rig;
    if (rig && window.PuppetAPI && typeof PuppetAPI.draw === 'function'){
      try { PuppetAPI.draw(rig, c2, camera); } catch(_){}
      continue; // no dupliques con sprite
    }

    // 2) Si hay sprites, dibuja la sprite de la entidad
    let dibujado = false;
    try {
      if (window.Sprites && typeof Sprites.drawEntity === 'function'){
        Sprites.drawEntity(c2, e);
        dibujado = true;
      } else if (typeof e.spriteKey === 'string' && typeof window.Sprites?.draw === 'function'){
        // camino alternativo si tu gestor de sprites usa draw(key, x, y, opts)
        Sprites.draw(c2, e.spriteKey, e.x, e.y, { w: e.w, h: e.h });
        dibujado = true;
      }
    } catch(_){ /* cae a fallback */ }

    // 3) Fallback visible (rectángulo) si no hay sprites
    if (!dibujado){
      c2.fillStyle = e.color || '#a0a0a0';
      c2.fillRect(e.x - e.w/2, e.y - e.h/2, e.w, e.h);
    }
  }
}

  function isDebugMapMode(){
    const mode = (window.__MAP_MODE || '').toLowerCase();
    return mode === 'debug' || mode === 'ascii';
  }

  function drawSpawnFallbacks(c2){
    if (!isDebugMapMode()) return;
    const list = Array.isArray(window.DEBUG_SPAWN_FALLBACKS) ? window.DEBUG_SPAWN_FALLBACKS : [];
    if (!list.length) return;
    const tile = window.TILE_SIZE || TILE;
    const legend = window.AsciiLegend || {};
    c2.save();
    c2.textAlign = 'center';
    c2.textBaseline = 'middle';
    c2.font = `${Math.max(10, Math.floor(tile * 0.75))}px monospace`;
    for (const info of list) {
      if (!info) continue;
      const world = info.world || {};
      const grid = info.grid || {};
      const cx = Number.isFinite(world.x) ? world.x : (Number.isFinite(grid.x) ? grid.x * tile + tile * 0.5 : null);
      const cy = Number.isFinite(world.y) ? world.y : (Number.isFinite(grid.y) ? grid.y * tile + tile * 0.5 : null);
      if (!Number.isFinite(cx) || !Number.isFinite(cy)) continue;
      const def = legend[info.char];
      const color = def?.color || 'rgba(255,0,0,0.55)';
      c2.fillStyle = color;
      c2.fillRect(cx - tile * 0.5, cy - tile * 0.5, tile, tile);
      c2.strokeStyle = 'rgba(0,0,0,0.55)';
      c2.lineWidth = 2;
      c2.strokeRect(cx - tile * 0.5, cy - tile * 0.5, tile, tile);
      c2.fillStyle = '#fff';
      if (def?.color) {
        c2.strokeStyle = 'rgba(0,0,0,0.65)';
        c2.lineWidth = 2;
        c2.strokeText(info.char || '?', cx, cy);
      }
      c2.fillText(info.char || '?', cx, cy);
    }
    c2.restore();
  }

  // Luz del héroe + fog-of-war interna (sin plugins)
  function drawLightingAndFog(){
    ensureBuffers();

    // Si no hay jugador, limpia y sal.
    if (!G.player) {
      ctx.clearRect(0, 0, VIEW_W, VIEW_H);
      return;
    }

    // FogAPI: activa -> la usa; desactivada -> DEBUG sin niebla (mundo limpio)
    if (window.FogAPI) {
      if (FogAPI._enabled) {
        // pinta mundo nítido; FogAPI hará su máscara en su propio canvas
        ctx.clearRect(0, 0, VIEW_W, VIEW_H);
        drawWorldTo(ctx);

        // (B2) “fade lejano” sutil para realismo (puedes comentar si no lo quieres)
        if (G.player) {
          const px = (G.player.x + G.player.w*0.5 - camera.x) * camera.zoom + VIEW_W*0.5;
          const py = (G.player.y + G.player.h*0.5 - camera.y) * camera.zoom + VIEW_H*0.5;
          const R  = Math.max(VIEW_W, VIEW_H) * 0.55;
          const g  = ctx.createRadialGradient(px, py, R*0.40, px, py, R);
          g.addColorStop(0.00, 'rgba(0,0,0,0)');     // cerca: nítido
          g.addColorStop(1.00, 'rgba(0,0,0,0.35)');  // lejos: oscurece un poco
          ctx.save();
          ctx.globalCompositeOperation = 'source-over';
          ctx.fillStyle = g;
          ctx.fillRect(0, 0, VIEW_W, VIEW_H);
          ctx.restore();
        }

        return;
      } else {
        // FogAPI desactivada por debug -> mapa completo sin niebla
        ctx.clearRect(0, 0, VIEW_W, VIEW_H);
        drawWorldTo(ctx);
        return;
      }
    }

    // ⬇️ Fallback SIN FogAPI (modo antiguo radial simple)
    drawWorldTo(sceneCtx);
    blurCtx.clearRect(0, 0, VIEW_W, VIEW_H);
    blurCtx.filter = 'blur(2.2px)';
    blurCtx.drawImage(sceneCanvas, 0, 0);
    blurCtx.filter = 'none';

    ctx.clearRect(0, 0, VIEW_W, VIEW_H);
    ctx.drawImage(blurCanvas, 0, 0);

    const p = G.player;
    const px = (p.x + p.w/2 - camera.x) * camera.zoom + VIEW_W/2;
    const py = (p.y + p.h/2 - camera.y) * camera.zoom + VIEW_H/2;
    const R  = TILE * 6.5 * camera.zoom;

    const fog = ctx.createRadialGradient(px, py, R*0.65, px, py, R*1.30);
    fog.addColorStop(0, 'rgba(0,0,0,0)');
    fog.addColorStop(1, 'rgba(0,0,0,0.95)');
    ctx.fillStyle = fog;
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);
  }

  // ------------------------------------------------------------
  // Draw + loop
  // ------------------------------------------------------------
  function draw(){
    // actualizar cámara centrada en jugador
    if (G.player){
      const baseX = G.player.x + G.player.w/2;
      const baseY = G.player.y + G.player.h/2;
      camera.x = baseX + (camera.offsetX || 0);
      camera.y = baseY + (camera.offsetY || 0);
    }

    // composición: mundo borroso fuera de luz + mundo nítido en cono
    drawLightingAndFog();
    // ⬇️ MUÑECO: encima del mundo, pero por DEBAJO de la niebla/luces
    if (G.player?.rig){
      PuppetAPI.draw(G.player.rig, ctx, camera);
    }

    // Plugins que pintan en sus propios canvas (arriba del mundo)
    try { window.FogAPI?.render(camera, G); } catch(e){ console.warn('FogAPI.render', e); }
    try { window.LightingAPI?.render(camera, G); } catch(e){ console.warn('LightingAPI.render', e); }

    // Efectos de clima sobre la cámara (lluvia, relámpagos, gotas)
    window.SkyFX.renderBackground(ctx);
    window.SkyFX?.renderForeground?.(ctx);
    // Marcador de click del MouseNav (anillo)
    if (window.MouseNav && window._mouseNavInited) { try { MouseNav.render(ctx, camera); } catch(e){} }

    // 1) Dibuja el HUD (esta función hace clearRect del HUD canvas)
    try { window.HUD && HUD.render(hudCtx, camera, G); } catch(e){ console.warn('HUD.render', e); }
    try { window.ArrowGuide?.draw(hudCtx, camera, G); } catch(e){ console.warn('ArrowGuide.draw', e); }
    if (window.Sprites?.renderOverlay) { Sprites.renderOverlay(hudCtx); }

    // 2) Dibuja AHORA la flecha y overlays, para que el clear del HUD no las borre
    try { window.ArrowGuide?.draw(hudCtx, camera, G); } catch(e){ console.warn('ArrowGuide.draw', e); }
    if (window.Sprites?.renderOverlay) { Sprites.renderOverlay(hudCtx); }
  }

  // Fixed timestep
  let lastT = performance.now();
  let acc = 0;
  const DT = 1/60;
  let frames = 0, dtAcc=0, msFrame=0, FPS=60;

  function loop(now){
    const delta = (now - lastT)/1000; lastT = now;
    acc += Math.min(delta, 0.05);
    while (acc >= DT){
      update(DT);
      acc -= DT;
      frames++; dtAcc += DT;
      if (dtAcc >= 0.25){
        FPS = frames/dtAcc;
        msFrame = 1000/FPS;
        frames=0; dtAcc=0;
      }
    }
    draw();
    requestAnimationFrame(loop);
  }

  // ============================================================================
  // Helper: entidad de fallback para SPAWN_FALLBACK
  // ============================================================================
  function createAsciiFallbackEntity(opts) {
    const root = window;
    const T = (root.TILE_SIZE && root.TILE_SIZE | 0) || 32;

    const x = (opts && opts.x) | 0;
    const y = (opts && opts.y) | 0;
    const ch = (opts && opts.char) || '?';
    const color = (opts && opts.color) || '#ff00ff'; // magenta chillón
    const label = (opts && opts.label) || '[SPAWN_FALLBACK]';

    // Entidad lo más completa posible para que nunca rompa nada
    const e = {
      id: root.genId ? root.genId() : ('fallback-' + Math.random()),
      kind: (root.ENT && root.ENT.DEBUG_FALLBACK) || 'debug_fallback',
      role: 'debug_fallback',
      populationType: 'none',

      // Transform
      x,
      y,
      w: 24,
      h: 24,
      vx: 0,
      vy: 0,
      dir: 0,

      // Colisión: piso pisable inofensivo
      solid: false,
      isTileWalkable: true,
      isFloorTile: false,
      isTriggerOnly: false,
      isHazard: false,
      collisionLayer: 'default',
      collisionMask: 'default',

      // Vida / daño desactivados
      maxHealth: 1,
      health: 1,
      hearts: 1,
      maxHearts: 1,
      dead: false,
      deathCause: null,
      touchDamage: 0,
      touchCooldown: 0.9,
      _touchCD: 0,
      fireImmune: true,

      // Estado visual / IA mínima
      state: 'idle',
      facing: 'down',
      isMoving: false,
      isAttacking: false,
      isEating: false,
      isTalking: false,
      isPushing: false,

      ai: {
        enabled: false,
        mode: 'idle',
        patrolPoints: null,
        patrolIndex: 0,
        patrolWait: 0.5,
        _patrolTimer: 0,
        sightRadius: 0,
        loseSightTime: 0,
        _loseSightTimer: 0,
        speed: 0,
        data: null,
      },

      // Hooks vacíos para que nunca revienten
      aiUpdate: function () {},
      physicsUpdate: function () {},
      onDamage: function () {},
      onDeath: function () {},
      onAttackHit: function () {},
      onEat: function () {},
      onTalk: function () {},
      onInteract: null,
      onUse: null,
      onCrush: null,
      onEnterTile: null,
      onLeaveTile: null,

      // Info debug
      debugChar: ch,
      debugLabel: label,

      // Puppet: rig genérico de debug
      puppet: {
        rig: 'debug_ascii_fallback',
        z: root.HERO_Z || 10,
        skin: null,
        _color: color,   // se lo pasamos al rig
      },

      removeMe: false,
      _culled: false,
      rigOk: true,
      data: {},
    };

    try {
      if (root.PuppetAPI && e.puppet && e.puppet.rig) {
        root.PuppetAPI.attach(e, e.puppet);
      }
    } catch (err) {
      e.rigOk = false;
      if (root.DEBUG_RIGS) {
        console.error('[RigError][DEBUG_FALLBACK]', err);
      }
    }

    if (root.EntityGroupsAPI && root.EntityGroupsAPI.add) {
      root.EntityGroupsAPI.add(e, 'debug');
    }

    if (root.G && Array.isArray(root.G.entities)) {
      root.G.entities.push(e);
    }

    return e;
  }

  function getDebugColorForChar(charLabel, def) {
    try {
      window.__FALLBACK_CHAR_COLORS = window.__FALLBACK_CHAR_COLORS || {};
      const palette = window.__FALLBACK_CHAR_COLORS;

      const tintValue = (def && (def.color || def.tint || def.debugColor)) || null;
      if (tintValue) {
        palette[charLabel] = tintValue;
        return tintValue;
      }

      if (palette[charLabel]) return palette[charLabel];

      const color = computeDeterministicColorForChar(charLabel || '?');
      palette[charLabel] = color;
      return color;
    } catch (_) {
      return '#ff3366';
    }
  }

  function computeDeterministicColorForChar(charLabel){
    const str = String(charLabel || '?');
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
    }
    const h = Math.abs(hash % 360);
    const s = 65;
    const l = 55;
    return `hsl(${h}, ${s}%, ${l}%)`;
  }

  function pickDebugColorForChar(charLabel, def){
    try {
      const palette = window.__FALLBACK_CHAR_COLORS = window.__FALLBACK_CHAR_COLORS || {};
      const tintValue = (def && (def.color || def.tint || def.debugColor)) || null;
      if (tintValue) {
        palette[charLabel] = tintValue;
        return tintValue;
      }

      const table = {
        'p': '#ff9800',
        'b': '#e91e63',
        'g': '#4caf50',
        'i': '#03a9f4',
        'd': '#795548',
        'E': '#9c27b0',
        'H': '#3f51b5'
      };

      if (palette[charLabel]) return palette[charLabel];
      if (table[charLabel]) return table[charLabel];

      const color = computeDeterministicColorForChar(charLabel || '?');
      palette[charLabel] = color;
      return color;
    } catch (_) {
      return '#ff3366';
    }
  }

  function pickDebugTextColorForBackground(bg){
    try {
      let hex = String(bg || '').trim();
      if (hex[0] === '#') hex = hex.slice(1);
      if (hex.length === 3) {
        hex = hex.split('').map(c => c + c).join('');
      }
      if (hex.length !== 6) return '#ffffff';

      const r = parseInt(hex.slice(0, 2), 16);
      const g = parseInt(hex.slice(2, 4), 16);
      const b = parseInt(hex.slice(4, 6), 16);

      const luma = 0.299 * r + 0.587 * g + 0.114 * b;
      return luma > 160 ? '#000000' : '#ffffff';
    } catch (_) {
      return '#ffffff';
    }
  }

  function createSpawnDebugPlaceholderEntity(charLabel, worldX, worldY, def, extra) {
    const T = window.TILE_SIZE || 32;

    const bgColor = pickDebugColorForChar(charLabel, def);
    const textColor = pickDebugTextColorForBackground(bgColor);

    const e = {
      id: (typeof genId === 'function') ? genId() : ('fallback-' + Math.random().toString(36).slice(2)),
      kind: window.ENT && window.ENT.DEBUG_PLACEHOLDER || 'DEBUG_PLACEHOLDER',
      role: 'debug_placeholder',
      populationType: 'none',
      x: worldX,
      y: worldY,
      w: T,
      h: T,
      vx: 0,
      vy: 0,
      dir: 0,
      solid: false,
      collisionLayer: 'default',
      collisionMask: 'default',
      _debugSpawnPlaceholder: true,
      _debugChar: charLabel || '?',
      _debugColor: bgColor,
      _debugTextColor: textColor,
      _debugExtra: extra || null,
      aiUpdate: function () {},
      physicsUpdate: function () {},
      onDamage: function () {},
      onDeath: function () {},
      onEnterTile: null,
      onLeaveTile: null,
      onInteract: null,
      puppet: null,
      rigOk: false,
      removeMe: false,
      _culled: false
    };

    // Los [SPAWN_FALLBACK] terminan siempre aquí y se meten en G.entities para pasar por el render.
    if (window.G && Array.isArray(G.entities)) {
      G.entities.push(e);
    }

    return e;
  }

  window.createSpawnDebugPlaceholderEntity = window.createSpawnDebugPlaceholderEntity || createSpawnDebugPlaceholderEntity;

  function __debugSpawnTestPlaceholder() {
    try {
      const T = window.TILE_SIZE || 32;
      const worldX = T * 4.5;
      const worldY = T * 4.5;

      const e = {
        id: 'debug-test-placeholder',
        kind: 'DEBUG_PLACEHOLDER',
        role: 'debug_placeholder',
        populationType: 'none',

        x: worldX,
        y: worldY,
        w: T,
        h: T,

        vx: 0,
        vy: 0,
        dir: 0,

        solid: false,
        collisionLayer: 'default',
        collisionMask: 'default',

        _debugSpawnPlaceholder: true,
        _debugChar: 'X',
        _debugColor: '#ff3366',
        _debugTextColor: '#ffffff',

        aiUpdate: function () {},
        physicsUpdate: function () {},
        onDamage: function () {},
        onDeath: function () {},
        onEnterTile: null,
        onLeaveTile: null,
        onInteract: null,

        puppet: null,
        rigOk: false,
        removeMe: false,
        _culled: false
      };

      if (window.G && Array.isArray(G.entities)) {
        G.entities.push(e);
      }
    } catch (_) {}
  }

  function safeLogSpawnFallbackError(stage, err, meta) {
    try {
      const msg = '[SPAWN_FALLBACK_ERROR] ' + stage;
      const payload = {
        message: String((err && err.message) || err),
        stage,
        char: meta && meta.charLabel,
        kind: meta && meta.kind,
        factoryKey: meta && meta.def && meta.def.factoryKey || null,
        grid: meta && { x: meta.tx, y: meta.ty },
        world: meta && { x: meta.worldX, y: meta.worldY }
      };
      if (console && typeof console.error === 'function') {
        console.error(msg, payload);
      }
    } catch (_) {}
  }

  function safeSpawnFallbackPlaceholder(charLabel, def, tx, ty, worldX, worldY, reason, placement) {
    let entity = null;

    try {
      if (typeof registerSpawnFallback === 'function') {
        registerSpawnFallback({
          char: charLabel,
          kind: def && (def.kind || def.key) || null,
          factoryKey: def && def.factoryKey || null,
          grid: { x: tx, y: ty },
          world: { x: worldX, y: worldY },
          reason: reason || 'unknown',
          placement: placement || null,
        });
      }
    } catch (_) {}

    try {
      if (window.PlacementAPI && typeof window.PlacementAPI.spawnFallbackPlaceholder === 'function') {
        entity = window.PlacementAPI.spawnFallbackPlaceholder(charLabel, def, tx, ty, 'finalizeLevelBuildOnce', {
          x: worldX,
          y: worldY,
          reason: reason || 'unknown'
        });
      }
    } catch (err) {
      entity = null;
      safeLogSpawnFallbackError('PlacementAPI.spawnFallbackPlaceholder', err, { charLabel, def, tx, ty, worldX, worldY });
    }

    if (!entity) {
      try {
        entity = createSpawnDebugPlaceholderEntity(charLabel, worldX, worldY, def, reason || 'unknown');
      } catch (err) {
        entity = null;
        safeLogSpawnFallbackError('createSpawnDebugPlaceholderEntity', err, { charLabel, def, tx, ty, worldX, worldY });
      }
    }

    return entity;
  }

  const SAFE_SPAWN_KINDS = {
    hero: true,
    hero_spawn: true,
    player: true
  };

  function spawnEntityFromAsciiSafe(params){
    const {
      G,
      map,
      p,
      ch,
      def,
      tx,
      ty,
      worldX,
      worldY,
      type,
      spawnFromAscii,
      heroSpawner
    } = params || {};

    const charLabel = (p && p.char) || ch || '?';
    const kindRaw = def?.kind || def?.key || type || p?.type || p?.kind || charLabel;
    const kind = String(kindRaw || '').toLowerCase();
    const factoryKey = def?.factoryKey || null;

    const logPayload = {
      char: charLabel,
      kind,
      factoryKey,
      grid: { x: tx, y: ty },
      world: { x: worldX, y: worldY },
      placement: p || null
    };
    try { console.log('[SPAWN_ASCII]', logPayload); } catch (_) {}

    const isSafeKind = !!SAFE_SPAWN_KINDS[kind];

    const buildReason = (code, extra) => ({ code, ...(extra || {}), kind, factoryKey });
    // [DIAGNÓSTICO] Los [SPAWN_FALLBACK] pasan por aquí y llaman a createSpawnDebugPlaceholderEntity incluso si PlacementAPI falla.
    const logFallback = (reasonObj) => {
      const reason = reasonObj || buildReason('unknown');
      try {
        console.warn('[SPAWN_FALLBACK]', { char: charLabel, kind, grid: { x: tx, y: ty }, world: { x: worldX, y: worldY }, reason });
      } catch (_) {}
      try {
        if (typeof registerSpawnFallback === 'function') {
          registerSpawnFallback({
            char: charLabel,
            kind,
            factoryKey,
            grid: { x: tx, y: ty },
            world: { x: worldX, y: worldY },
            reason
          });
        }
      } catch (_) {}
      return createSpawnDebugPlaceholderEntity(charLabel, worldX, worldY, def || null, reason);
    };

    if (!isSafeKind) {
      return logFallback(buildReason('unsafe-kind'));
    }

    let entity = null;
    let lastReason = null;

    if (!entity && typeof heroSpawner === 'function' && (kind.includes('hero') || kind === 'player')) {
      try { entity = heroSpawner(worldX, worldY, params); }
      catch (err) {
        entity = null;
        lastReason = buildReason('hero_spawn_error', { error: String((err && err.message) || err) });
        safeLogSpawnFallbackError('heroSpawner', err, { charLabel, def, tx, ty, worldX, worldY, kind });
      }
    }

    if (!entity && spawnFromAscii && (def || ch)) {
      try {
        entity = spawnFromAscii(def || ch, tx, ty, { G, map, char: charLabel, placement: p, x: worldX, y: worldY }, charLabel);
      } catch (err) {
        entity = null;
        lastReason = buildReason('spawnFromAscii_error', { error: String((err && err.message) || err) });
        safeLogSpawnFallbackError('spawnFromAscii', err, { charLabel, def, tx, ty, worldX, worldY, kind });
      }
    }

    if (!entity && factoryKey && window.Entities && typeof window.Entities.factory === 'function') {
      try {
        entity = window.Entities.factory(factoryKey, { tx, ty, x: worldX, y: worldY, _ascii: def });
      } catch (err) {
        entity = null;
        lastReason = buildReason('missingFactory', { error: String((err && err.message) || err) });
        safeLogSpawnFallbackError('Entities.factory', err, { charLabel, def, tx, ty, worldX, worldY, kind });
      }
    }

    if (!entity && window.PlacementAPI && typeof window.PlacementAPI.spawnFallbackPlaceholder === 'function') {
      try {
        entity = window.PlacementAPI.spawnFallbackPlaceholder(charLabel, def || null, tx, ty, 'spawnEntityFromAsciiSafe', {
          x: worldX,
          y: worldY,
          reason: (lastReason && lastReason.code) || 'placement-fallback'
        });
      } catch (err) {
        entity = null;
        lastReason = buildReason('placement_error', { error: String((err && err.message) || err) });
        safeLogSpawnFallbackError('PlacementAPI.spawnFallbackPlaceholder', err, { charLabel, def, tx, ty, worldX, worldY, kind });
      }
    }

    if (!entity) {
      lastReason = lastReason || buildReason('missingFactory');
      entity = logFallback(lastReason);
    }

    return entity;
  }

  function safeAttachRig(e, rigCfg, source){
    const PuppetAPI = root.PuppetAPI || root.Puppet || null;
    if (!PuppetAPI) {
      e.rigOk = false;
      try { console.warn('[SPAWN_RIG_WARN] PuppetAPI ausente', { source, kind: e?.kind, role: e?.role }); } catch (_) {}
      return null;
    }
    try {
      const puppet = PuppetAPI.attach ? PuppetAPI.attach(e, rigCfg) : PuppetAPI.bind?.(e, rigCfg?.rig, rigCfg);
      e.rigOk = !!puppet;
      return puppet;
    } catch (err) {
      e.rigOk = false;
      const msg = String((err && err.message) || err);
      try {
        console.error('[SPAWN_RIG_ERROR]', { source, kind: e?.kind, role: e?.role, rig: rigCfg && rigCfg.rig, msg });
      } catch (_) {}
      try {
        if (typeof registerSpawnFallback === 'function') {
          registerSpawnFallback({
            char: e?._debugChar || null,
            kind: e?.kind || null,
            world: e ? { x: e.x, y: e.y } : null,
            stage: 'PuppetAPI.attach',
            reason: 'rig_error',
            error: msg,
          });
        }
      } catch (_) {}
      return null;
    }
  }

  window.safeAttachRig = window.safeAttachRig || safeAttachRig;

  // === Post-parse: instanciar placements SOLO UNA VEZ ===
  function finalizeLevelBuildOnce(){
    if (G._placementsFinalized) return;          // evita duplicados
    G._placementsFinalized = true;

    const placements = (Array.isArray(G.mapgenPlacements) && G.mapgenPlacements.length)
      ? G.mapgenPlacements
      : (Array.isArray(G.__asciiPlacements) ? G.__asciiPlacements : []);
    if (!placements.length) return;

    try {
      const validateMapShape = () => {
        const width = G?.mapW | 0;
        const height = G?.mapH | 0;
        const map = Array.isArray(G?.map) ? G.map : [];
        if (!width || !height || map.length !== height) {
          console.warn('[MAP_SANITY]', { width, height, rows: map.length });
        }
      };

      validateMapShape();

      // Camino “oficial”: si existe el helper, úsalo
      if (typeof window.applyPlacementsFromMapgen === 'function') {
        window.applyPlacementsFromMapgen(placements);
        return;
      }

      // Fallback LOCAL: instanciar lo básico si no hay placement.api.js
      const T = (window.TILE_SIZE | 0) || 32;
      const legendApi = window.PlacementAPI || window.AsciiLegendAPI || {};
      const getDef = legendApi.getDefFromChar || legendApi.getDef || ((ch, opts) => {
        const def = (window.AsciiLegend && window.AsciiLegend[ch]) || null;
        if (!def && opts?.log !== false) {
          try { console.warn('[ASCII] Unknown char in map:', JSON.stringify(ch), opts?.context || 'finalizeLevelBuildOnce'); } catch (_) {}
        }
        return def;
      });
      const getCharForKey = legendApi.getCharForKey || (() => null);
      const spawnFromAscii = legendApi.spawnFromAscii || null;

      const pushUnique = (arr, item) => {
        if (item && Array.isArray(arr) && !arr.includes(item)) arr.push(item);
      };

      const registerEntity = (entity, def, placement) => {
        if (!entity) return;
        pushUnique(G.entities, entity);
        if (!entity.static && (entity.dynamic || entity.pushable || entity.vx || entity.vy)) {
          pushUnique(G.movers, entity);
        }

        const kind = String(entity.kind || def?.kind || def?.key || placement?.type || '').toLowerCase();
        if (def?.isPatient || kind.includes('patient')) {
          pushUnique(G.patients, entity);
          pushUnique(G.npcs, entity);
        }
        if (def?.kind === 'pill' || kind.includes('pill')) {
          pushUnique(G.pills, entity);
        }
        if (def?.isNPC || kind.includes('npc')) {
          pushUnique(G.npcs, entity);
        }
        if (def?.isEnemy || kind.includes('enemy')) {
          pushUnique(G.enemies, entity);
        }
        if (def?.isCart || kind.includes('cart')) {
          pushUnique(G.movers, entity);
          if (!G.cart) G.cart = entity;
        }
        if (def?.isDoor || kind.includes('door')) {
          if (!G.door) G.door = entity;
        }
        if (kind.includes('boss')) {
          if (!G.boss) G.boss = entity;
        }
        if (kind.includes('light')) {
          pushUnique(G.lights, entity);
        }
        try { window.EntityGroups?.assign?.(entity); } catch (_) {}
        try { window.EntityGroups?.register?.(entity, G); } catch (_) {}
      };

      const charCounts = new Map();
      const spawnedCounts = new Map();

      const markCharSeen = (ch, def) => {
        if (!ch || (def && (def.kind === 'wall' || def.kind === 'void' || def.baseKind === 'floor' || def.kind === 'floor'))) return;
        const key = String(ch);
        charCounts.set(key, (charCounts.get(key) || 0) + 1);
      };

      const markCharSpawned = (ch) => {
        if (!ch) return;
        const key = String(ch);
        spawnedCounts.set(key, (spawnedCounts.get(key) || 0) + 1);
      };

      const clampPlacements = () => {
        if (!G || !Array.isArray(G.map)) return;
        const maxW = (G.mapW | 0) * T;
        const maxH = (G.mapH | 0) * T;
        for (const it of placements){
          if (!it) continue;
          if (typeof it.x === 'number') it.x = Math.max(0, Math.min(it.x, maxW - 1));
          if (typeof it.y === 'number') it.y = Math.max(0, Math.min(it.y, maxH - 1));
        }
      };

      clampPlacements();

      for (const p of placements) {
        if (!p) continue;

        const txRaw = Number.isFinite(p?.tx) ? p.tx : Math.floor((Number(p?.x) || 0) / T);
        const tyRaw = Number.isFinite(p?.ty) ? p.ty : Math.floor((Number(p?.y) || 0) / T);
        const tx = txRaw | 0;
        const ty = tyRaw | 0;
        const worldX = tx * T + T * 0.5;
        const worldY = ty * T + T * 0.5;

        let ch = p.char || p.ch || p.ascii || p.symbol || null;
        if (!ch) {
          ch = getCharForKey(p.type || p.kind || p.factoryKey, null);
        }
        const def = ch ? getDef(ch, { context: 'finalizeLevelBuildOnce' }) : null;
        markCharSeen(ch, def);
        const type = String(p.type || def?.kind || def?.key || ch || '').toLowerCase();

        if (def && (def.kind === 'wall' || def.kind === 'void' || def.baseKind === 'floor' || def.kind === 'floor')) {
          continue; // terreno puro, ya procesado en el mapa de tiles
        }

        const entity = spawnEntityFromAsciiSafe({
          G,
          map: G.map,
          p,
          ch,
          def,
          tx,
          ty,
          worldX,
          worldY,
          type,
          spawnFromAscii,
          heroSpawner: (x, y) => {
            if ((type === 'player' || type === 'hero' || type === 'start' || type === 'hero_spawn') && !G.player) {
              const hero = (typeof makePlayer === 'function')
                ? makePlayer(x, y)
                : (window.Entities?.Hero?.spawnPlayer?.(x, y, {}) || null);
              if (hero && !G.player) {
                G.player = hero;
              }
              return hero;
            }
            return null;
          }
        });
        registerEntity(entity, def, p);
        if (entity) markCharSpawned(ch);
      }

      for (const [ch] of charCounts) {
        if ((spawnedCounts.get(ch) || 0) < 1) {
          try { console.warn('[SPAWN_MISSING]', ch); } catch (_) {}
        }
      }
    } catch(e){ console.warn('finalizeLevelBuildOnce (fallback):', e); }
  }

  function selfTestSpawnFallbackPlaceholder() {
    try {
      const T = window.TILE_SIZE || 32;
      const worldX = T * 1.5;
      const worldY = T * 1.5;
      const e = createSpawnDebugPlaceholderEntity('#', worldX, worldY, null);
      if (e && window.G && Array.isArray(G.entities)) {
        console.log('[SPAWN_FALLBACK_TEST] Placeholder creado correctamente', e.id || e);
      } else {
        console.warn('[SPAWN_FALLBACK_TEST] No se ha podido crear placeholder de test');
      }
    } catch (err) {
      try { console.error('[SPAWN_FALLBACK_TEST_ERROR]', err); } catch (_) {}
    }
  }

  function loadDebugAsciiMap() {
    // 1) Fuente principal: debug-map.txt → window.DEBUG_ASCII_MAP_TEXT
    if (typeof window.DEBUG_ASCII_MAP_TEXT === 'string') {
      // Texto crudo tal cual llega del fichero
      const raw = String(window.DEBUG_ASCII_MAP_TEXT || '');
      const txt  = raw.trim();

      if (txt) {
        // Parseo tolerante: cada línea es una fila del mapa
        // (quitamos solo espacios en blanco al final de línea)
        const rows = txt
          .split(/\r?\n/)
          .map(r => r.replace(/\s+$/, ''));

        // Validación SOLO para avisar, no para descartar el mapa
        try {
          if (typeof validateDebugAsciiRows === 'function') {
            const hasUnknown = validateDebugAsciiRows(rows);
            if (hasUnknown) {
              console.warn(
                '[MAP_DEBUG] debug-map.txt contiene caracteres desconocidos; ' +
                'se usará igualmente y esos chars se verán como SPAWN_FALLBACK.'
              );
            }
          }
        } catch (_) {
          // Si la validación peta, no queremos romper el debug-map
        }

        // Siempre devolvemos las filas del debug-map.txt si hay contenido
        return rows;
      }

      // Hay fichero, pero está realmente vacío
      try {
        console.warn('[MAP_DEBUG] debug-map.txt vacío, se usará DEFAULT_ASCII_MAP interno');
      } catch (_) {}
    }

    // 2) Fallbacks antiguos (por compatibilidad)
    if (Array.isArray(window.DEBUG_ASCII_MAP) && window.DEBUG_ASCII_MAP.length) {
      return window.DEBUG_ASCII_MAP.map(String);
    }

    if (typeof window.DEBUG_ASCII_STRING === 'string') {
      const txt = window.DEBUG_ASCII_STRING.trim();
      if (txt) {
        return txt
          .split(/\r?\n/)
          .map(r => r.replace(/\s+$/, ''));
      }
    }

    if (window.__MAP_MODE === 'mini') {
      return DEBUG_ASCII_MINI.slice();
    }

    // Nada que cargar
    return null;
  }

  async function buildLevelForCurrentMode(){
    const mode = (window.__MAP_MODE || 'normal').toLowerCase();
    const seed = G.seed || Date.now();
    const levelId = G.level || 1;
    let ascii = null;
    let levelRules = null;
    let generationMeta = null;
    let levelConfig = null;
    let mapgenResult = null;
    let asciiRows = [];
    let mapWidth = 0;
    let mapHeight = 0;

    if (mode === 'debug' || mode === 'ascii') {
      await tryLoadDebugMapText();
    }

    if (mode === 'normal' && !window.DEBUG_FORCE_ASCII) {
      try {
        if (window.MapGen && typeof MapGen.generate === 'function') {
          if (typeof MapGen.init === 'function') MapGen.init(G);
        }
      } catch(e){ console.error('[MAPGEN_ERROR] init/generate falló:', e); }

      try {
        if (typeof window.LevelRulesAPI?.getLevelConfig === 'function') {
          levelConfig = await window.LevelRulesAPI.getLevelConfig(levelId, 'normal');
        }
      } catch (e) { console.warn('[LevelRulesAPI] load falló:', e); }

      try {
        if (window.MapGenAPI && typeof MapGenAPI.generate === 'function') {
          const res = MapGenAPI.generate({
            levelId,
            levelConfig,
            rngSeed: seed,
            place: false,
            defs: null,
            width:  window.DEBUG_MINIMAP ? 128 : undefined,
            height: window.DEBUG_MINIMAP ? 128 : undefined,
            mode: 'normal'
          });
          const resolved = await res;
          if (resolved && resolved.ascii) {
            ascii = String(resolved.ascii).trim().split('\n');
            G.mapgenPlacements = resolved.placements || [];
            G.mapAreas = resolved.areas || null;
            levelRules = resolved.levelRules || levelConfig || null;
            generationMeta = resolved.meta || null;
            mapgenResult = resolved;
            window.HD_LEVEL_CONFIG = levelRules;
            G.levelConfig = levelRules;
            console.log('%cMAP_MODE','color:#0bf', window.DEBUG_MINIMAP ? 'procedural mini' : 'procedural normal');
          }
        }
      } catch(e){ console.error('[MAPGEN_ERROR] generate falló:', e); }
    }

    if (!ascii && (mode === 'debug' || mode === 'ascii')) {
      ascii = loadDebugAsciiMap();
      if (ascii && ascii.length) {
        console.log('%cMAP_MODE','color:#0bf', mode || 'debug', '→ ASCII');
      }
    }

    if (!ascii || !ascii.length) {
      ascii = (window.__MAP_MODE === 'mini' ? DEBUG_ASCII_MINI : DEFAULT_ASCII_MAP).slice();
      console.log('%cMAP_MODE','color:#0bf', 'fallback DEFAULT_ASCII_MAP');
    }

    asciiRows = Array.isArray(ascii) ? ascii.map((row) => String(row)) : [];
    mapWidth = asciiRows[0] ? asciiRows[0].length : 0;
    mapHeight = asciiRows.length;

    if (mode === 'normal' && asciiRows.length) {
      try {
        const walkableTiles = generationMeta?.walkableTiles;
        // IMPORTANTE: no mezclar ?? con || en la misma expresión.
        // Chrome/Firefox lanzan SyntaxError si se combinan sin paréntesis.
        // Usar el patrón totalTilesRaw + totalTiles de arriba.
        const totalTilesRaw = Number.isFinite(generationMeta?.totalTiles)
          ? generationMeta.totalTiles
          : (mapWidth && mapHeight ? mapWidth * mapHeight : null);
        const totalTiles = Number.isFinite(totalTilesRaw) ? totalTilesRaw : null;
        const floorPercent = Number.isFinite(generationMeta?.floorPercent)
          ? generationMeta.floorPercent
          : (Number.isFinite(walkableTiles) && totalTiles)
            ? Math.round((walkableTiles / totalTiles) * 1000) / 10
            : null;
        console.log('[MAPGEN_SUMMARY]', {
          roomsRequested: generationMeta?.roomsRequested ?? levelRules?.rooms,
          roomsGenerated: generationMeta?.roomsGenerated ?? generationMeta?.roomsCount ?? mapgenResult?.rooms?.length,
          width: mapWidth,
          height: mapHeight,
          floorPercent,
          walkableTiles,
          totalTiles,
          numCorridors: generationMeta?.corridorsBuilt ?? generationMeta?.numCorridors ?? null
        });
      } catch (_) {}
    }

    if (mode === 'normal' && Array.isArray(ascii) && ascii.length && !G._debugExported) {
      try {
        const asciiRowsExport = asciiRows;
        const width = mapWidth;
        const height = mapHeight;
        const globalsMeta = levelRules?.globals || null;
        const levelMeta = levelRules ? { ...levelRules } : null;
        if (levelMeta && levelMeta.globals) delete levelMeta.globals;
        const generation = {
          roomsRequested: generationMeta?.roomsRequested ?? levelRules?.rooms,
          roomsGenerated: generationMeta?.roomsGenerated ?? generationMeta?.roomsCount ?? mapgenResult?.rooms?.length,
          corridorWidthUsed: generationMeta?.corridorWidthUsed ?? generationMeta?.corridorWidth ?? generationMeta?._corridorWidth,
          culling: generationMeta?.culling ?? levelRules?.culling ?? globalsMeta?.culling,
          cooling: generationMeta?.cooling ?? levelRules?.cooling ?? globalsMeta?.cooling,
          bossReachable: generationMeta?.bossReachable,
          allRoomsReachable: generationMeta?.allRoomsReachable,
          floorPercent: generationMeta?.floorPercent,
          walkableTiles: generationMeta?.walkableTiles,
          totalTiles: generationMeta?.totalTiles,
          numCorridors: generationMeta?.corridorsBuilt ?? generationMeta?.numCorridors
        };
        const metaExtra = {
          levelId: levelRules?.id ?? levelRules?.level ?? levelId ?? 1,
          mode: 'normal',
          width,
          height,
          seed: levelRules?.seed ?? seed ?? G.seed,
          floorPercent: generationMeta?.floorPercent,
          corridorWidthUsed: generation.corridorWidthUsed
        };
        const meta = {
          levelId: levelRules?.id ?? levelRules?.level ?? G.level ?? 1,
          mode: 'normal',
          width,
          height,
          seed: levelRules?.seed ?? seed ?? G.seed,
          culling: levelRules?.culling ?? globalsMeta?.culling,
          cooling: levelRules?.cooling ?? globalsMeta?.cooling,
          rooms: levelRules?.rooms,
          boss: levelRules?.boss,
          difficulty: levelRules?.difficulty,
          globals: globalsMeta,
          level: levelMeta,
          rules: levelRules?.rules || [],
          generation,
          meta_extra: metaExtra
        };

        const dump = DebugMapExport.buildAsciiDump({
          asciiRows,
          meta
        });
        DebugMapExport.sendToServer(dump);
        G._debugExported = true;
      } catch (err) {
        console.warn('[DebugMapExport] No se pudo exportar el mapa', err);
      }
    }

    ASCII_MAP = ascii;
    parseMap(ASCII_MAP);

    if (!G.levelConfig) {
      G.levelConfig = levelRules || { level: levelId, id: levelId, mode };
    }

    if (mode === 'normal') {
      const coolingValue = Number.isFinite(levelRules?.cooling) ? levelRules.cooling : 20;
      if (!Number.isFinite(G.cooling)) {
        G.cooling = coolingValue;
      } else {
        G.cooling = coolingValue;
      }
      try {
        console.log('[buildLevel] normal map from level_rules', {
          level: G.level || 1,
          width: G.mapW,
          height: G.mapH,
          rooms: levelRules?.rooms,
          cooling: coolingValue
        });
      } catch (_) {}
    }

    const placements = (G.mapgenPlacements && G.mapgenPlacements.length)
      ? G.mapgenPlacements
      : (G.__asciiPlacements || []);

    if (!G.mapgenPlacements || !G.mapgenPlacements.length) {
      G.mapgenPlacements = placements || [];
    }

    G.__allowASCIIPlacements = true;
    if (typeof window.applyPlacementsFromMapgen === 'function' && placements && placements.length) {
      try { window.applyPlacementsFromMapgen(placements); } catch (e) { console.warn('[MAPGEN_WARNING] applyPlacements', e); }
    }

    finalizeLevelBuildOnce();
    if (mode === 'debug') {
      selfTestSpawnFallbackPlaceholder();
      __debugSpawnTestPlaceholder();
    }
    window.__toggleMinimap?.(!!window.DEBUG_MINIMAP);
  }

  // [SANITY CHECKS] Activar en caso de dudas durante depuración.
  // console.log('[SANITY] typeof buildLevelForCurrentMode =', typeof buildLevelForCurrentMode);
  // console.log('[SANITY] typeof MapGenPlugin =', typeof window.MapGenPlugin);
  // console.log('[SANITY] typeof MapGenPlugin.generateLevel =', typeof window.MapGenPlugin?.generateLevel);
  // ------------------------------------------------------------
  // Control de estado
  // ------------------------------------------------------------
  async function startGame(){
    G.state = 'PLAYING';
    resetCameraView();
    try { window.MusicManager?.stopMenu?.({ fadeTime: 0.25 }); } catch (_) {}
    // si hay minimapa de debug, muéstralo ahora (no en el menú)
    window.__toggleMinimap?.(!!window.DEBUG_MINIMAP);
    startScreen.classList.add('hidden');
    pausedScreen.classList.add('hidden');
    levelCompleteScreen.classList.add('hidden');
    gameOverScreen.classList.add('hidden');
    // mostrar mini-mapa solo en juego
    try { window.__toggleMinimap?.(true); } catch(_){}


    // Reset de estado base
    G.time = 0; G.score = 0; G.health = 6; G.delivered = 0; G.timbresRest = 1;
    G.carry = null;
    G._placementsFinalized = false;
    G._debugExported = false;
    window.DEBUG_SPAWN_FALLBACKS = [];
    window.DEBUG_MAP_HAS_UNKNOWN_CHARS = false;

    // Flag global (lo usará placement.api.js para NO sembrar)
    window.DEBUG_FORCE_ASCII = DEBUG_FORCE_ASCII;
    G.flags = G.flags || {};
    G.flags.DEBUG_FORCE_ASCII = DEBUG_FORCE_ASCII;
    G.flags.DEBUG_MINIMAP = DEBUG_MINIMAP;

    await buildLevelForCurrentMode();

    try {
      const levelCfg = window.G?.levelConfig || { level: G.level || 1, id: G.level || 1, mode: window.__MAP_MODE || 'normal' };
      window.MusicManager?.playLevel?.(levelCfg);
    } catch (_) {}

      // === Puppet rig (visual) para el jugador) — CREAR AL FINAL ===
      if (window.PuppetAPI && G.player){
        const k = (G.player.heroId || window.SELECTED_HERO_ID || window.selectedHeroKey || window.G?.selectedHero || 'enrique').toLowerCase();
        if (!G.player.rig) {
          const scale = G.player.puppet?.scale || ((window.TILE_SIZE||32) / 32);
          G.player.rig = PuppetAPI.attach(G.player, { rig: 'human', scale, z: G.player.puppet?.z || 5 });
        }

        // Cara frontal + cara de ESPALDA (si existe <hero>_back.png)
        if (G.player.rig) {
          PuppetAPI.setHeroHead(G.player.rig, k);
        }

        // Reforzar rango de visión del héroe si FogAPI lo expone
        try {
          if (typeof FogAPI.setPlayerVisionTiles === 'function' && G.player?._visionTiles){
            FogAPI.setPlayerVisionTiles(G.player._visionTiles);
          }
        } catch(_) {}
      }

    window.SkyFX?.init?.({
    canvas,
    getCamera: () => camera,
    getMapAABB: () => ({ x:0, y:0, w:G.mapW*TILE_SIZE, h:G.mapH*TILE_SIZE }),
    worldToScreen: (x,y) => ({
      x: (x - camera.x) * camera.zoom + VIEW_W*0.5,
      y: (y - camera.y) * camera.zoom + VIEW_H*0.5
    })
  });

    // === Mouse click-to-move (activar mover con ratón) ===
    if (window.MouseNav && !window._mouseNavInited) {
      MouseNav.init({
        canvas: document.getElementById('gameCanvas'),
        camera,          // usa la cámara real del juego
        TILE,            // tamaño de tile (32)
        getMap:      () => G.map,                   // tu grid 0/1
        getEntities: () => G.entities,
        getPlayer:   () => G.player,
        isWalkable:  (tx,ty) => !!(G.map[ty] && G.map[ty][tx] === 0)
      });
      window._mouseNavInited = true; // evita crear múltiples listeners si reinicias nivel
    }

    // --- Parche para que MouseNav reconozca DOOR/CART con kind numérico ---
    if (window.MouseNav) {
      // 1) Qué consideras interactuable en tu juego
      const isInteractuable = (ent) => {
        if (!ent) return false;
        if (ent.kind === ENT.DOOR) return true;      // puertas
        if (ent.pushable === true) return true;      // carros/camas empujables
        return false;
      };

      // 2) Conectar el detector interno de MouseNav con lo anterior (sin romper nada)
      const _orig = MouseNav._isInteractable?.bind(MouseNav);
      MouseNav._isInteractable = (ent) => isInteractuable(ent) || (_orig ? _orig(ent) : false);

      // 3) Acción al llegar: abrir puerta / empujar carro
      MouseNav._performUse = (player, target) => {
        if (!target) return;
        if (target.kind === ENT.DOOR) {
          // abre/cierra cambiando solidez y color (tu puerta ya usa esto)
          target.solid = !target.solid;
          target.color = target.solid ? '#7f8c8d' : '#2ecc71';
          return;
        }
        if (target.pushable === true) {
          const dx = (target.x + target.w*0.5) - (player.x + player.w*0.5);
          const dy = (target.y + target.h*0.5) - (player.y + player.h*0.5);
          const L  = Math.hypot(dx,dy) || 1;
          const F  = (player.pushForce || FORCE_PLAYER);       // misma fuerza que tecla E
          const scale = 1 / Math.max(1, (target.mass || 1) * 0.5); // más pesado → menos empuje
          target.vx += (dx/L) * F * scale;
          target.vy += (dy/L) * F * scale;
        }
      };
    }

    //Init Audio
    /*
    AudioAPI.init({
      urls: {
        // deja los defaults o sobreescribe aquí tus rutas reales
        // ui_click: 'assets/sfx/ui_click.ogg', ...
      },
      vol: { master: 1, sfx: 0.95, ui: 1, ambient: 0.7, env: 0.9 },
      maxDistance: 520,
      minDistance: 48
    });*/
    // Compat: si alguien usa "Lighting", apunta al nuevo API
    window.Lighting = window.LightingAPI || window.Lighting || null;
    SkyFX.init({
      canvas: document.getElementById('gameCanvas'),
      getCamera: () => ({ x: camera.x, y: camera.y, zoom: camera.zoom }),
      getMapAABB: () => ({ x: 0, y: 0, w: G.mapW * TILE_SIZE, h: G.mapH * TILE_SIZE }),
      worldToScreen: (x,y) => ({
        x: (x - camera.x) * camera.zoom + VIEW_W * 0.5,
        y: (y - camera.y) * camera.zoom + VIEW_H * 0.5
      }),
      // AUDIO: siempre funciones
      //onStartRain: () => { try{ AudioFX?.loop('rain', true); }catch(e){} },
      //onStopRain : () => { try{ AudioFX?.stop('rain'); }catch(e){} },
      //onThunder  : () => { try{ AudioFX?.play('thunder'); }catch(e){} }
    });
    SkyFX.setLevel(G.level);   // ya estaba inicializado arriba

    // Spawners del nivel (solo una vez por arranque)
    initSpawnersForLevel();
    // === Física: vincular entidades del nivel ===
    Physics.init({
          restitution: 0.12,          // tope global de rebote (bajo)
          friction: 0.045,            // rozamiento estándar (menos desliz)
          slideFriction: 0.020,       // mojado resbala pero no “hielo”
          crushImpulse: 110,
          hurtImpulse: 45,
          explodeImpulse: 170
        }).bindGame(G);

    if (G.player && typeof G.player.hp === 'number') {
      G.healthMax = (G.player.hpMax|0) * 2;      // p.ej. Enrique: 5 corazones → 10 “halves”
      G.health    = Math.min(G.healthMax, (G.player.hp|0) * 2);
    }
  }


  function togglePause(){
    if (G.state==='PLAYING'){ G.state='PAUSED'; pausedScreen.classList.remove('hidden'); }
    else if (G.state==='PAUSED'){ G.state='PLAYING'; pausedScreen.classList.add('hidden'); }
  }

  document.getElementById('start-button')?.addEventListener('click', () => {
    // Dejar libre el manejador de click y ejecutar el arranque en el próximo frame
    requestAnimationFrame(() => startGame());
  });
  document.getElementById('resumeBtn')?.addEventListener('click', togglePause);
  document.getElementById('restartBtn')?.addEventListener('click', startGame);

  // Arranque
  requestAnimationFrame(loop);

  // Exponer algunas APIs esperadas por otros plugins/sistemas
  window.TILE_SIZE = TILE;
  window.ENT = ENT;                 // para plugins/sprites
  window.G = G;
  window.camera = camera;
  window.setCameraZoom = setCameraZoom;
  window.addCameraZoom = addCameraZoom;
  window.resetCameraView = resetCameraView;
  window.damagePlayer = damagePlayer; // ⬅️ EXponer daño del héroe para las ratas
  })();
// ==== DEBUG MINI-MAP OVERLAY =================================================
(function(){
  // Actívalo con ?mini=1 o definiendo window.DEBUG_MINIMAP = true en consola
  const enabled = /[?&]mini=1/.test(location.search) || window.DEBUG_MINIMAP === true;
  if (!enabled) return;

  const TILE = window.TILE_SIZE || window.TILE || 32;
  const VIEW_W = window.VIEW_W || 1024;
  const VIEW_H = window.VIEW_H || 768;

  let mm = document.getElementById('minimap');
  if (!mm) {
    mm = document.createElement('canvas');
    mm.id = 'minimap';
    mm.width = 256; mm.height = 256;
    mm.style.position = 'fixed';
    mm.style.right = '8px';
    mm.style.bottom = '8px';                // ⬅ abajo-derecha
    mm.style.zIndex = '48';                 // bajo HUD/overlays
    mm.style.background = 'transparent';    // sin opacidad
    mm.style.pointerEvents = 'none';        // no bloquea UI
    mm.style.imageRendering = 'pixelated';
    document.body.appendChild(mm);

    // oculto por defecto si no estás jugando
    mm.style.display = (window.G?.state === 'PLAYING') ? 'block' : 'none';
    // helper global para mostrar/ocultar
    window.__toggleMinimap = (on) => { mm.style.display = on ? 'block' : 'none'; };
  }
  const mctx = mm.getContext('2d');

  function colorFor(ent){
    const ENT = window.ENT || {};
    if (!ent) return '#ffffff';
    if (ent === (window.G && window.G.player)) return '#ffffff';
    if (ent.kind === ENT.DOOR) return '#9aa1a6';
    if (ent.kind === ENT.ELEVATOR) return '#3ddc97';
    if (ent.pushable === true) return '#b68c5a'; // carros/camas
    if (ent.isEnemy || ent.kind === ENT.MOSQUITO || ent.kind === ENT.RAT) return '#e74c3c';
    if (ent.isNPC) return '#5dade2';
    if (ent.kind === ENT.SPAWNER) return '#c27cf7';
    return '#fffd82';
  }

  function drawMinimap(){
    const G = window.G;
    if (!G || !G.map || !G.mapW || !G.mapH) { requestAnimationFrame(drawMinimap); return; }

    const w = G.mapW, h = G.mapH;
    const sx = mm.width  / w;
    const sy = mm.height / h;

    // Mapa base
    mctx.clearRect(0,0,mm.width,mm.height);
    for (let ty=0; ty<h; ty++){
      for (let tx=0; tx<w; tx++){
        const v = (G.map[ty] && G.map[ty][tx]) ? 1 : 0; // 1=pared, 0=suelo
        mctx.fillStyle = v ? '#1d1f22' : '#6b7280';
        mctx.fillRect(tx*sx, ty*sy, sx, sy);
      }
    }

    // Entidades (puntitos)
    const ents = (G.entities || []);
    for (const e of ents){
      const ex = (e.x || 0) / TILE;
      const ey = (e.y || 0) / TILE;
      mctx.fillStyle = colorFor(e);
      mctx.fillRect(ex*sx, ey*sy, Math.max(1,sx*0.85), Math.max(1,sy*0.85));
    }

    // Player
    if (G.player){
      const px = (G.player.x||0)/TILE, py = (G.player.y||0)/TILE;
      mctx.fillStyle = '#ffffff';
      mctx.fillRect(px*sx, py*sy, Math.max(1,sx), Math.max(1,sy));
    }

    // Frustum de cámara (rectángulo)
    const cam = window.camera || {x:0,y:0,zoom:1};
    const vwTiles = VIEW_W / (TILE*cam.zoom);
    const vhTiles = VIEW_H / (TILE*cam.zoom);
    const leftTiles = (cam.x/TILE) - vwTiles*0.5;
    const topTiles  = (cam.y/TILE) - vhTiles*0.5;
    mctx.strokeStyle = '#ffffff';
    mctx.lineWidth = 1;
    mctx.strokeRect(leftTiles*sx, topTiles*sy, vwTiles*sx, vhTiles*sy);

    requestAnimationFrame(drawMinimap);
  }
  drawMinimap();
})();
// ==== /DEBUG MINI-MAP OVERLAY ================================================
