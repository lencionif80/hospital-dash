// assets/plugins/mobile_layout.js
// ------------------------------------------------------
// Layout responsivo para "Il Divo: Hospital Dash!"
// - Ajusta el viewport para móvil/tablet
// - Escala el juego para que quepa en la pantalla
// - Muestra overlay pidiendo girar el móvil si está en vertical
// - No requiere cambios manuales en CSS ni en <meta>
// ------------------------------------------------------
(function () {
  // ⬇⬇⬇ AJUSTA ESTOS VALORES SI LO NECESITAS ⬇⬇⬇
  // Resolución lógica para la que está diseñado tu juego
  const DESIGN_WIDTH = 1280;  // ancho base del juego (px)
  const DESIGN_HEIGHT = 720;  // alto base del juego (px)
  // ⬆⬆⬆ AJUSTA ESTOS VALORES SI LO NECESITAS ⬆⬆⬆

  // Intenta localizar automáticamente el "contenedor" del juego.
  // Si no encuentra nada, usa <body>.
  const GAME_SELECTOR = '#game-container, #game, canvas, #wrapper, #root';

  function ensureViewportMeta() {
    var head = document.head || document.getElementsByTagName('head')[0];
    if (!head) return;

    var content = 'width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no';

    var meta = document.querySelector('meta[name="viewport"]');
    if (!meta) {
      meta = document.createElement('meta');
      meta.name = 'viewport';
      meta.content = content;
      head.appendChild(meta);
    } else {
      meta.content = content;
    }
  }

  function injectBaseStyles() {
    if (document.getElementById('mobile-layout-style')) return;

    var style = document.createElement('style');
    style.id = 'mobile-layout-style';
    style.type = 'text/css';
    style.textContent = `
      html, body {
        margin: 0;
        padding: 0;
        width: 100%;
        height: 100%;
        overflow: hidden;
        background: #000;
      }
      body {
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
        font-family: system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
        font-size: 18px;
        z-index: 9999;
        text-align: center;
        padding: 16px;
      }
      .mobile-orientation-overlay__icon {
        font-size: 64px;
        margin-bottom: 16px;
        animation: rotatePhone 1.5s infinite linear;
      }
      @keyframes rotatePhone {
        0% { transform: rotate(0deg); }
        50% { transform: rotate(90deg); }
        100% { transform: rotate(0deg); }
      }
    `;
    document.head.appendChild(style);
  }

  function findGameRoot() {
    var candidates = document.querySelectorAll(GAME_SELECTOR);
    for (var i = 0; i < candidates.length; i++) {
      var el = candidates[i];
      if (el && el.tagName) return el;
    }
    // Si no encontramos nada “mejor”, usamos <body>
    return document.body;
  }

  var gameRoot = null;

  function updateLayout() {
    if (!gameRoot) gameRoot = findGameRoot();
    if (!gameRoot) return;

    var isMobile = /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

    var vw = window.innerWidth;
    var vh = window.innerHeight;

    var isLandscape = vw >= vh;

    // --- Overlay para cuando el móvil está en vertical ---
    var overlay = document.getElementById('mobile-orientation-overlay');
    if (isMobile && !isLandscape) {
      if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'mobile-orientation-overlay';
        overlay.className = 'mobile-orientation-overlay';
        overlay.innerHTML = `
          <div class="mobile-orientation-overlay__icon">📱</div>
          <div>Por favor, gira el dispositivo a <strong>horizontal</strong> para jugar mejor.</div>
        `;
        document.body.appendChild(overlay);
      }
    } else if (overlay) {
      overlay.parentNode.removeChild(overlay);
    }

    // --- Cálculo del escalado manteniendo proporción ---
    var scaleX = vw / DESIGN_WIDTH;
    var scaleY = vh / DESIGN_HEIGHT;
    var scale = Math.min(scaleX, scaleY);

    var realWidth = DESIGN_WIDTH * scale;
    var realHeight = DESIGN_HEIGHT * scale;

    var offsetX = (vw - realWidth) / 2;
    var offsetY = (vh - realHeight) / 2;

    // Posicionamos y escalamos el contenedor del juego
    var style = gameRoot.style;
    style.position = 'absolute';
    style.left = offsetX + 'px';
    style.top = offsetY + 'px';
    style.width = DESIGN_WIDTH + 'px';
    style.height = DESIGN_HEIGHT + 'px';
    style.transformOrigin = '0 0';
    style.transform = 'scale(' + scale + ')';
  }

  function init() {
    ensureViewportMeta();
    injectBaseStyles();
    gameRoot = findGameRoot();
    updateLayout();

    window.addEventListener('resize', updateLayout);
    window.addEventListener('orientationchange', updateLayout);

    // Intento opcional de bloquear orientación en landscape (no siempre funciona).
    if (screen.orientation && screen.orientation.lock) {
      try {
        screen.orientation.lock('landscape').catch(function () {});
      } catch (err) {
        // Ignoramos errores silenciosamente
      }
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();