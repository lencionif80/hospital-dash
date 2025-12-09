// assets/plugins/mobile_layout.js
// ------------------------------------------------------
// Layout responsivo para "Il Divo: Hospital Dash!"
// - Bloquea PORTRAIT en móvil/tablet con overlay a pantalla completa.
// - Escala y centra el contenedor principal para que el start-screen quepa
//   entero en horizontal manteniendo proporción de 16:9 (ajusta DESIGN_* si cambia).
// - En escritorio no toca nada.
// ------------------------------------------------------
(() => {
  'use strict';

  // Resolución lógica para la que está diseñada la UI del start-screen.
  // Si tu maqueta cambia, ajusta estos valores para recalcular el escalado.
  const DESIGN_WIDTH = 1280;
  const DESIGN_HEIGHT = 720;

  // Selectores para localizar el contenedor real del juego/start-screen.
  // El primero que exista se usa como raíz a escalar.
  const GAME_SELECTOR = '#start-screen, #game-container, #game, canvas, #wrapper, #root';

  const d = document;
  const w = window;

  let gameRoot = null;

  // ---------------------------------------------
  // Detección de móvil/tablet y orientación.
  // - UA + maxTouchPoints evitan falsos positivos en escritorio táctil.
  // - La orientación se calcula comparando ancho/alto visibles del viewport.
  // ---------------------------------------------
  function isMobileDevice() {
    const ua = navigator.userAgent || '';
    const hasTouch = navigator.maxTouchPoints && navigator.maxTouchPoints > 1;
    const looksLikeMobile = /Mobi|Android|iPhone|iPad|iPod|Tablet/i.test(ua);
    return looksLikeMobile || (hasTouch && Math.max(screen.width, screen.height) <= 1366);
  }

  function isLandscape() {
    return w.innerWidth >= w.innerHeight;
  }

  function getViewportSize() {
    const vv = w.visualViewport;
    return {
      vw: w.innerWidth,
      vh: vv ? vv.height : w.innerHeight,
    };
  }

  // ---------------------------------------------
  // Viewport meta + estilos base necesarios para
  // bloquear scroll y dibujar el overlay de orientación.
  // ---------------------------------------------
  function ensureViewportMeta() {
    const content = 'width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover';
    let meta = d.querySelector('meta[name="viewport"]');
    if (!meta) {
      meta = d.createElement('meta');
      meta.name = 'viewport';
      meta.content = content;
      d.head.appendChild(meta);
    } else {
      meta.setAttribute('content', content);
    }
  }

  function injectBaseStyles() {
    if (d.getElementById('mobile-layout-style')) return;
    const style = d.createElement('style');
    style.id = 'mobile-layout-style';
    style.textContent = `
      html.mobile-layout-locked, body.mobile-layout-locked {
        width: 100%; height: 100%; margin: 0; padding: 0;
        overflow: hidden !important;
        background: #000;
      }
      body.mobile-layout-locked {
        touch-action: none;
        -webkit-user-select: none;
        user-select: none;
      }
      .mobile-orientation-overlay {
        position: fixed;
        inset: 0;
        background: #000;
        color: #fff;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        text-align: center;
        padding: 20px;
        font-family: system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
        font-size: 18px;
        z-index: 2147483647;
        pointer-events: auto;
      }
      .mobile-orientation-overlay__icon {
        font-size: 72px;
        margin-bottom: 16px;
        animation: rotatePhone 1.5s infinite linear;
      }
      @keyframes rotatePhone {
        0% { transform: rotate(0deg); }
        50% { transform: rotate(90deg); }
        100% { transform: rotate(0deg); }
      }
    `;
    d.head.appendChild(style);
  }

  // ---------------------------------------------
  // Helpers de overlay "gira el móvil" (portrait bloqueado).
  // ---------------------------------------------
  function getOverlay() {
    return d.getElementById('mobile-orientation-overlay');
  }

  function showOverlay() {
    let overlay = getOverlay();
    if (!overlay) {
      overlay = d.createElement('div');
      overlay.id = 'mobile-orientation-overlay';
      overlay.className = 'mobile-orientation-overlay';
      overlay.innerHTML = `
        <div class="mobile-orientation-overlay__icon">📱</div>
        <div>Por favor, gira el dispositivo a <strong>horizontal</strong> para jugar.</div>
      `;
      d.body.appendChild(overlay);
    }
    overlay.style.display = 'flex';
    d.body.classList.add('mobile-layout-locked');
    d.documentElement.classList.add('mobile-layout-locked');
    if (gameRoot) gameRoot.style.pointerEvents = 'none';
  }

  function hideOverlay() {
    const overlay = getOverlay();
    if (overlay) overlay.style.display = 'none';
    d.body.classList.add('mobile-layout-locked');
    d.documentElement.classList.add('mobile-layout-locked');
    if (gameRoot) gameRoot.style.pointerEvents = '';
  }

  // ---------------------------------------------
  // Localiza el contenedor raíz a escalar
  // ---------------------------------------------
  function findGameRoot() {
    const candidates = d.querySelectorAll(GAME_SELECTOR);
    for (let i = 0; i < candidates.length; i++) {
      const el = candidates[i];
      if (el) return el;
    }
    return d.body;
  }

  // ---------------------------------------------
  // Calcula el escalado para que la start-screen
  // encaje entera en el viewport horizontal móvil.
  // Mantiene proporción usando la maqueta DESIGN_*.
  // ---------------------------------------------
  function applyScaleToGame() {
    if (!gameRoot) return;
    const { vw, vh } = getViewportSize();

    // Escalado proporcional tomando como base el diseño 16:9.
    const scaleX = vw / DESIGN_WIDTH;
    const scaleY = vh / DESIGN_HEIGHT;
    const scale = Math.min(scaleX, scaleY);

    // Dimensión real tras escalar y centrado.
    const realWidth = DESIGN_WIDTH * scale;
    const realHeight = DESIGN_HEIGHT * scale;
    const offsetX = (vw - realWidth) / 2;
    const offsetY = (vh - realHeight) / 2;

    const style = gameRoot.style;
    style.position = 'fixed';
    style.left = `${offsetX}px`;
    style.top = `${offsetY}px`;
    style.width = `${DESIGN_WIDTH}px`;
    style.height = `${DESIGN_HEIGHT}px`;
    style.transformOrigin = '0 0';
    style.transform = `scale(${scale})`;
  }

  function resetGameTransform() {
    if (!gameRoot) return;
    const style = gameRoot.style;
    style.position = '';
    style.left = '';
    style.top = '';
    style.width = '';
    style.height = '';
    style.transformOrigin = '';
    style.transform = '';
    style.pointerEvents = '';
  }

  // ---------------------------------------------
  // Main loop: solo aplica en móvil/tablet.
  // En portrait: overlay bloquea todo.
  // En landscape: se oculta overlay y se recalcula escala.
  // ---------------------------------------------
  function updateLayout() {
    if (!gameRoot) gameRoot = findGameRoot();
    if (!gameRoot) return;

    const mobile = isMobileDevice();
    const landscape = isLandscape();

    if (!mobile) {
      // Escritorio: sin bloqueo ni escalado forzado.
      hideOverlay();
      resetGameTransform();
      d.body.classList.remove('mobile-layout-locked');
      d.documentElement.classList.remove('mobile-layout-locked');
      return;
    }

    if (!landscape) {
      showOverlay();
      resetGameTransform();
      return;
    }

    hideOverlay();
    applyScaleToGame();
  }

  function init() {
    ensureViewportMeta();
    injectBaseStyles();
    gameRoot = findGameRoot();
    updateLayout();

    w.addEventListener('resize', updateLayout);
    w.addEventListener('orientationchange', updateLayout);
    if (w.visualViewport) {
      w.visualViewport.addEventListener('resize', updateLayout);
    }

    // Intento opcional de forzar landscape (no todos los navegadores lo permiten).
    if (screen.orientation && screen.orientation.lock) {
      try {
        screen.orientation.lock('landscape').catch(() => {});
      } catch (err) {
        // Ignorado: algunos navegadores lo bloquean.
      }
    }
  }

  if (d.readyState === 'loading') {
    d.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
