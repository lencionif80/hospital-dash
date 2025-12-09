// assets/plugins/mobile.js
// ------------------------------------------------------
// Adaptación móvil única para "Il Divo: Hospital Dash!"
// - Ajusta viewport y evita scroll/barras.
// - Corrige coordenadas táctiles/ratón con canvas escalado.
// - Precarga assets y muestra overlay de carga profesional.
// - Ofrece un botón opcional para pantalla completa.
// ------------------------------------------------------
(() => {
  'use strict';

  const d = document;
  const w = window;

  const canvas = d.getElementById('gameCanvas');
  const fog = d.getElementById('fogCanvas');
  const hud = d.getElementById('hudCanvas');
  const container = d.getElementById('game-container');
  const loadingScreen = d.getElementById('loading-screen');
  const loadingText = d.getElementById('loading-text');
  const loadingBar = d.getElementById('loading-bar');
  const fullscreenBtn = d.getElementById('btn-fullscreen');

  // Resolución lógica del juego (coincide con los atributos del canvas)
  const BASE_WIDTH = canvas ? canvas.width : 960;
  const BASE_HEIGHT = canvas ? canvas.height : 540;

  // ------------------------------------------------------
  // Utilidades de viewport y estilos base
  // ------------------------------------------------------
  function ensureViewportMeta() {
    const meta = d.querySelector('meta[name="viewport"]');
    const content = 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover';
    if (meta) {
      meta.setAttribute('content', content);
    } else {
      const m = d.createElement('meta');
      m.name = 'viewport';
      m.content = content;
      d.head.appendChild(m);
    }
  }

  function lockScrollAndSelection() {
    d.documentElement.style.overflow = 'hidden';
    d.body.style.overflow = 'hidden';
    d.body.style.touchAction = 'none';
    d.body.style.userSelect = 'none';
    d.body.style.WebkitUserSelect = 'none';
    d.body.classList.add('mobile-ready');
  }

  // ------------------------------------------------------
  // Redimensionado del canvas a pantalla completa
  // ------------------------------------------------------
  function resizeCanvasToViewport() {
    if (!canvas || !container) return;
    const vw = w.innerWidth;
    const vh = w.innerHeight;

    container.style.width = `${vw}px`;
    container.style.height = `${vh}px`;

    [canvas, fog, hud].forEach((c) => {
      if (!c) return;
      c.style.width = '100%';
      c.style.height = '100%';
      // Mantiene la resolución lógica original para no romper el motor.
      c.width = BASE_WIDTH;
      c.height = BASE_HEIGHT;
    });
  }

  // ------------------------------------------------------
  // Coordenadas precisas ratón/táctil sobre canvas escalado
  // ------------------------------------------------------
  function getPointerPos(evt, target = canvas) {
    if (!target) return { x: 0, y: 0 };
    const rect = target.getBoundingClientRect();
    const point = evt.touches ? evt.touches[0] : evt;
    const scaleX = target.width / rect.width;
    const scaleY = target.height / rect.height;
    const x = (point.clientX - rect.left) * scaleX;
    const y = (point.clientY - rect.top) * scaleY;
    return { x, y };
  }

  function patchMouseNavCoordinates() {
    const nav = w.MouseNav;
    if (!nav || nav._patchedForMobile) return;

    // Sobrescribe el conversor de pantalla->mundo respetando el escalado CSS.
    nav._screenToWorld = function (mx, my) {
      const r = this._canvas.getBoundingClientRect();
      const scaleX = this._canvas.width / r.width;
      const scaleY = this._canvas.height / r.height;
      const localX = (mx - r.left) * scaleX;
      const localY = (my - r.top) * scaleY;
      return {
        x: (localX - this._canvas.width * 0.5) / this._camera.zoom + this._camera.x,
        y: (localY - this._canvas.height * 0.5) / this._camera.zoom + this._camera.y,
      };
    };

    nav._patchedForMobile = true;
  }

  function bindTouchToMouseNav() {
    if (!canvas) return;

    const forward = (type, evt) => {
      if (!w.MouseNav || !w.MouseNav._canvas) return;
      const touch = evt.touches && evt.touches[0];
      if (!touch) return;
      const synthetic = {
        clientX: touch.clientX,
        clientY: touch.clientY,
        button: 0,
        preventDefault: () => evt.preventDefault(),
      };
      if (type === 'move' && typeof w.MouseNav._onMove === 'function') {
        w.MouseNav._onMove.call(w.MouseNav, synthetic);
      }
      if (type === 'down' && typeof w.MouseNav._onDown === 'function') {
        w.MouseNav._onDown.call(w.MouseNav, synthetic);
      }
    };

    canvas.addEventListener('touchstart', (evt) => {
      evt.preventDefault();
      forward('down', evt);
    });
    canvas.addEventListener('touchmove', (evt) => {
      evt.preventDefault();
      forward('move', evt);
    });
  }

  // ------------------------------------------------------
  // Loading profesional + precarga de assets
  // ------------------------------------------------------
  function buildAssetList() {
    const assets = [];
    const manifest = d.getElementById('sprites-manifest');
    if (manifest) {
      try {
        const list = JSON.parse(manifest.textContent || '[]');
        list.forEach((name) => assets.push(`assets/images/${name}`));
      } catch (_) {}
    }

    const musicFiles = [
      'Mini_boss1.mp3',
      'boss_final_parteA.mp3',
      'boss_final_parteB.mp3',
      'boss_nivel1.mp3',
      'boss_nivel2.mp3',
      'creditos_finales .mp3',
      'huida_del_fuego.mp3',
      'intro.mp3',
      'mini_boss2.mp3',
      'mini_boss3.mp3',
      'nivel1.mp3',
      'nivel2.mp3',
      'nivel3.mp3',
      'pagina_principal.mp3',
      'pantalla_de_puntuación .mp3',
      'pre_final_boss.mp3',
    ];
    musicFiles.forEach((file) => assets.push(`assets/music/${file}`));

    return [...new Set(assets)];
  }

  function showLoading() {
    loadingScreen?.classList.remove('hidden');
    d.body.classList.add('is-loading');
  }

  function hideLoading() {
    loadingScreen?.classList.add('hidden');
    d.body.classList.remove('is-loading');
  }

  function updateLoading(progress) {
    if (loadingBar) loadingBar.style.width = `${Math.round(progress * 100)}%`;
    if (loadingText) loadingText.textContent = `Cargando... ${Math.round(progress * 100)}%`;
  }

  function preloadAssets(onComplete) {
    const list = buildAssetList();
    if (!list.length) {
      updateLoading(1);
      hideLoading();
      onComplete?.({});
      return;
    }

    let loaded = 0;
    const total = list.length;
    const cache = {};

    const onItemDone = (src, asset) => {
      cache[src] = asset;
      loaded += 1;
      updateLoading(loaded / total);
      if (loaded >= total) {
        hideLoading();
        onComplete?.(cache);
      }
    };

    list.forEach((src) => {
      const ext = src.split('.').pop()?.toLowerCase();
      if (!ext) return onItemDone(src, null);

      if (['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext)) {
        const img = new Image();
        img.onload = () => onItemDone(src, img);
        img.onerror = () => onItemDone(src, null);
        img.src = src;
      } else if (['mp3', 'ogg', 'wav'].includes(ext)) {
        const audio = new Audio();
        audio.oncanplaythrough = () => onItemDone(src, audio);
        audio.onerror = () => onItemDone(src, null);
        audio.src = src;
        audio.load();
      } else {
        onItemDone(src, null);
      }
    });
  }

  // ------------------------------------------------------
  // Pantalla completa opcional
  // ------------------------------------------------------
  function bindFullscreenButton() {
    if (!fullscreenBtn) return;
    const isCapable = !!(d.fullscreenEnabled || d.webkitFullscreenEnabled || d.msFullscreenEnabled);
    if (!isCapable) {
      fullscreenBtn.classList.add('hidden');
      return;
    }
    fullscreenBtn.addEventListener('click', () => {
      const elem = d.documentElement;
      const req =
        elem.requestFullscreen || elem.webkitRequestFullscreen || elem.msRequestFullscreen;
      if (req) req.call(elem);
    });
  }

  // ------------------------------------------------------
  // Arranque del flujo móvil
  // ------------------------------------------------------
  function initMobileLayer() {
    ensureViewportMeta();
    lockScrollAndSelection();
    resizeCanvasToViewport();
    w.addEventListener('resize', resizeCanvasToViewport);
    w.addEventListener('orientationchange', resizeCanvasToViewport);

    patchMouseNavCoordinates();
    bindTouchToMouseNav();
    bindFullscreenButton();

    showLoading();
    preloadAssets(() => {
      hideLoading();
      // Tras la precarga ajustamos de nuevo por si el viewport cambió durante la carga.
      resizeCanvasToViewport();
    });
  }

  if (d.readyState === 'loading') {
    d.addEventListener('DOMContentLoaded', initMobileLayer, { once: true });
  } else {
    initMobileLayer();
  }
})();
