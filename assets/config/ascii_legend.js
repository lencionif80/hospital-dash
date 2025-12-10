(function (W) {
  'use strict';

  const root = typeof W !== 'undefined' ? W : window;

  // Tabla ASCII centralizada y única. Los caracteres oficiales son:
  //   Terreno: '#' muro, '.' suelo, '-' control, ';' boss, ',' miniboss, ' ' vacío
  //   Spawns:  'S' héroe, 'X' boss, 'M' miniboss
  //   Objetos críticos: 'd' puerta normal, 'u' puerta boss/urgencias, 'E' ascensor,
  //     'T' teléfono, 'b' timbre, 'p' cama con paciente, 'i' pastilla vinculada,
  //     'F' carro comida, 'U' carro urgencias, '+' carro medicinas
  //   Spawns genéricos: 'N' NPC, 'A' animal, 'C' carro, 'o' loot aleatorio
  //   Enemigos/otros: 'm' mosquito, 'r' rata, 'x' fuego, '~' agua, 'e' extintor
  //   Recompensas: '$' moneda, '%' bolsa, '1/2/3' jeringas, '4/5/6' goteros, 'y/Y' comida
  //   NPC manuales: 'J' jefe, 'H' supervisora, 'k' médico, 't' TCAE, 'c' celador,
  //     'n' enfermera sexy, 'h' limpieza, 'g' guardia, 'v' familiar
  //   Extras: 'B' cama vacía, 'P' paciente furioso (debug), 'L/l' luces
  // Caracteres descartados: 'D' (puerta antigua), variaciones de pacientes/loot sin
  // normalizar. Los mapas debug y generador usan únicamente los símbolos oficiales.

  // Tintes muy saturados para que destaquen incluso con la iluminación y la niebla.
  const TINT_COLORS = {
    blue: 0x4dbdff,
    green: 0x4dff88,
    red: 0xff4d4d
  };

  const LEGEND = {
    // Terreno / fuera del mapa
    '#': { key: 'wall',        kind: 'wall',        blocking: true },
    '.': { key: 'floor',       kind: 'floor',       factoryKey: 'floor_normal', blocking: false, isWalkable: true, color: '#1b262f' },
    '-': { key: 'floor_control', kind: 'floor_control', baseKind: 'floor', factoryKey: 'floor_control', blocking: false, isWalkable: true, specialRoom: 'control', tint: 'blue', color: '#123b5c' },
    ';': { key: 'floor_boss',    kind: 'floor_boss',    baseKind: 'floor', factoryKey: 'floor_boss', blocking: false, isWalkable: true, specialRoom: 'boss', tint: 'red', color: '#4a1010' },
    ',': { key: 'floor_miniboss',kind: 'floor_miniboss',baseKind: 'floor', factoryKey: 'floor_miniboss', blocking: false, isWalkable: true, specialRoom: 'miniboss', tint: 'green', color: '#0f3d26' },
    ' ': { key: 'void',        kind: 'void',        blocking: false },

    // Posición del héroe / puntos especiales
    'S': { key: 'hero_spawn',  kind: 'hero_spawn',      factoryKey: 'hero_spawn', isSpawn: true },
    'X': { key: 'boss_main',   kind: 'boss_main',       factoryKey: 'boss_main_spawn', isBoss: true },
    'M': { key: 'mini_boss',   kind: 'mini_boss',       factoryKey: 'mini_boss_spawn', isMiniBoss: true },

    // Teléfono de control room
    'T': { key: 'phone_central', kind: 'phone',     factoryKey: 'phone_central' },

    // Luces
    'L': { key: 'light_ok',    kind: 'light_ok',    factoryKey: 'light_ok' },
    'l': { key: 'light_broken',kind: 'light_broken',factoryKey: 'light_broken' },

    // Pacientes
    'p': { key: 'patient_bed', kind: 'patient_bed', factoryKey: 'patient_normal', isPatient: true },
    'f': { key: 'patient_fury',kind: 'patient_fury',factoryKey: 'patient_furious_debug', isPatient: true },

    // Timbre asociado
    'b': { key: 'bell',        kind: 'bell',        factoryKey: 'bell_patient', isTrigger: true },

    // Puertas
    'd': { key: 'door_normal', kind: 'door_normal', factoryKey: 'door_normal', blocking: false, isWalkable: true, isDoor: true },
    'u': { key: 'door_boss',   kind: 'door_boss',   factoryKey: 'door_urgencias', blocking: false, isWalkable: true, isDoor: true, bossDoor: true },

    // Spawns abstractos según level_rules
    'N': { key: 'spawn_npc',   kind: 'spawn_npc',   factoryKey: 'spawn_npc_human', isSpawn: true },
    'A': { key: 'spawn_animal',kind: 'spawn_animal',factoryKey: 'spawn_enemy_animal', isSpawn: true },
    'C': { key: 'spawn_cart',  kind: 'spawn_cart',  factoryKey: 'spawn_cart', isSpawn: true },

    // Carros colocados directamente
    'F': { key: 'cart_food',      kind: 'cart_food',      factoryKey: 'cart_food', isCart: true },
    'U': { key: 'cart_emergency', kind: 'cart_emergency', factoryKey: 'cart_emergency', isCart: true },
    '+': { key: 'cart_meds',      kind: 'cart_meds',      factoryKey: 'cart_meds', isCart: true },

    // Camas sueltas (sin paciente)
    'B': { key: 'bed',            kind: 'bed',            factoryKey: 'bed_empty' },

    // Enemigos animales
    'm': { key: 'mosquito',       kind: 'mosquito',       factoryKey: 'npc_mosquito', isEnemy: true },
    'r': { key: 'rat',            kind: 'rat',            factoryKey: 'npc_rat',      isEnemy: true },

    // Paciente furioso colocado directamente
    'P': { key: 'furious_patient',kind: 'furious_patient',factoryKey: 'npc_furious_patient', isEnemy: true },

    // NPC humanos concretos (colocados manualmente)
    'J': { key: 'npc_jefe',        kind: 'jefe',          factoryKey: 'npc_jefe_servicio', isNPC: true },
    'H': { key: 'npc_supervisora', kind: 'supervisora',   factoryKey: 'npc_supervisora', isNPC: true },
    'k': { key: 'npc_medico',      kind: 'medico',        factoryKey: 'npc_medico',      isNPC: true },
    't': { key: 'npc_tcae',        kind: 'tcae',          factoryKey: 'npc_tcae',        isNPC: true },
    'c': { key: 'npc_celador',     kind: 'celador',       factoryKey: 'npc_celador',     isNPC: true },
    'n': { key: 'npc_nurse_sexy',  kind: 'enfermera_sexy',factoryKey: 'npc_enfermera_sexy', isNPC: true },
    'h': { key: 'npc_cleaner',     kind: 'cleaner',       factoryKey: 'npc_cleaner',     isNPC: true },
    'g': { key: 'npc_guard',       kind: 'guardia',       factoryKey: 'npc_guardia',     isNPC: true },
    'v': { key: 'npc_familiar',    kind: 'familiar',      factoryKey: 'npc_familiar_molesto', isNPC: true },

    // Ascensor
    'E': { key: 'elevator',       kind: 'elevator',       factoryKey: 'elevator_tile' },

    // Agua / charco
    '~': { key: 'water',          kind: 'water',          factoryKey: 'water_tile', isWater: true },

    // Fuego
    'x': { key: 'fire',           kind: 'fire',           factoryKey: 'fire_tile',  isHazard: true },

    // Pastilla genérica
    'i': { key: 'pill',           kind: 'pill',           factoryKey: 'pill_generic' },

    // Loot genérico
    'o': { key: 'loot_random',    kind: 'loot_random',    factoryKey: 'loot_random' },

    // Monedas y bolsas
    '$': { key: 'coin',           kind: 'coin',           factoryKey: 'loot_coin' },
    '%': { key: 'money_bag',      kind: 'money_bag',      factoryKey: 'loot_money_bag' },

    // Jeringas (power-ups directos)
    '1': { key: 'syringe_red',    kind: 'syringe',        subtype: 'red',   factoryKey: 'syringe_red' },
    '2': { key: 'syringe_blue',   kind: 'syringe',        subtype: 'blue',  factoryKey: 'syringe_blue' },
    '3': { key: 'syringe_green',  kind: 'syringe',        subtype: 'green', factoryKey: 'syringe_green' },

    // Goteros (efectos tácticos)
    '4': { key: 'drip_red',       kind: 'drip',           subtype: 'red',   factoryKey: 'drip_red' },
    '5': { key: 'drip_blue',      kind: 'drip',           subtype: 'blue',  factoryKey: 'drip_blue' },
    '6': { key: 'drip_green',     kind: 'drip',           subtype: 'green', factoryKey: 'drip_green' },

    // Comida/bebida
    'y': { key: 'food_small',     kind: 'food',           subtype: 'small', factoryKey: 'food_small' },
    'Y': { key: 'food_big',       kind: 'food',           subtype: 'big',   factoryKey: 'food_big' },

    // Extintor portátil
    'e': { key: 'extinguisher',   kind: 'extinguisher',   factoryKey: 'extinguisher' }
  };

  root.AsciiLegend = root.AsciiLegend || LEGEND;

  const unknownCache = new Set();

  function warnUnknownChar(ch, context){
    const key = typeof ch === 'string' ? ch : String(ch);
    if (unknownCache.has(key)) return;
    unknownCache.add(key);
    try {
      console.warn('[ASCII] Unknown char in map:', JSON.stringify(ch), context || '');
    } catch (_) {}
  }

  function getLegendDef(ch, opts = {}) {
    const legend = root.AsciiLegend || {};
    const def = legend[ch];
    if (!def && opts.log !== false) warnUnknownChar(ch, opts.context);
    return def || null;
  }

  function logSpawnFallback(asciiChar, def, tx, ty, reason){
    if (typeof console === 'undefined' || !console.error) return;
    try {
      console.error('[SPAWN_FALLBACK]', {
        char: asciiChar,
        kind: def?.kind,
        factoryKey: def?.factoryKey,
        x: tx,
        y: ty,
        reason
      });
    } catch (_) {}
  }

  root.PlacementAPI = root.PlacementAPI || {};
  root.AsciiLegendAPI = root.AsciiLegendAPI || {};

  const PlacementAPI = root.PlacementAPI;
  const AsciiLegendAPI = root.AsciiLegendAPI;

  PlacementAPI.getDefFromChar = function getDefFromChar(ch, opts = {}) {
    return getLegendDef(ch, opts);
  };
  AsciiLegendAPI.getDef = getLegendDef;

  PlacementAPI.getCharForKey = function getCharForKey(key, fallback) {
    if (!key || typeof key !== 'string') return fallback;
    const legend = root.AsciiLegend || {};
    for (const [ch, def] of Object.entries(legend)) {
      if (def.key === key || def.kind === key) return ch;
    }
    return fallback;
  };

  function ensureFloorAt(mapOrGame, tx, ty){
    const map = Array.isArray(mapOrGame) ? mapOrGame : (mapOrGame?.map || null);
    if (!Array.isArray(map)) return;
    if (!Array.isArray(map[ty])) map[ty] = [];
    map[ty][tx] = 0;
  }

  const PLACEHOLDER_DEBUG_COLORS = {
    'S': '#4da6ff',
    'P': '#ffd166',
    'I': '#a0ffcf',
    'D': '#7f8c8d',
    'C': '#b0956c',
    'M': '#ff77aa',
    'R': '#c7c7c7',
    'E': '#9b59b6',
    'L': '#f1c40f',
    '#': '#444444',
    '.': '#666666',
    '?': '#ff3366'
  };

  function resolvePlaceholderColor(ch, def, reason){
    if (def?.placeholderColor) return def.placeholderColor;
    if (def?.debugColor) return def.debugColor;

    const meta = def || {};
    const kind = String(meta.kind || meta.factoryKey || '').toLowerCase();
    const role = String(meta.role || '').toLowerCase();
    const special = String(meta.specialRoom || '').toLowerCase();
    const has = (needle) => kind.includes(needle) || role.includes(needle);

    if (has('hero') || meta.isHero) return '#6bd3ff';
    if (meta.isSpawn) return '#4da6ff';
    if (meta.isPatient || has('patient') || has('bed') || has('bell')) return '#ffd166';
    if (meta.isDoor || has('door')) return '#7f8c8d';
    if (meta.isCart || has('cart')) return '#b0956c';
    if (meta.isEnemy || has('enemy') || has('hostile')) return '#ff77aa';
    if (has('rat')) return '#c7c7c7';
    if (meta.isNPC || has('npc') || has('staff')) return '#ff9800';
    if (meta.isHazard || has('fire')) return '#ffeb3b';
    if (meta.isWater || has('water') || has('wet')) return '#2196f3';
    if (meta.isDoor || meta.bossDoor || has('boss')) return '#111111';
    if (has('light')) return '#f1c40f';
    if (has('elevator')) return '#9b59b6';
    if (has('pill') || has('syringe') || has('drip') || has('food') || has('loot')) return '#a0ffcf';
    if (special) return '#90a4ae';
    const colorByChar = PLACEHOLDER_DEBUG_COLORS[ch] || null;
    if (colorByChar) return colorByChar;
    return PLACEHOLDER_DEBUG_COLORS['?'];
  }

  function ensurePlaceholderSprite(key, char, color){
    const sprites = root.Sprites;
    if (!sprites || !sprites._imgs) return null;
    const cacheKey = `${key}_${char || '?'}`;
    if (sprites._imgs[cacheKey]) return cacheKey;
    const tile = sprites._opts?.tile || root.TILE_SIZE || 32;
    try {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = tile;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = color || '#607d8b';
      ctx.fillRect(0, 0, tile, tile);
      ctx.strokeStyle = 'rgba(0,0,0,0.5)';
      ctx.lineWidth = 2;
      ctx.strokeRect(1, 1, tile - 2, tile - 2);
      ctx.fillStyle = (color === '#111111') ? '#f8f8f8' : '#ffffff';
      ctx.font = `${Math.floor(tile * 0.7)}px monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(char || '?', tile * 0.5, tile * 0.55);
      sprites._imgs[cacheKey] = canvas;
      if (!sprites._keys.includes(cacheKey)) sprites._keys.push(cacheKey);
      return cacheKey;
    } catch (_) {
      return null;
    }
  }

  function gridToWorld(tx, ty){
    const tile = (typeof root.TILE_SIZE === 'number' && root.TILE_SIZE > 0)
      ? root.TILE_SIZE
      : ((typeof root.TILE === 'number' && root.TILE > 0) ? root.TILE : 32);
    return { x: tx * tile, y: ty * tile, tile };
  }

  PlacementAPI.spawnFallbackPlaceholder = function spawnFallbackPlaceholder(charLabel, def, tx, ty, source, ctx = {}) {
    const world = gridToWorld(tx, ty);
    const tile = world.tile;
    const asciiChar = charLabel || def?.char || def?.key || ctx?.char || '?';
    ensureFloorAt(ctx.map || ctx.G, tx, ty);
    const color = resolvePlaceholderColor(asciiChar, def, ctx?.reason || source);
    const spriteKey = ensurePlaceholderSprite('spawn_placeholder', asciiChar, color);
    const placeholder = {
      kind: def?.kind || def?.key || 'PLACEHOLDER',
      type: def?.type,
      factoryKey: def?.factoryKey,
      x: world.x,
      y: world.y,
      grid: { x: tx, y: ty },
      w: tile,
      h: tile,
      blocking: false,
      dynamic: false,
      pushable: false,
      char: asciiChar,
      color,
      spriteKey,
      placeholder: true,
      rigOk: false,
      _debugSpawnPlaceholder: true,
      _debugChar: asciiChar,
      _debugColor: color,
      _debugReason: ctx?.reason || source,
      _debugStage: ctx?.stage || source
    };

    const reason = ctx?.reason || source || 'spawnFallback';
    const stage = ctx?.stage || source || 'ascii_legend.spawnFallbackPlaceholder';
    const error = ctx?.error || null;

    const shouldLog = ctx?.skipLog !== true;
    if (shouldLog) logSpawnFallback(asciiChar, def, tx, ty, reason);

    try {
      if (typeof registerSpawnFallback === 'function') {
        registerSpawnFallback({
          char: asciiChar,
          kind: def?.kind || def?.key || null,
          factoryKey: def?.factoryKey || null,
          grid: { x: tx, y: ty },
          world: { x: world.x, y: world.y },
          stage,
          reason,
          error: error ? String(error?.message || error) : null
        });
      }
    } catch (_) {}

    const shouldRegister = ctx.autoRegister !== false;
    const game = ctx.G || root.G;
    if (shouldRegister && game && Array.isArray(game.entities) && !game.entities.includes(placeholder)) {
      game.entities.push(placeholder);
    }

    return placeholder;
  };

  root.AsciiLegend.spawnFallbackPlaceholder = PlacementAPI.spawnFallbackPlaceholder;

  PlacementAPI.spawnFromAscii = function spawnFromAscii(defOrChar, tx, ty, extraCtx, char) {
    const def = (typeof defOrChar === 'string' || typeof defOrChar === 'number')
      ? PlacementAPI.getDefFromChar(defOrChar, { context: 'PlacementAPI.spawnFromAscii' })
      : defOrChar;
    const asciiChar = extraCtx?.char || def?.char || char || (typeof defOrChar === 'string' ? defOrChar : null) || '?';
    const world = gridToWorld(tx, ty);
    const ctx = {
      ...(extraCtx || {}),
      G: extraCtx?.G || root.G,
      map: extraCtx?.map || extraCtx?.G?.map,
      autoRegister: false,
      char: asciiChar
    };
    const fallback = (reason, err) => {
      return PlacementAPI.spawnFallbackPlaceholder(
        asciiChar,
        def || null,
        tx,
        ty,
        reason,
        {
          ...ctx,
          x: world.x,
          y: world.y,
          reason,
          error: err ? (err?.message || err) : null,
          stage: 'ascii_legend.spawnFromAscii'
        }
      );
    };

    if (!def || typeof tx !== 'number' || typeof ty !== 'number') {
      return fallback('Legend entry missing');
    }

    try {
      console.log('[SPAWN_ASCII]', {
        char: asciiChar,
        kind: def?.kind || def?.key,
        grid: { x: tx, y: ty },
        world: { x: world.x, y: world.y }
      });
    } catch (_) {}

    const kind = def.kind || def.key;
    const factoryKey = def.factoryKey || kind;
    const opts = { _ascii: def, tx, ty, context: ctx, char: asciiChar };
    const applyLegendTint = (entity) => {
      const tintKey = typeof def.tint === 'string' ? def.tint.toLowerCase() : null;
      const tint = tintKey ? TINT_COLORS[tintKey] : null;
      if (!entity || !tint) return entity;
      try {
        if (typeof entity.setTint === 'function') entity.setTint(tint);
        if (entity.sprite && typeof entity.sprite.setTint === 'function') entity.sprite.setTint(tint);
        else if (entity.sprite && typeof entity.sprite.tint !== 'undefined') entity.sprite.tint = tint;
        else if (typeof entity.tint !== 'undefined') entity.tint = tint;
      } catch (_) {}
      return entity;
    };

    if (!factoryKey) {
      return fallback(`Factory not found: ${factoryKey || 'undefined'}`);
    }

    if (def.isSpawn) {
      try {
        const entity = root.SpawnerManager?.spawnFromDef?.(def, tx, ty, opts);
        return entity ? applyLegendTint(entity) : fallback(`Factory returned null: ${factoryKey}`);
      } catch (err) {
        return fallback(`Exception: ${err?.message || err}`, err);
      }
    }
    if (kind === 'wall' || kind === 'void') return null;

    if (typeof def.spawnFromAscii === 'function') {
      try {
        const e = def.spawnFromAscii(tx, ty, opts, ctx);
        return e || fallback(`Factory returned null: ${factoryKey}`);
      } catch (err) {
        return fallback(`Exception: ${err?.message || err}`, err);
      }
    }

    if (root.Entities?.[factoryKey]?.spawnFromAscii) {
      try {
        const e = root.Entities[factoryKey].spawnFromAscii(tx, ty, opts, ctx);
        return e || fallback(`Factory returned null: ${factoryKey}`);
      } catch (err) {
        return fallback(`Exception: ${err?.message || err}`, err);
      }
    }

    const factory = root.Entities?.factory;
    if (!factory || typeof factory !== 'function') {
      return fallback(`Factory not found: ${factoryKey}`);
    }
    try {
      const entity = factory(factoryKey, opts);
      if (!entity) {
        return fallback(`Factory returned null: ${factoryKey}`);
      }
      return applyLegendTint(entity);
    } catch (err) {
      return fallback(`Exception: ${err?.message || err}`, err);
    }
  };
})(typeof window !== 'undefined' ? window : globalThis);
