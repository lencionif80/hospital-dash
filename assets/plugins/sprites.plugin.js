/* ============================================================================
 *  Il Divo - SpritesAPI (Atlas + Dibujado + Suelo/Pared + Visor)
 *  - Carga unificada de sprites desde ./assets/images/
 *  - Manifest por orden: <script id="sprites-manifest"> (inline) -> fetch('manifest.json')
 *  - Tolerante: si faltan imágenes, NO revienta (Promise.allSettled).
 *  - Dibujo del suelo ajedrezado y de las paredes (tiles: 'suelo.png'/'pared.png').
 *  - Asignación automática de sprite por entidad (usa window.ENT si existe).
 *  - Visor de sprites (F9) con miniaturas y nombres.
 *  - Sin getImageData (evita "tainted canvas" en file://). Tintes por composición.
 * ========================================================================== */
(function (global) {
  'use strict';

  const TAU = Math.PI * 2;

  const Sprites = {
    _opts: { basePath: './assets/images/', tile: 32 },
    _imgs: Object.create(null),       // mapa: key -> HTMLImageElement/Canvas
    _keys: [],                        // lista de keys cargadas (orden del manifest)
    _ready: false,
    _viewer: { enabled: false, page: 0, perRow: 10, thumb: 48 },
    _isHttp: /^https?:/i.test(location.protocol),
    _base: function(){ return this._opts.basePath.replace(/\/+$/,'') + '/'; },

    init(opts = {}) {
      this._opts = { ...this._opts, ...opts };
      // toggle visor con F9
      window.addEventListener('keydown', (e) => {
        if (e.key === 'F9' || e.key === 'f9') {
          this._viewer.enabled = !this._viewer.enabled;
        }
      });
      global.Sprites = this; // expón por si otros scripts lo necesitan
      return this;
    },

    // -----------------------------
    // PRELOAD (tolerante a fallos)
    // -----------------------------
    async preload() {
      const names = await this._pathsFromManifest(); // nombres ('.png'/.jpg)
      const paths = names.map(n => this._base() + n);

      const results = await Promise.allSettled(paths.map(p => this._loadImage(p)));
      const ok = results.filter(r => r.status === 'fulfilled').map(r => r.value);
      const ko = results.filter(r => r.status === 'rejected');

      if (ko.length) {
        console.warn('[Sprites] Algunas rutas fallaron (continuamos):', ko.map(k => k.reason?.url || k.reason));
      }

      // indexa por clave "limpia" (nombre sin extensión)
      for (const it of ok) {
        const key = this._keyFromUrl(it.src);
        this._imgs[key] = it;
        if (!this._keys.includes(key)) this._keys.push(key);
      }

      // variantes suaves para el suelo (ajedrez claro/oscuro) sin getImageData
      if (this._imgs['suelo']) {
        this._imgs['suelo_claro'] = this._makeTintComposite(this._imgs['suelo'], 'screen', 'rgba(255,255,255,0.22)');
        this._imgs['suelo_oscuro'] = this._makeTintComposite(this._imgs['suelo'], 'multiply', 'rgba(0,0,0,0.18)');
      }
      // por si faltase, crea un placeholder generico
      if (!this._imgs['suelo']) this._imgs['suelo'] = this._makePlaceholder('#546e7a');
      if (!this._imgs['pared']) this._imgs['pared'] = this._makePlaceholder('#8d6e63');

      this._ready = true;
    },

    async _pathsFromManifest() {
      // 1) Inline: <script id="sprites-manifest" type="application/json">[...]</script>
      const inline = document.getElementById('sprites-manifest');
      if (inline && inline.textContent.trim().length) {
        try {
          const arr = JSON.parse(inline.textContent.trim());
          if (Array.isArray(arr) && arr.length) return arr;
        } catch (e) {
          console.warn('[Sprites] manifest inline JSON inválido:', e);
        }
      }

      // 2) Global (por si lo inyectas en otro script): window.SPRITES_MANIFEST = [...]
      if (Array.isArray(global.SPRITES_MANIFEST) && global.SPRITES_MANIFEST.length) {
        return global.SPRITES_MANIFEST.slice();
      }

      // 3) fetch('manifest.json') — solo si NO estás en file://
      if (this._isHttp) {
        try {
          const url = this._base() + 'manifest.json';
          const res = await fetch(url, { cache: 'no-cache' });
          const json = await res.json();
          if (Array.isArray(json) && json.length) return json;
        } catch (e) {
          console.warn('[Sprites] manifest error:', e);
        }
      } else {
        console.warn('[Sprites] Estás en file:// → no se puede hacer fetch(manifest.json). Usa el manifest inline.');
      }

      // 4) Fallback vacío (seguimos; dibujaremos placeholders si faltan)
      return [];
    },

    _loadImage(url) {
      return new Promise((resolve, reject) => {
        const img = new Image();
        // Solo pedimos CORS cuando estamos en http(s). En file:// no toques crossOrigin.
        if (this._isHttp) img.crossOrigin = 'anonymous';
        img.onload = () => resolve(img);
        img.onerror = (ev) => reject({ url, ev });
        img.src = url;
      });
    },

    _keyFromUrl(src) {
      const file = src.split('/').pop().split('?')[0];
      return file.replace(/\.(png|jpg|jpeg|gif)$/i, '').toLowerCase();
    },

    _normalizeKey(name) {
      if (!name) return '';
      const str = String(name).trim();
      if (!str) return '';
      const file = str.split('/').pop().split('?')[0];
      return file.replace(/\.(png|jpg|jpeg|gif)$/i, '').toLowerCase();
    },

    _makePlaceholder(color = '#777') {
      const t = this._opts.tile|0 || 32;
      const c = document.createElement('canvas');
      c.width = t; c.height = t;
      const g = c.getContext('2d');
      g.fillStyle = color;
      g.fillRect(0, 0, t, t);
      g.strokeStyle = 'rgba(255,255,255,0.25)';
      g.beginPath();
      g.moveTo(0,0); g.lineTo(t,t); g.moveTo(t,0); g.lineTo(0,t); g.stroke();
      return c;
    },

    // “Tinte” por composición (sin getImageData → compatible con file://)
    _makeTintComposite(img, mode, color) {
      const c = document.createElement('canvas');
      c.width = img.width; c.height = img.height;
      const g = c.getContext('2d');
      g.drawImage(img, 0, 0);
      g.globalCompositeOperation = mode;   // 'screen' (aclara), 'multiply' (oscurece)
      g.fillStyle = color;
      g.fillRect(0, 0, c.width, c.height);
      g.globalCompositeOperation = 'source-over';
      return c;
    },

    // ---------------------------------------------------------
    // DIBUJO DEL MUNDO: suelo ajedrezado + paredes + entidades
    // ---------------------------------------------------------
    drawFloorAndWalls(ctx, G) {
      if (!G || !Array.isArray(G.map)) return;
      const fallbackTile = (this._opts.tile|0) || (global.TILE_SIZE|0) || 32;
      const tile = Number.isFinite(G?.TILE_SIZE) && G.TILE_SIZE > 0 ? G.TILE_SIZE : fallbackTile;
      const gridToWorld = (global.GridMath && typeof global.GridMath.gridToWorld === 'function')
        ? global.GridMath.gridToWorld
        : ((tx, ty) => ({ x: tx * tile, y: ty * tile }));
      const mapH = Number.isFinite(G?.mapH) && G.mapH > 0 ? G.mapH : (Array.isArray(G.map) ? G.map.length : 0);
      const mapW = Number.isFinite(G?.mapW) && G.mapW > 0 ? G.mapW : (mapH > 0 && Array.isArray(G.map[0]) ? G.map[0].length : 0);
      if (!mapW || !mapH) return;

      let minX = 0;
      let maxX = mapW - 1;
      let minY = 0;
      let maxY = mapH - 1;

      if (!G.isDebugMap && G.player) {
        const radiusValue = Number(G.culling);
        const radius = Math.max(0, Math.ceil(Number.isFinite(radiusValue) && radiusValue > 0 ? radiusValue : 20));
        const playerTileX = Math.max(0, Math.min(mapW - 1, Math.floor((Number(G.player.x) || 0) / tile)));
        const playerTileY = Math.max(0, Math.min(mapH - 1, Math.floor((Number(G.player.y) || 0) / tile)));
        minX = Math.max(0, playerTileX - radius);
        maxX = Math.min(mapW - 1, playerTileX + radius);
        minY = Math.max(0, playerTileY - radius);
        maxY = Math.min(mapH - 1, playerTileY + radius);
        if (minX > maxX || minY > maxY) {
          minX = 0; maxX = mapW - 1; minY = 0; maxY = mapH - 1;
        }
      }

      for (let y = minY; y <= maxY; y++) {
        const row = G.map[y];
        for (let x = minX; x <= maxX; x++) {
          const pos = gridToWorld(x, y);
          const px = pos.x;
          const py = pos.y;
          const isWall = !!(row && row[x]);
          if (isWall) {
            const img = this._imgs['pared'];
            img ? ctx.drawImage(img, px, py, tile, tile) : (ctx.fillStyle='#5d4037', ctx.fillRect(px,py,tile,tile));
          } else {
            const shade = Array.isArray(G.floorColors) ? (G.floorColors[y]?.[x] || null) : null;
            const baseShade = (shade && typeof shade === 'object') ? shade.base : shade;
            const overlay = (shade && typeof shade === 'object') ? shade.overlay : null;
            const overlayMode = (shade && typeof shade === 'object') ? (shade.overlayMode || 'screen') : 'screen';
            const tileAlpha = (shade && typeof shade === 'object' && typeof shade.tileAlpha === 'number')
              ? shade.tileAlpha
              : (baseShade ? 0.86 : 1);
            if (baseShade) {
              ctx.fillStyle = baseShade;
              ctx.fillRect(px, py, tile, tile);
            }
            // ajedrez (clarito/normal)
            const useLight = ((x + y) & 1) === 0;
            const img = useLight ? (this._imgs['suelo_claro'] || this._imgs['suelo'])
                                 : (this._imgs['suelo_oscuro'] || this._imgs['suelo']);
            if (img) {
              if (tileAlpha < 1) ctx.globalAlpha = tileAlpha;
              ctx.drawImage(img, px, py, tile, tile);
              if (tileAlpha < 1) ctx.globalAlpha = 1;
            } else {
              ctx.fillStyle='#37474f';
              ctx.fillRect(px,py,tile,tile);
            }
            // Overlay final encima del shading y del ajedrez para que el color se lea con niebla/luz.
            if (overlay) {
              const overlayAlpha = typeof shade.overlayAlpha === 'number' ? shade.overlayAlpha : 1;
              ctx.globalCompositeOperation = overlayMode || 'screen';
              ctx.globalAlpha = overlayAlpha;
              ctx.fillStyle = overlay;
              ctx.fillRect(px, py, tile, tile);
              ctx.globalAlpha = 1;
              ctx.globalCompositeOperation = 'source-over';
            }
          }
        }
      }
    },

    drawEntity(ctx, e) {
      if (!e || e.dead) return;

      if (e._debugSpawnPlaceholder || e.placeholder === true) {
        const G = global.G || null;
        const cam = G && G.camera;
        const screenX = cam ? (e.x - cam.x) : e.x;
        const screenY = cam ? (e.y - cam.y) : e.y;
        const halfW = (e.w || (global.TILE_SIZE || 32)) * 0.5;
        const halfH = (e.h || (global.TILE_SIZE || 32)) * 0.5;

        const bg = e._debugColor || '#ff3366';
        const fg = (typeof global.pickDebugTextColor === 'function')
          ? global.pickDebugTextColor(bg)
          : '#ffffff';

        ctx.save();
        ctx.translate(screenX, screenY);

        ctx.fillStyle = bg;
        ctx.globalAlpha = 0.95;
        ctx.fillRect(-halfW, -halfH, halfW * 2, halfH * 2);

        ctx.strokeStyle = '#000000';
        ctx.lineWidth = 2;
        ctx.strokeRect(-halfW, -halfH, halfW * 2, halfH * 2);

        ctx.fillStyle = fg;
        ctx.font = 'bold 18px monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(e._debugChar || '?', 0, 0);

        ctx.restore();
        return;
      }

      const rawKey = this._keyForEntity(e) || '';
      const key = this._normalizeKey(rawKey);
      const img = this._imgs[key];

      // Fallback seguro si no hay sprite
      if (!img) {
        this._drawVectorFallback(ctx, e);
        return;
      }
      ctx.drawImage(img, e.x|0, e.y|0, e.w|0, e.h|0);
    },

    _drawVectorFallback(ctx, e) {
      const w = (e.w || this._opts.tile || 32);
      const h = (e.h || Math.max(36, w * 1.4));
      const cx = (e.x || 0) + w * 0.5;
      const cy = (e.y || 0) + h * 0.5;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.fillStyle = e.color || '#566074';
      ctx.beginPath();
      ctx.ellipse(0, -h * 0.25, w * 0.28, h * 0.32, 0, 0, TAU);
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(-w * 0.26, -h * 0.08);
      ctx.quadraticCurveTo(0, h * 0.12, w * 0.26, -h * 0.08);
      ctx.quadraticCurveTo(w * 0.3, h * 0.32, 0, h * 0.4);
      ctx.quadraticCurveTo(-w * 0.3, h * 0.32, -w * 0.26, -h * 0.08);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = 'rgba(0,0,0,0.22)';
      ctx.beginPath();
      ctx.ellipse(0, h * 0.45, w * 0.34, h * 0.18, 0, 0, TAU);
      ctx.fill();
      ctx.restore();
    },

    // Mapea entidad → nombre de sprite (por defecto)
    _keyForEntity(e) {
      // Si la entidad ya trae spriteKey/skin, úsalo
      if (e.spriteKey) return e.spriteKey;
      if (e.skin) return e.skin;

      const ENT = global.ENT || {};
      switch (e.kind) {
        case ENT.PLAYER:   return ''; // el jugador lo dibuja PuppetAPI
        case ENT.MOSQUITO: return 'mosquito';
        case ENT.RAT:      return 'raton';
        case ENT.CART: {
          // Prioriza sprite explícito si la factoría lo puso
          const s = (e.spriteKey || e.skin || '').toLowerCase();
          if (s) return s;

          // Si viene como subtipo / tipo (placement o factoría)
          const sub = (e.sub || e.type || '').toLowerCase();
          if (sub.includes('food') || sub.includes('comida')) return 'carro_comida';
          if (sub.includes('med')  || sub.includes('medic'))  return 'carro_medicinas';
          if (sub.includes('urg')  || sub.includes('er'))     return 'carro_urgencias';

          // Por defecto: medicación
          return 'carro_medicinas';
        }
        case ENT.PATIENT: return (e.spriteKey || e.skin || 'paciente_en_cama');
        case ENT.BOSS: {
          // Usa sprite explícito si lo trae la factoría; si no, primer boss del manifiesto
          const s = (e.spriteKey || e.skin || '').toLowerCase();
          return s || 'boss_nivel1';
        }
        case ENT.PILL: {
          // Si la factoría ya puso sprite/skin, respétalo; si trae "name" mapea a pastilla_<name>
          if (e.spriteKey || e.skin) return (e.spriteKey || e.skin);
          const n = (e.name || e.label || 'azul').toLowerCase();
          return 'pastilla_' + n;
        }
        case ENT.DOOR: {
          // La puerta de boss la pone su API; si no trae skin, usa un genérico si lo tienes o deja fallback
          return (e.spriteKey || e.skin || '');
        }
        case ENT.LIGHT:   return 'light_1';

        // ✅ Soporta NPC genérico (si tu ENT tiene .NPC)
        case ENT.NPC: {
          // Usa lo que haya: spriteKey / skin / rol
          const k = (e.spriteKey || e.skin || e.role || '').toLowerCase();
          if (k) return k;
          // fallback razonable
          return 'medico';
        };
        default:           return ''; // que pinte fallback
      }
    },

    // HUD / overlays opcionales del visor de sprites (F9)
    renderOverlay(ctx) {
      if (!this._viewer.enabled) return;
      const { thumb, perRow } = this._viewer;
      const PAD = 8, y0 = 8;

      // fondo
      ctx.save();
      ctx.globalAlpha = 0.9;
      ctx.fillStyle = '#0b0d10';
      ctx.fillRect(6, 6, (thumb+PAD)*perRow + 16, 360);
      ctx.globalAlpha = 1;

      // título
      ctx.fillStyle = '#e6edf3';
      ctx.font = '12px monospace';
      ctx.fillText('SPRITES VIEWER (F9 para ocultar) — ' + this._keys.length + ' sprites', 12, y0 + 12);

      // grid
      let x = 12, y = y0 + 24, col = 0;
      for (const k of this._keys) {
        const img = this._imgs[k];
        if (img) ctx.drawImage(img, x, y, thumb, thumb);
        ctx.strokeStyle = 'rgba(255,255,255,0.18)';
        ctx.strokeRect(x+0.5, y+0.5, thumb, thumb);

        // nombre
        ctx.fillStyle = '#cfd8dc';
        ctx.fillText(k, x, y + thumb + 12);

        col++;
        x += thumb + PAD;
        if (col >= perRow) { col = 0; x = 12; y += thumb + 28; }
        if (y > 330) break; // cabe en la caja
      }
      ctx.restore();
    }
  };

  // API pública
  global.Sprites = Sprites;

})(window);