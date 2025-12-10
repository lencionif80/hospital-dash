(function(){
  'use strict';

  const root = typeof window !== 'undefined' ? window : globalThis;
  if (typeof root.ENABLE_COOP === 'undefined') {
    root.ENABLE_COOP = false;
  }
  const Placement = root.Placement = root.Placement || {};
  Placement._counts = null;

  const TILE_SIZE = () => root.TILE_SIZE || root.TILE || 32;

  const GridMath = root.GridMath = root.GridMath || {};
  function tileSize(){
    const size = Number(TILE_SIZE() || 0);
    return Number.isFinite(size) && size > 0 ? size : 32;
  }
  GridMath.tileSize = tileSize;
  GridMath.gridToWorld = function gridToWorld(tx, ty){
    const tile = tileSize();
    return { x: tx * tile, y: ty * tile, tile };
  };

  if (!root.PlacementAPI) root.PlacementAPI = {};

  // Diagnóstico 1: el log [SPAWN_FALLBACK] se emite aquí, pero coexisten dos implementaciones
  // (ascii_legend.js y esta), lo que dispersa la ruta real del placeholder.
  function pickDebugColorForChar(charLabel, def) {
    const base =
      (def && (def.color || def.tint || def.debugColor)) ||
      (charLabel === 'p' ? '#ff8800' : // pacientes / people
       charLabel === 'b' ? '#ff3355' : // boss / boss-related
       charLabel === 'd' ? '#3366ff' : // doors
       charLabel === 'c' ? '#33cc99' : // carts
       '#ff3366');                    // por defecto

    return base;
  }

  function invertColorForText(hex) {
    try {
      const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
      if (!m) return '#ffffff';
      const int = parseInt(m[1], 16);
      const r = (int >> 16) & 0xff;
      const g = (int >> 8) & 0xff;
      const b = int & 0xff;
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      return lum > 140 ? '#111111' : '#ffffff';
    } catch (_) {
      return '#ffffff';
    }
  }

  function createSpawnDebugPlaceholderEntity(charLabel, worldX, worldY, def, extra) {
    const T = root.TILE_SIZE || root.TILE || 32;
    const color = pickDebugColorForChar(charLabel, def);
    const textColor = invertColorForText(color);

    const e = {
      id:
        typeof genId === 'function'
          ? genId()
          : 'fallback-' + Math.random().toString(36).slice(2),
      kind: 'DEBUG_PLACEHOLDER',
      role: 'debug_placeholder',
      populationType: 'none',

      x: worldX,
      y: worldY,
      w: T * 0.9,
      h: T * 0.9,

      vx: 0,
      vy: 0,
      dir: 0,

      solid: false,
      collisionLayer: 'default',
      collisionMask: 'default',

      _debugSpawnPlaceholder: true,
      _debugChar: charLabel || '?',
      _debugColor: color,
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
      _culled: false,
    };

    return e;
  }

  root.pickDebugColorForChar = root.pickDebugColorForChar || pickDebugColorForChar;
  root.invertColorForText = root.invertColorForText || invertColorForText;
  root.createSpawnDebugPlaceholderEntity =
    root.createSpawnDebugPlaceholderEntity || createSpawnDebugPlaceholderEntity;

  if (!root.PlacementAPI.spawnFallbackPlaceholder) {
    root.PlacementAPI.spawnFallbackPlaceholder = function spawnFallbackPlaceholder(
      asciiChar,
      def,
      tx,
      ty,
      failReason,
      context
    ) {
      // Diagnóstico 2: los callers de NPC/enemy/world pasan autoRegister:false; con la
      // implementación anterior el registro dependía de createSpawnDebugPlaceholderEntity.
      try {
        const G = (context && context.G) || root.G;
        const map = (context && context.map) || (G && G.map) || null;
        const T = root.TILE_SIZE || root.T || 32;

        const worldX = (context && typeof context.x === 'number')
          ? context.x
          : tx * T + T * 0.5;
        const worldY = (context && typeof context.y === 'number')
          ? context.y
          : ty * T + T * 0.5;

        const placeholder = createSpawnDebugPlaceholderEntity(
          asciiChar || '?',
          worldX,
          worldY,
          def || null,
          {
            reason: failReason || 'unknown',
            map,
            tx,
            ty,
          }
        );

        const autoRegisterFlag =
          !context || typeof context.autoRegister === 'undefined'
            ? true
            : context.autoRegister !== false;

        if (autoRegisterFlag && G && Array.isArray(G.entities) && placeholder && !G.entities.includes(placeholder)) {
          G.entities.push(placeholder);
        }

        try {
          if (typeof console !== 'undefined' && console.warn) {
            console.warn('[SPAWN_FALLBACK]', {
              char: asciiChar,
              kind: def && def.kind,
              factoryKey: def && def.factoryKey,
              tx,
              ty,
              x: worldX,
              y: worldY,
              stage: (context && context.stage) || 'unknown',
              error: (context && context.error) || null,
              reason: failReason || null,
            });
          }
        } catch (_) {}

        return placeholder;
      } catch (err) {
        try {
          console.error('[SPAWN_FALLBACK_FATAL]', err);
        } catch (_) {}
        return null;
      }
    };
  }

  Placement.shouldRun = function shouldRun(cfg){
    const G = cfg?.G || root.G;
    if (!G || !cfg?.map || !cfg?.width || !cfg?.height) return false;
    if (G.__placementsApplied === true) return false;
    return true;
  };

  Placement.applyFromAsciiMap = function applyFromAsciiMap(cfg){
    const mode = String(root.MapGen?.MAP_MODE || root.__MAP_MODE || cfg?.mode || 'normal').toLowerCase();
    if (mode === 'normal' && cfg?.forceAscii !== true) {
      return applyFromXML(cfg);
    }
    return applyFromAsciiLegacy(cfg);
  };

  function applyFromAsciiLegacy(cfg){
    const G = cfg?.G || root.G || (root.G = {});
    if (!Placement.shouldRun({ ...cfg, G })) {
      return { applied: false, reason: 'guard' };
    }

    ensureGameCollections(G);
    G.__placementsApplied = true;
    G._lastLevelCfg = cfg;
    Placement._counts = {};

    function logSpawnPipelineError(stage, err, entity) {
      const msg = String((err && err.message) || err);
      try {
        console.error('[SPAWN_PIPELINE_ERROR]', stage, {
          kind: entity && entity.kind,
          role: entity && entity.role,
          char: entity && entity._debugChar,
          msg,
        });
      } catch (_) {}

      try {
        if (typeof registerSpawnFallback === 'function') {
          registerSpawnFallback({
            char: entity && entity._debugChar || null,
            kind: entity && entity.kind || null,
            grid: entity && entity.grid || null,
            world: entity ? { x: entity.x, y: entity.y } : null,
            stage,
            reason: 'pipeline_error',
            error: msg,
          });
        }
      } catch (_) {}
    }

    const add = (entity) => {
      if (!entity) return;
      ensureGameCollections(G);
      if (Array.isArray(G.entities) && !G.entities.includes(entity)) {
        G.entities.push(entity);
      }
      if (!entity.static && (entity.dynamic || entity.pushable || entity.vx || entity.vy)) {
        if (Array.isArray(G.movers) && !G.movers.includes(entity)) {
          G.movers.push(entity);
        }
      }
      try { root.EntityGroups?.assign?.(entity); } catch (err) { logSpawnPipelineError('EntityGroups.assign', err, entity); }
      try { root.EntityGroups?.register?.(entity, G); } catch (err) { logSpawnPipelineError('EntityGroups.register', err, entity); }
      const kindKey = resolveKind(entity);
      Placement._counts[kindKey] = (Placement._counts[kindKey] || 0) + 1;
      try { root.AI?.register?.(entity); } catch (err) { logSpawnPipelineError('AI.register', err, entity); }
      return entity;
    };

    ensurePatientCounters(G);

    const heroPos = findHeroPosFromAsciiOrCenter(cfg, G);
    const hero = spawnHero(heroPos.tx, heroPos.ty, cfg, G);
    root.Puppet?.bind?.(hero, hero.key || 'hero_enrique');
    hero.rigOk = true;
    add(hero);
    G.player = hero;

    const patientSpots = listPatientSpots(cfg, G);
    if (cfg?.mode === 'debug' && patientSpots.length === 0) {
      patientSpots.push({ tx: heroPos.tx + 4, ty: heroPos.ty });
    }

    for (const spot of patientSpots) {
      const patient = spawnPatient(spot.tx, spot.ty, { name: genFunnyName() }, cfg, G);
      if (!patient) continue;
      add(patient);
      const pill = spawnPill(spot.tx + 1, spot.ty, {
        patientId: patient.id,
        code: pillCodeFromName(patient.name)
      }, cfg, G);
      if (pill) {
        pill.patientId = pill.patientId || patient.id;
        add(pill);
        if (!G.pills.includes(pill)) G.pills.push(pill);
      }
      const bell = spawnBellForPatient(patient, null, null, cfg, G);
      if (bell) {
        add(bell);
      }
      const counters = (typeof root.patientsSnapshot === 'function') ? root.patientsSnapshot() : null;
      if (counters) {
        G.patients.total = counters.total | 0;
        G.patients.pending = counters.pending | 0;
      } else {
        G.patients.total = (G.patients.total | 0) + 1;
        G.patients.pending = (G.patients.pending | 0) + 1;
      }
    }

    registerSpawnerPlacements(cfg, G);
    for (const npc of spawnNPCPack(cfg, G)) add(npc);
    for (const enemy of spawnEnemiesPack(cfg, G)) add(enemy);
    for (const obj of spawnWorldObjects(cfg, G)) add(obj);

    try { Placement.ensureNoPushableOverlap(G, { log: true }); } catch (_) {}
    try { root.Minimap?.refresh?.(); } catch (_) {}
    try { root.LOG?.event?.('PLACEMENT_SUMMARY', Placement.summarize()); } catch (_) {}

    return { applied: true };
  }

  function applyGlobals(globals, G){
    if (!globals || typeof globals !== 'object') return;
    if (Number.isFinite(globals.tileSize)) {
      root.TILE_SIZE = globals.tileSize;
      G.TILE_SIZE = globals.tileSize;
    }
    G.globals = { ...(G.globals || {}), ...globals };
    const cullingRaw = Number(globals.culling);
    const culling = Number.isFinite(cullingRaw) && cullingRaw > 0
      ? cullingRaw
      : (Number.isFinite(G.culling) && G.culling > 0 ? G.culling : 20);
    G.culling = culling;
    const tile = TILE_SIZE();
    const tileSize = Number.isFinite(tile) && tile > 0 ? tile : (root.G?.TILE_SIZE || 32);
    G.cullingPx = culling * (Number.isFinite(tileSize) && tileSize > 0 ? tileSize : 32);
    if (typeof globals.defaultHero === 'string' && !G.selectedHero) {
      G.selectedHero = globals.defaultHero;
    }
    if (globals.firstBellDelayMinutes != null) {
      const minutes = Number(globals.firstBellDelayMinutes);
      const safe = Number.isFinite(minutes) ? Math.max(0, minutes) : 5;
      G.firstBellDelayMinutes = safe;
    } else if (typeof G.firstBellDelayMinutes !== 'number') {
      G.firstBellDelayMinutes = 5;
    }
  }

  function createFallbackRNG(seed){
    let state = 0;
    if (typeof seed === 'number' && Number.isFinite(seed)) {
      state = seed >>> 0;
    } else {
      state = hashSeed(String(seed || Date.now()));
    }
    return {
      rand(){
        state |= 0;
        state = (state + 0x6D2B79F5) | 0;
        let t = Math.imul(state ^ (state >>> 15), 1 | state);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      },
      int(a, b){
        const min = Math.min(a, b);
        const max = Math.max(a, b);
        return min + Math.floor(this.rand() * (max - min + 1));
      },
      pick(arr){
        if (!Array.isArray(arr) || !arr.length) return null;
        return arr[Math.floor(this.rand() * arr.length)];
      },
      shuffle(arr){
        if (!Array.isArray(arr)) return arr;
        for (let i = arr.length - 1; i > 0; i--) {
          const j = this.int(0, i);
          [arr[i], arr[j]] = [arr[j], arr[i]];
        }
        return arr;
      }
    };
  }

  function hashSeed(str){
    let h = 2166136261 >>> 0;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  function buildXmlPlacementContext(grid, rng, rules, level, globals){
    const rooms = Array.isArray(grid.rooms) ? grid.rooms.map((room, idx) => ({
      ...room,
      id: room.id || `room_${idx + 1}`,
      idx,
      tag: room.tag || '',
      center: {
        tx: room.x + Math.floor(room.w / 2),
        ty: room.y + Math.floor(room.h / 2)
      }
    })) : [];

    const byTag = new Map();
    for (const room of rooms) {
      const tag = String(room.tag || '').toLowerCase();
      if (tag) byTag.set(tag, room);
      byTag.set(room.id.toLowerCase(), room);
      byTag.set(`room:${room.id.toLowerCase()}`, room);
    }
    if (grid.control) byTag.set('room:control', grid.control);
    if (grid.entrance) byTag.set('room:entrance', grid.entrance);
    if (grid.boss) byTag.set('bossroom', grid.boss);
    if (grid.boss) byTag.set('room:boss', grid.boss);

    const spawnTile = resolveSpawnTile(grid, level, rooms);

    return {
      grid,
      rng,
      rules,
      level,
      globals,
      rooms,
      byTag,
      occupancy: new Set(),
      spawnTile,
      bossEntrance: grid.bossEntrance || null,
      bossRoom: grid.boss || null,
      controlRoom: grid.control || null,
      entranceRoom: grid.entrance || null,
      uniqueNPCs: new Set(),
      lightPlacements: [],
      lightBrokenRate: Number(level?.lighting?.brokenLights) || 0,
      counters: { patient: 0, light: 0, elevator: 0 }
    };
  }

  function resolveSpawnTile(grid, level, rooms){
    if (Number.isFinite(level?.spawn?.tx) && Number.isFinite(level?.spawn?.ty)) {
      return { tx: level.spawn.tx, ty: level.spawn.ty };
    }
    const primary = grid.control || grid.entrance || rooms[0] || null;
    if (!primary) return { tx: 1, ty: 1 };
    return {
      tx: primary.x + Math.floor(primary.w / 2),
      ty: primary.y + Math.floor(primary.h / 2)
    };
  }

  function buildPlacementsFromRules(context){
    const placements = [];
    for (const rule of context.rules) {
      const type = String(rule?.type || '').toLowerCase();
      if (!type) continue;
      if (type === 'patient') {
        handlePatientRule(rule, context, placements);
      } else if (type === 'npc') {
        handleNpcRule(rule, context, placements);
      } else if (type === 'enemy') {
        handleEnemyRule(rule, context, placements);
      } else if (type === 'cart') {
        handleCartRule(rule, context, placements);
      } else if (type === 'door') {
        handleDoorRule(rule, context, placements);
      } else if (type === 'elevator') {
        handleElevatorRule(rule, context, placements);
      } else if (type === 'phone') {
        handlePhoneRule(rule, context, placements);
      } else if (type === 'light') {
        handleLightRule(rule, context, placements);
      }
    }
    finalizeLights(context);
    return placements;
  }

  function spawnAdditionalHeroes(extraCount, heroTile, context, cfg, G){
    const count = Math.max(0, extraCount | 0);
    if (!count) return;
    ensureGameCollections(G);
    const base = heroTile || context.spawnTile || { tx: Math.floor((cfg.width || 2) / 2), ty: Math.floor((cfg.height || 2) / 2) };
    for (let i = 0; i < count; i++) {
      const offset = findNearbyTile(context, context.controlRoom || context.entranceRoom || context.rooms[0], base, { radius: 3 });
      const tile = offset || base;
      const hero = spawnHero(tile.tx, tile.ty, cfg, G);
      if (!hero) continue;
      markOccupied(context, tile.tx, tile.ty);
      Placement._counts = Placement._counts || {};
      Placement._counts.HERO = (Placement._counts.HERO || 0) + 1;
      if (!G.entities.includes(hero)) G.entities.push(hero);
      if (!G.movers.includes(hero)) G.movers.push(hero);
    }
  }

  function applyLightingConfig(lighting, G){
    if (!lighting) return;
    G.lightingConfig = { ...(G.lightingConfig || {}), ...lighting };
    try { root.LightingSystem?.configure?.(G.lightingConfig); } catch (_) {}
  }

  function spawnPatientsFromXml(patients, pills, bells, cfg, G){
    if (!Array.isArray(patients) || !patients.length) return;
    ensurePatientCounters(G);
    const pillMap = new Map();
    for (const pill of pills || []) {
      const key = pill.patientId || pill.targetPatientId || pill.id;
      if (!key) continue;
      pillMap.set(key, pill);
    }
    const bellMap = new Map();
    for (const bell of bells || []) {
      const key = bell.patientId || bell.id;
      if (!key) continue;
      bellMap.set(key, bell);
    }
    for (const entry of patients) {
      const opts = {};
      if (entry.name) opts.name = entry.name;
      if (entry.id) opts.id = entry.id;
      const patient = spawnPatient(entry.tx, entry.ty, opts, cfg, G);
      if (!patient) continue;
      registerEntityForPlacement(G, patient);
      const pillEntry = pillMap.get(patient.id) || pillMap.get(entry.id || patient.id);
      if (pillEntry) {
        const pill = spawnPill(pillEntry.tx, pillEntry.ty, { patientId: patient.id }, cfg, G);
        if (pill) {
          pill.patientId = patient.id;
          pill.targetPatientId = patient.id;
          registerEntityForPlacement(G, pill);
          if (!G.pills.includes(pill)) G.pills.push(pill);
        }
      }
      const bellEntry = bellMap.get(patient.id) || bellMap.get(entry.id || patient.id);
      const bell = spawnBellForPatient(patient, bellEntry?.tx, bellEntry?.ty, cfg, G);
      if (bell) {
        registerEntityForPlacement(G, bell);
      }
    }
  }

  function handlePatientRule(rule, context, placements){
    const total = Number.isFinite(rule.count) ? Math.max(0, rule.count | 0) : context.rooms.length;
    const defaultRooms = context.rooms.filter((room) => room !== context.bossRoom && room !== context.controlRoom);
    const rooms = resolveRoomsForRule(context, rule, defaultRooms);
    const assignments = distributeCountAcrossRooms(context, rooms, rule, total);
    const names = parseNamesList(rule.names);
    for (const assign of assignments) {
      for (let i = 0; i < assign.count; i++) {
        const tile = randomTileInRoom(context, assign.room, { margin: 1 });
        if (!tile) continue;
        const patientId = `PAT_${String(context.level?.id || 'L')}_${++context.counters.patient}`;
        const name = names.length ? names[(context.counters.patient - 1) % names.length] : generateFallbackPatientName(context);
        placements.push({ type: 'patient', tx: tile.tx, ty: tile.ty, id: patientId, name });
        markOccupied(context, tile.tx, tile.ty);
        const pillTile = findNearbyTile(context, assign.room, tile, { radius: 2 });
        if (pillTile) {
          placements.push({ type: 'pill', tx: pillTile.tx, ty: pillTile.ty, patientId, targetPatientId: patientId });
          markOccupied(context, pillTile.tx, pillTile.ty);
        }
        const bellTile = findNearbyTile(context, assign.room, tile, { radius: 2 });
        if (bellTile) {
          placements.push({ type: 'bell', tx: bellTile.tx, ty: bellTile.ty, patientId });
          markOccupied(context, bellTile.tx, bellTile.ty);
        }
      }
    }
  }

  function handleNpcRule(rule, context, placements){
    const kind = String(rule.kind || rule.sub || '').toLowerCase() || 'npc';
    if (rule.unique && context.uniqueNPCs.has(kind)) return;
    const total = Number.isFinite(rule.count) ? Math.max(1, rule.count | 0) : 1;
    const defaultRooms = context.rooms.filter((room) => room !== context.bossRoom);
    const rooms = resolveRoomsForRule(context, rule, defaultRooms);
    const assignments = distributeCountAcrossRooms(context, rooms, rule, total);
    for (const assign of assignments) {
      for (let i = 0; i < assign.count; i++) {
        if (rule.unique && context.uniqueNPCs.has(kind)) break;
        const tile = randomTileInRoom(context, assign.room, { margin: 1 });
        if (!tile) continue;
        placements.push({
          type: 'npc',
          tx: tile.tx,
          ty: tile.ty,
          sub: kind,
          kind,
          unique: !!rule.unique,
          lightAlpha: Number(rule.lightAlpha) || context.globals?.defaultLightAlpha || 0.6
        });
        markOccupied(context, tile.tx, tile.ty);
        if (rule.unique) context.uniqueNPCs.add(kind);
      }
    }
  }

  function handleEnemyRule(rule, context, placements){
    const kind = String(rule.kind || rule.sub || '').toLowerCase() || 'enemy';
    const total = Number.isFinite(rule.count) ? Math.max(0, rule.count | 0) : context.rooms.length;
    const defaultRooms = context.rooms.filter((room) => room !== context.controlRoom);
    const rooms = resolveRoomsForRule(context, rule, defaultRooms);
    const assignments = distributeCountAcrossRooms(context, rooms, rule, total);
    for (const assign of assignments) {
      for (let i = 0; i < assign.count; i++) {
        const tile = randomTileInRoom(context, assign.room, { margin: 0 });
        if (!tile) continue;
        placements.push({
          type: 'enemy',
          tx: tile.tx,
          ty: tile.ty,
          sub: kind,
          difficulty: Number(rule.difficulty) || context.level?.difficulty || 1,
          speedScale: Number(rule.speedScale) || null,
          chaseRadius: Number(rule.chaseRadius) || null
        });
        markOccupied(context, tile.tx, tile.ty);
      }
    }
  }

  function handleCartRule(rule, context, placements){
    const kind = String(rule.kind || rule.sub || 'cart').toLowerCase();
    const total = Number.isFinite(rule.count) ? Math.max(0, rule.count | 0) : context.rooms.length;
    const defaultRooms = context.rooms.filter((room) => room !== context.bossRoom);
    const rooms = resolveRoomsForRule(context, rule, defaultRooms);
    const assignments = distributeCountAcrossRooms(context, rooms, rule, total);
    for (const assign of assignments) {
      for (let i = 0; i < assign.count; i++) {
        const tile = randomTileInRoom(context, assign.room, { margin: 1 });
        if (!tile) continue;
        placements.push({ type: 'cart', tx: tile.tx, ty: tile.ty, sub: kind });
        markOccupied(context, tile.tx, tile.ty);
      }
    }
  }

  function handleDoorRule(rule, context, placements){
    const tile = resolveDoorTile(rule, context);
    if (!tile) return;
    const kind = String(rule.kind || 'door');
    const isBoss = kind.toLowerCase() === 'urgencias' || rule.bossDoor === true;
    placements.push({
      type: 'door',
      tx: tile.tx,
      ty: tile.ty,
      sub: kind,
      kind,
      bossDoor: isBoss
    });
    markOccupied(context, tile.tx, tile.ty);
  }

  function handleElevatorRule(rule, context, placements){
    const connections = parseConnections(rule.connect);
    if (!connections.length) return;
    const forbidIn = parseTagList(rule.forbidIn);
    const forbidTo = parseTagList(rule.forbidTo);
    const maxPairs = Number.isFinite(rule.count) ? Math.max(0, rule.count | 0) : connections.length;
    let pairsPlaced = 0;
    for (const conn of connections) {
      if (pairsPlaced >= maxPairs) break;
      const fromRoom = resolveRoomIdentifier(context, conn.from);
      const toRoom = resolveRoomIdentifier(context, conn.to);
      if (!fromRoom || !toRoom) continue;
      if (forbidIn.has(normalizeRoomTag(fromRoom))) continue;
      if (forbidTo.has(normalizeRoomTag(toRoom))) continue;
      if (fromRoom === context.bossRoom || toRoom === context.bossRoom) continue;
      const aTile = randomTileInRoom(context, fromRoom, { margin: 1 });
      const bTile = randomTileInRoom(context, toRoom, { margin: 1 });
      if (!aTile || !bTile) continue;
      const pairId = `EV${++context.counters.elevator}`;
      placements.push({ type: 'elevator', tx: aTile.tx, ty: aTile.ty, pairId, link: `${fromRoom.id}->${toRoom.id}` });
      placements.push({ type: 'elevator', tx: bTile.tx, ty: bTile.ty, pairId, link: `${fromRoom.id}->${toRoom.id}` });
      markOccupied(context, aTile.tx, aTile.ty);
      markOccupied(context, bTile.tx, bTile.ty);
      pairsPlaced++;
    }
  }

  function handlePhoneRule(rule, context, placements){
    const targetRoom = resolveRoomIdentifier(context, rule.at || 'room:control') || context.controlRoom || context.entranceRoom;
    if (!targetRoom) return;
    const tile = randomTileInRoom(context, targetRoom, { margin: 1 });
    if (!tile) return;
    placements.push({ type: 'phone', tx: tile.tx, ty: tile.ty });
    markOccupied(context, tile.tx, tile.ty);
  }

  function handleLightRule(rule, context, placements){
    const kind = String(rule.kind || 'normal').toLowerCase();
    const total = Number.isFinite(rule.count) ? Math.max(0, rule.count | 0) : context.rooms.length * Math.max(1, parsePerRoom(rule.perRoom).max || 1);
    const rooms = resolveRoomsForRule(context, rule, context.rooms);
    const assignments = distributeCountAcrossRooms(context, rooms, rule, total);
    for (const assign of assignments) {
      for (let i = 0; i < assign.count; i++) {
        const tile = randomTileInRoom(context, assign.room, { margin: 0 });
        if (!tile) continue;
        const placement = {
          type: 'light',
          tx: tile.tx,
          ty: tile.ty,
          sub: kind,
          kind,
          alpha: Number(rule.alpha) || context.globals?.defaultLightAlpha || 0.6
        };
        placements.push(placement);
        context.lightPlacements.push(placement);
        markOccupied(context, tile.tx, tile.ty);
      }
    }
  }

  function finalizeLights(context){
    const lights = context.lightPlacements || [];
    if (!lights.length) return;
    const brokenRate = Math.max(0, Math.min(1, context.lightBrokenRate || 0));
    if (brokenRate <= 0) return;
    const brokenCount = Math.floor(lights.length * brokenRate);
    if (brokenCount <= 0) return;
    const pool = context.rng.shuffle(lights.slice());
    for (let i = 0; i < brokenCount && i < pool.length; i++) {
      pool[i].broken = true;
    }
  }

  function parseNamesList(value){
    if (!value) return [];
    if (Array.isArray(value)) return value.filter(Boolean);
    return String(value).split(',').map((s) => s.trim()).filter(Boolean);
  }

  function generateFallbackPatientName(context){
    const pool = ['Dolores', 'Angustias', 'Raymunda', 'Constanza', 'Flor', 'Soledad'];
    return context.rng.pick(pool) || genFunnyName();
  }

  function resolveDoorTile(rule, context){
    const at = String(rule.at || '').toLowerCase();
    if (at === 'bossroomentrance' && context.bossEntrance) {
      return context.bossEntrance;
    }
    const room = resolveRoomIdentifier(context, at) || context.bossRoom || context.controlRoom;
    if (!room) return null;
    const tile = randomTileInRoom(context, room, { margin: 0 });
    return tile;
  }

  function parseConnections(value){
    if (!value) return [];
    return String(value).split(',').map((entry) => {
      const [from, to] = entry.split('->').map((s) => s.trim());
      return { from, to };
    }).filter((conn) => conn.from && conn.to);
  }

  function parseTagList(value){
    const set = new Set();
    if (!value) return set;
    const parts = Array.isArray(value) ? value : String(value).split(',');
    for (const item of parts) {
      if (!item) continue;
      set.add(item.toString().trim().toLowerCase());
    }
    return set;
  }

  function normalizeRoomTag(room){
    if (!room) return '';
    const tag = String(room.tag || '').toLowerCase();
    if (tag) return tag;
    return `room:${String(room.id || '').toLowerCase()}`;
  }

  function resolveRoomIdentifier(context, id){
    if (!id) return null;
    const key = String(id).toLowerCase();
    if (context.byTag.has(key)) return context.byTag.get(key);
    if (context.byTag.has(`room:${key}`)) return context.byTag.get(`room:${key}`);
    return null;
  }

  function resolveRoomsForRule(context, rule, defaults){
    if (!rule?.at) return defaults;
    const at = String(rule.at).toLowerCase();
    if (at === 'room:control') return context.controlRoom ? [context.controlRoom] : defaults;
    if (at === 'room:entrance') return context.entranceRoom ? [context.entranceRoom] : defaults;
    if (at === 'room:near_boss') {
      const room = findRoomNear(context, context.bossRoom);
      return room ? [room] : defaults;
    }
    if (context.byTag.has(at)) return [context.byTag.get(at)];
    if (context.byTag.has(`room:${at}`)) return [context.byTag.get(`room:${at}`)];
    return defaults;
  }

  function findRoomNear(context, target){
    if (!target) return null;
    let best = null;
    let bestDist = Infinity;
    for (const room of context.rooms) {
      if (room === target) continue;
      const dx = room.center.tx - target.center.tx;
      const dy = room.center.ty - target.center.ty;
      const dist = dx * dx + dy * dy;
      if (dist < bestDist) {
        bestDist = dist;
        best = room;
      }
    }
    return best;
  }

  function distributeCountAcrossRooms(context, rooms, rule, total){
    if (!rooms.length) return [];
    const range = parsePerRoom(rule.perRoom, total);
    let remaining = Number.isFinite(total) ? Math.max(0, total | 0) : rooms.length * Math.max(range.max, range.min);
    const assignments = rooms.map(() => 0);
    const indices = rooms.map((_, idx) => idx);
    context.rng.shuffle(indices);
    const minPer = Math.max(0, range.min);
    for (const idx of indices) {
      if (remaining <= 0) break;
      const give = Math.min(minPer, remaining);
      assignments[idx] += give;
      remaining -= give;
    }
    while (remaining > 0) {
      let progressed = false;
      context.rng.shuffle(indices);
      for (const idx of indices) {
        const maxForRoom = Number.isFinite(range.max) ? range.max : remaining + assignments[idx];
        if (assignments[idx] >= maxForRoom) continue;
        assignments[idx] += 1;
        remaining -= 1;
        progressed = true;
        if (remaining <= 0) break;
      }
      if (!progressed) break;
    }
    return rooms.map((room, idx) => ({ room, count: assignments[idx] }));
  }

  function parsePerRoom(value, defaultCount){
    if (value == null) {
      const max = Number.isFinite(defaultCount) ? Math.max(1, Math.round(defaultCount)) : 1;
      return { min: 0, max };
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      return { min: Math.max(0, value | 0), max: Math.max(0, value | 0) };
    }
    const str = String(value).trim();
    if (str.includes('-')) {
      const [a, b] = str.split('-').map((s) => parseInt(s.trim(), 10));
      const min = Number.isFinite(a) ? Math.max(0, a) : 0;
      const max = Number.isFinite(b) ? Math.max(min, b) : min;
      return { min, max };
    }
    const num = parseInt(str, 10);
    if (Number.isFinite(num)) {
      const val = Math.max(0, num);
      return { min: val, max: val };
    }
    return { min: 0, max: Number.isFinite(defaultCount) ? Math.max(1, defaultCount) : 1 };
  }

  function randomTileInRoom(context, room, opts = {}){
    if (!room) return null;
    const margin = Math.max(0, opts.margin == null ? 0 : opts.margin);
    const tries = opts.tries || 40;
    for (let attempt = 0; attempt < tries; attempt++) {
      const tx = context.rng.int(room.x + margin, room.x + room.w - 1 - margin);
      const ty = context.rng.int(room.y + margin, room.y + room.h - 1 - margin);
      if (!isInsideRoom(room, tx, ty)) continue;
      if (!isFloor(context, tx, ty)) continue;
      if (isOccupied(context, tx, ty)) continue;
      return { tx, ty };
    }
    for (let attempt = 0; attempt < tries; attempt++) {
      const tx = context.rng.int(room.x, room.x + room.w - 1);
      const ty = context.rng.int(room.y, room.y + room.h - 1);
      if (!isFloor(context, tx, ty)) continue;
      if (isOccupied(context, tx, ty)) continue;
      return { tx, ty };
    }
    const fallback = { tx: room.x + Math.floor(room.w / 2), ty: room.y + Math.floor(room.h / 2) };
    if (isFloor(context, fallback.tx, fallback.ty)) return fallback;
    return null;
  }

  function findNearbyTile(context, room, origin, opts = {}){
    if (!room) return null;
    if (!origin) return randomTileInRoom(context, room, opts);
    const radius = Math.max(1, opts.radius || 2);
    for (let attempt = 0; attempt < 30; attempt++) {
      const tx = origin.tx + context.rng.int(-radius, radius);
      const ty = origin.ty + context.rng.int(-radius, radius);
      if (!isInsideRoom(room, tx, ty)) continue;
      if (!isFloor(context, tx, ty)) continue;
      if (isOccupied(context, tx, ty)) continue;
      return { tx, ty };
    }
    return randomTileInRoom(context, room, { margin: 0 });
  }

  function isInsideRoom(room, tx, ty){
    return tx >= room.x && tx < room.x + room.w && ty >= room.y && ty < room.y + room.h;
  }

  function isFloor(context, tx, ty){
    const map = context.grid?.map;
    if (!Array.isArray(map)) return true;
    return map[ty]?.[tx] === 0;
  }

  function isOccupied(context, tx, ty){
    return context.occupancy.has(`${tx},${ty}`);
  }

  function markOccupied(context, tx, ty){
    context.occupancy.add(`${tx},${ty}`);
  }

  async function applyFromXML(cfg = {}){
    const G = cfg?.G || root.G || (root.G = {});
    const levelId = cfg?.level || G.level || 1;
    if (typeof root.XMLRules?.load !== 'function' || typeof root.MapGen?.ensureGrid !== 'function') {
      return applyFromAsciiLegacy(cfg);
    }

    const data = await root.XMLRules.load(levelId);
    const { globals = {}, level = {}, rules = [], config: levelConfig = null } = data || {};

    const grid = root.MapGen.ensureGrid({
      width: levelConfig?.width ?? level.width,
      height: levelConfig?.height ?? level.height,
      rooms: levelConfig?.rooms ?? level.rooms,
      seed: levelConfig?.seed ?? level.seed
    });

    const map = grid?.map;
    if (!Array.isArray(map) || !map.length) {
      return applyFromAsciiLegacy(cfg);
    }

    const baseCfg = {
      ...cfg,
      G,
      map,
      width: grid.width,
      height: grid.height,
      areas: {
        control: grid.control,
        boss: grid.boss,
        entrance: grid.entrance,
        rooms: grid.rooms
      }
    };

    if (!Placement.shouldRun(baseCfg)) {
      return { applied: false, reason: 'guard' };
    }

    applyGlobals(globals, G);
    const levelCulling = Number.isFinite(levelConfig?.culling) && levelConfig.culling > 0
      ? levelConfig.culling
      : Number(level.culling);
    if (Number.isFinite(levelCulling) && levelCulling > 0) {
      G.culling = levelCulling;
      const tile = TILE_SIZE();
      const tileSize = Number.isFinite(tile) && tile > 0 ? tile : (root.G?.TILE_SIZE || 32);
      G.cullingPx = G.culling * (Number.isFinite(tileSize) && tileSize > 0 ? tileSize : 32);
    }

    const rng = (typeof root.MapGen?.createRNG === 'function')
      ? root.MapGen.createRNG(level.seed)
      : createFallbackRNG(level.seed);

    const context = buildXmlPlacementContext(grid, rng, rules, level, globals);
    const placements = buildPlacementsFromRules(context);

    // Hero spawn placement (first hero handled by legacy pipeline)
    const heroTile = context.spawnTile;
    if (heroTile) {
      markOccupied(context, heroTile.tx, heroTile.ty);
      placements.push({ type: 'hero', tx: heroTile.tx, ty: heroTile.ty, heroKey: globals.defaultHero || null });
    }

    const patientEntries = placements.filter((p) => p.type === 'patient');
    const pillEntries = placements.filter((p) => p.type === 'pill');
    const bellEntries = placements.filter((p) => p.type === 'bell');
    const otherPlacements = placements.filter((p) => !['patient', 'pill', 'bell'].includes(p.type));

    const legacyResult = applyFromAsciiLegacy({
      ...baseCfg,
      placements: otherPlacements
    });

    if (legacyResult?.applied && level.heroes > 1) {
      spawnAdditionalHeroes(level.heroes - 1, heroTile, context, baseCfg, G);
    }

    if (legacyResult?.applied) {
      spawnPatientsFromXml(patientEntries, pillEntries, bellEntries, baseCfg, G);
    }

    applyLightingConfig(level.lighting, G);
    G.levelRules = { globals, level, rules, config: levelConfig };
    G.__placementsApplied = true;

    try { Placement.ensureNoPushableOverlap(G, { log: true }); } catch (_) {}
    try { root.LOG?.event?.('PLACEMENT_SUMMARY', Placement.summarize()); } catch (_) {}
    return legacyResult;
  }

  Placement.summarize = function summarize(){
    const counts = Placement._counts || {};
    let total = 0;
    for (const key of Object.keys(counts)) total += counts[key];
    return { countsPorTipo: { ...counts }, total };
  };

  function fallbackCharForPlacement(entry, defaultKey){
    if (entry?.char) return entry.char;
    const key = entry?.key || entry?.kind || entry?.type || defaultKey;
    if (root.PlacementAPI?.getCharForKey) {
      const fromLegend = root.PlacementAPI.getCharForKey(key, null);
      if (fromLegend) return fromLegend;
    }
    const normalized = String(key || defaultKey || '?');
    return normalized ? normalized[0] : '?';
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------
  function registerEntityForPlacement(G, entity){
    if (!entity) return;
    ensureGameCollections(G);
    if (Array.isArray(G.entities) && !G.entities.includes(entity)) {
      G.entities.push(entity);
    }
    if (!entity.static && (entity.dynamic || entity.pushable || entity.vx || entity.vy)) {
      if (Array.isArray(G.movers) && !G.movers.includes(entity)) {
        G.movers.push(entity);
      }
    }
    const kindKey = resolveKind(entity);
    Placement._counts = Placement._counts || {};
    Placement._counts[kindKey] = (Placement._counts[kindKey] || 0) + 1;
    try { root.MovementSystem?.register?.(entity); } catch (_) {}
    try { root.AI?.register?.(entity); } catch (_) {}
  }

  function ensureGameCollections(G){
    if (!Array.isArray(G.entities)) G.entities = [];
    if (!Array.isArray(G.movers)) G.movers = [];
    if (!Array.isArray(G.pills)) G.pills = [];
    if (!Array.isArray(G.patients)) G.patients = [];
    try { root.EntityGroups?.ensure?.(G); } catch (_) {}
    if (typeof G.patients.total !== 'number') {
      G.patients.total = 0;
      G.patients.pending = 0;
      G.patients.cured = 0;
      G.patients.furious = 0;
    }
  }

  function ensurePatientCounters(G){
    ensureGameCollections(G);
    if (typeof G.patients.total !== 'number') G.patients.total = 0;
    if (typeof G.patients.pending !== 'number') G.patients.pending = 0;
    if (typeof G.patients.cured !== 'number') G.patients.cured = 0;
    if (typeof G.patients.furious !== 'number') G.patients.furious = 0;
  }

  function resolveKind(entity){
    if (!entity) return 'UNKNOWN';
    if (typeof entity.kind === 'string') return entity.kind;
    if (entity.kind != null) return String(entity.kind);
    if (typeof entity.type === 'string') return entity.type.toUpperCase();
    if (typeof entity.kindName === 'string') return entity.kindName.toUpperCase();
    return 'UNKNOWN';
  }

  function getPlacements(cfg){
    if (Array.isArray(cfg?.placements) && cfg.placements.length) return cfg.placements;
    if (Array.isArray(cfg?.G?.mapgenPlacements) && cfg.G.mapgenPlacements.length) {
      return cfg.G.mapgenPlacements;
    }
    if (Array.isArray(root.G?.mapgenPlacements) && root.G.mapgenPlacements.length) {
      return root.G.mapgenPlacements;
    }
    return [];
  }

  function registerSpawnerPlacements(cfg, G){
    if (!root.SpawnerManager || typeof root.SpawnerManager.registerPoint !== 'function') return;
    const placements = getPlacements(cfg);
    if (!Array.isArray(placements) || !placements.length) return;
    for (const entry of placements) {
      if (!entry || !entry.type) continue;
      const type = String(entry.type || '').toLowerCase();
      if (!type.startsWith('spawn_')) continue;
      const { tx, ty } = normalizePlacementToTile(entry, cfg);
      try {
        if (type === 'spawn_animal') {
          const allowSet = new Set(['mosquito', 'rat']);
          if (Array.isArray(entry?.allows)) {
            for (const tag of entry.allows) allowSet.add(String(tag || '').toLowerCase());
          }
          const allows = Array.from(allowSet).filter(Boolean);
          const prefer = String(entry?.prefers || '').toLowerCase();
          const opts = { inTiles: true, allows };
          if (prefer && allows.includes(prefer)) opts.prefer = prefer;
          root.SpawnerManager.registerPoint('enemy', tx, ty, opts);
        } else {
          const payload = { ...entry, inTiles: true, x: tx, y: ty };
          if (typeof root.SpawnerManager.registerFromPlacement === 'function') {
            root.SpawnerManager.registerFromPlacement(payload);
          } else {
            const kind = type === 'spawn_staff' ? 'npc' : (type === 'spawn_cart' ? 'cart' : 'enemy');
            root.SpawnerManager.registerPoint(kind, tx, ty, { inTiles: true });
          }
        }
      } catch (err) {
        try {
          console.warn('[Placement] spawner registration failed', type, err);
        } catch (_) {}
      }
    }
  }

  function parseAsciiRows(cfg){
    const raw = cfg?.asciiMap || cfg?.ascii || '';
    if (!raw) return null;
    return String(raw)
      .replace(/\r/g, '')
      .split('\n')
      .map((row) => row.trimEnd());
  }

  function legendDef(ch){
    const api = root.AsciiLegendAPI || null;
    if (api?.getDef) return api.getDef(ch, { context: 'Placement' });
    const def = (root.AsciiLegend && root.AsciiLegend[ch]) || null;
    if (!def) {
      try { console.warn('[ASCII] Unknown char in map:', JSON.stringify(ch), 'Placement'); } catch (_) {}
    }
    return def;
  }

  function findHeroPosFromAsciiOrCenter(cfg, G){
    const placements = getPlacements(cfg);
    const byType = placements.find((p) => {
      const type = String(p?.type || '').toLowerCase();
      return type === 'player' || type === 'hero' || type === 'start';
    });
    if (byType) {
      return normalizePlacementToTile(byType, cfg);
    }

    const rows = parseAsciiRows(cfg);
    if (rows) {
      for (let ty = 0; ty < rows.length; ty++) {
        const row = rows[ty];
        for (let tx = 0; tx < row.length; tx++) {
          const def = legendDef(row[tx]);
          if (def && def.key === 'hero_spawn') return { tx, ty };
        }
      }
    }

    const ctrl = cfg?.areas?.control || G?.areas?.control;
    if (ctrl) {
      return {
        tx: Math.floor(ctrl.x + ctrl.w * 0.5),
        ty: Math.floor(ctrl.y + ctrl.h * 0.5)
      };
    }

    const width = cfg?.width || G?.mapW || rows?.[0]?.length || 0;
    const height = cfg?.height || G?.mapH || rows?.length || 0;
    return {
      tx: Math.floor(width / 2),
      ty: Math.floor(height / 2)
    };
  }

  function listPatientSpots(cfg, G){
    const spots = [];
    const placements = getPlacements(cfg);
    for (const entry of placements) {
      const type = String(entry?.type || '').toLowerCase();
      if (type === 'patient') {
        spots.push(normalizePlacementToTile(entry, cfg));
      }
    }
    if (spots.length) return spots;
    const rows = parseAsciiRows(cfg);
    if (rows) {
      for (let ty = 0; ty < rows.length; ty++) {
        const row = rows[ty];
        for (let tx = 0; tx < row.length; tx++) {
          const def = legendDef(row[tx]);
          if (def?.isPatient) {
            spots.push({ tx, ty });
          }
        }
      }
    }
    return spots;
  }

  function normalizePlacementToTile(p, cfg){
    if (typeof p.tx === 'number' && typeof p.ty === 'number') {
      return { tx: p.tx, ty: p.ty };
    }
    if (p?._units && String(p._units).toLowerCase().startsWith('tile')) {
      return { tx: Math.floor(p.x), ty: Math.floor(p.y) };
    }
    if (typeof p.x === 'number' && typeof p.y === 'number') {
      return {
        tx: Math.round(p.x),
        ty: Math.round(p.y)
      };
    }
    if (Array.isArray(p.pos) && p.pos.length >= 2) {
      return {
        tx: Math.round(p.pos[0]),
        ty: Math.round(p.pos[1])
      };
    }
    return { tx: 0, ty: 0 };
  }

  function toWorld(tx, ty){
    return GridMath.gridToWorld(tx, ty);
  }

  function tileKey(tx, ty){
    return `${tx},${ty}`;
  }

  function entityTile(entity){
    if (!entity) return { tx: NaN, ty: NaN };
    const tile = tileSize();
    const w = Number.isFinite(entity.w) ? entity.w : tile * 0.9;
    const h = Number.isFinite(entity.h) ? entity.h : tile * 0.9;
    const cx = Number.isFinite(entity.x) ? entity.x + w * 0.5 : w * 0.5;
    const cy = Number.isFinite(entity.y) ? entity.y + h * 0.5 : h * 0.5;
    return {
      tx: Math.floor(cx / tile),
      ty: Math.floor(cy / tile)
    };
  }

  function isTileWalkable(G, tx, ty){
    if (!G) return true;
    const map = Array.isArray(G.map) ? G.map : null;
    if (!map || !map.length) return true;
    if (!Number.isFinite(tx) || !Number.isFinite(ty)) return false;
    if (ty < 0 || ty >= map.length) return false;
    const row = map[ty];
    if (!Array.isArray(row) || tx < 0 || tx >= row.length) return false;
    return row[tx] !== 1;
  }

  function listPushables(G){
    if (!Array.isArray(G?.entities)) return [];
    return G.entities.filter((ent) => ent && !ent.dead && ent.pushable === true);
  }

  function toIgnoreSet(ignore){
    if (!ignore) return null;
    if (ignore instanceof Set) return ignore;
    if (Array.isArray(ignore)) return new Set(ignore);
    return new Set([ignore]);
  }

  function isTileOccupiedByPushable(G, tx, ty, opts = {}){
    const ignoreSet = toIgnoreSet(opts.ignore);
    const pushables = Array.isArray(opts.pushables) ? opts.pushables : listPushables(G);
    const occupiedMap = opts.occupiedMap || null;
    const key = tileKey(tx, ty);
    if (occupiedMap && occupiedMap.size){
      const occupant = occupiedMap.get(key);
      if (occupant && (!ignoreSet || !ignoreSet.has(occupant))) return true;
    }
    for (const ent of pushables){
      if (!ent || ent.dead) continue;
      if (ignoreSet && ignoreSet.has(ent)) continue;
      const pos = entityTile(ent);
      if (pos.tx === tx && pos.ty === ty) return true;
    }
    return false;
  }

  function moveEntityToWorld(entity, px, py){
    if (!entity) return;
    const targetX = Number.isFinite(px) ? px : 0;
    const targetY = Number.isFinite(py) ? py : 0;
    try {
      entity.x = targetX;
      entity.y = targetY;
    } catch (_) {
      entity.x = targetX;
      entity.y = targetY;
    }
    if (typeof entity.vx === 'number') entity.vx = 0;
    if (typeof entity.vy === 'number') entity.vy = 0;
    entity._lastSafeX = targetX;
    entity._lastSafeY = targetY;
    try {
      const st = root.MovementSystem?.getState?.(entity);
      if (st){
        st.x = targetX;
        st.y = targetY;
        st.vx = 0;
        st.vy = 0;
        st.teleportX = targetX;
        st.teleportY = targetY;
        st.forceTeleport = true;
        st.pendingTeleportApproved = true;
      }
    } catch (_) {}
    if (entity.body && typeof entity.body.setPosition === 'function'){
      try { entity.body.setPosition(targetX, targetY); } catch (_) {}
    }
  }

  function moveEntityToTile(entity, tx, ty){
    if (!entity) return;
    const world = toWorld(tx, ty);
    moveEntityToWorld(entity, world.x, world.y);
  }

  function rectsOverlap(ax, ay, aw, ah, bx, by, bw, bh){
    return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;
  }

  function rectHitsSolidTiles(G, x, y, w, h){
    const game = G || root.G;
    const map = Array.isArray(game?.map) ? game.map : null;
    if (!map || !map.length) return false;
    const tile = tileSize();
    const epsilon = 0.001;
    const tx1 = Math.floor(x / tile);
    const ty1 = Math.floor(y / tile);
    const tx2 = Math.floor((x + w - epsilon) / tile);
    const ty2 = Math.floor((y + h - epsilon) / tile);
    for (let ty = ty1; ty <= ty2; ty++){
      if (ty < 0 || ty >= map.length) return true;
      const row = map[ty];
      if (!Array.isArray(row)) return true;
      for (let tx = tx1; tx <= tx2; tx++){
        if (tx < 0 || tx >= row.length) return true;
        if (row[tx] === 1) return true;
      }
    }
    return false;
  }

  function collidesSolidEntity(G, entity, rect, opts = {}){
    const game = G || root.G;
    const ignoreSet = toIgnoreSet(opts.ignore);
    const entities = Array.isArray(game?.entities) ? game.entities : [];
    const tile = tileSize();
    for (const other of entities){
      if (!other || other === entity) continue;
      if (other.dead) continue;
      if (ignoreSet && ignoreSet.has(other)) continue;
      const solid = other.static === true || other.solid === true || other.pushable === true;
      if (!solid) continue;
      const ow = Number.isFinite(other.w) ? other.w : tile;
      const oh = Number.isFinite(other.h) ? other.h : tile;
      const ox = Number.isFinite(other.x) ? other.x : 0;
      const oy = Number.isFinite(other.y) ? other.y : 0;
      if (rectsOverlap(rect.x, rect.y, rect.w, rect.h, ox, oy, ow, oh)) return true;
    }
    return false;
  }

  function spawnRectFromTile(tx, ty, opts){
    const tile = tileSize();
    const width = Number.isFinite(opts.width) ? opts.width : tile * 0.9;
    const height = Number.isFinite(opts.height) ? opts.height : tile * 0.9;
    const offsetX = Number.isFinite(opts.offsetX) ? opts.offsetX : (tile - width) * 0.5;
    const offsetY = Number.isFinite(opts.offsetY) ? opts.offsetY : (tile - height) * 0.5;
    return {
      x: tx * tile + offsetX,
      y: ty * tile + offsetY,
      w: width,
      h: height
    };
  }

  function isSpawnTileFree(G, entity, tx, ty, opts = {}){
    if (!Number.isFinite(tx) || !Number.isFinite(ty)) return false;
    if (!isTileWalkable(G, tx, ty)) return false;
    const rect = spawnRectFromTile(tx, ty, opts);
    if (rectHitsSolidTiles(G, rect.x, rect.y, rect.w, rect.h)) return false;
    return !collidesSolidEntity(G, entity, rect, opts);
  }

  function spawnSafetyFallbackTile(G){
    const game = G || root.G;
    const tile = tileSize();
    if (game?.safeRect){
      const cx = Math.round((game.safeRect.x + game.safeRect.w * 0.5) / tile);
      const cy = Math.round((game.safeRect.y + game.safeRect.h * 0.5) / tile);
      if (Number.isFinite(cx) && Number.isFinite(cy)) return { tx: cx, ty: cy };
    }
    const width = Number.isFinite(game?.mapW) ? game.mapW : (Array.isArray(game?.map?.[0]) ? game.map[0].length : 0);
    const height = Number.isFinite(game?.mapH) ? game.mapH : (Array.isArray(game?.map) ? game.map.length : 0);
    return {
      tx: Math.max(0, Math.floor((width || 1) / 2)),
      ty: Math.max(0, Math.floor((height || 1) / 2))
    };
  }

  function findSafeSpawnTile(G, startTx, startTy, opts = {}){
    const game = G || root.G;
    if (!game) return null;
    const maxRadius = Math.max(0, Math.round(Number.isFinite(opts.maxRadius) ? opts.maxRadius : 8));
    if (isSpawnTileFree(game, opts.entity, startTx, startTy, opts)) {
      return { tx: startTx, ty: startTy };
    }
    for (let radius = 1; radius <= maxRadius; radius++){
      for (let dy = -radius; dy <= radius; dy++){
        for (let dx = -radius; dx <= radius; dx++){
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue;
          const tx = startTx + dx;
          const ty = startTy + dy;
          if (!isSpawnTileFree(game, opts.entity, tx, ty, opts)) continue;
          return { tx, ty };
        }
      }
    }
    return null;
  }

  function describeSpawnTarget(entity){
    if (!entity) return 'entity';
    return entity.char || entity.kind || entity.type || entity.name || 'entity';
  }

  function shouldLogSpawnSafety(opts = {}){
    if (opts.log === false) return false;
    if (opts.log === true) return true;
    return !!(root.DEBUG_FORCE_ASCII || root.__MAP_MODE === 'debug' || root.DEBUG_SPAWN_SAFETY);
  }

  function placeEntitySafely(entity, G, tx, ty, opts = {}){
    if (!entity) return null;
    const game = G || root.G;
    if (!game) return null;
    const tile = tileSize();
    const width = Number.isFinite(opts.width) ? opts.width : (Number.isFinite(entity.w) ? entity.w : tile * 0.9);
    const height = Number.isFinite(opts.height) ? opts.height : (Number.isFinite(entity.h) ? entity.h : tile * 0.9);
    const baseOffsetX = Number.isFinite(opts.offsetX)
      ? opts.offsetX
      : (Number.isFinite(entity.x) ? entity.x - tx * tile : (tile - width) * 0.5);
    const baseOffsetY = Number.isFinite(opts.offsetY)
      ? opts.offsetY
      : (Number.isFinite(entity.y) ? entity.y - ty * tile : (tile - height) * 0.5);
    const searchOpts = {
      ...opts,
      entity,
      width,
      height,
      offsetX: baseOffsetX,
      offsetY: baseOffsetY
    };
    let target = findSafeSpawnTile(game, tx, ty, searchOpts);
    if (!target){
      const fallback = spawnSafetyFallbackTile(game);
      if (fallback) {
        target = findSafeSpawnTile(game, fallback.tx, fallback.ty, searchOpts);
      }
    }
    if (!target){
      const payload = { char: searchOpts.char || describeSpawnTarget(entity), from: { tx, ty } };
      if (window.DEBUG_COLLISIONS) {
        try { console.error('[SPAWN_SAFETY] No hay casillas libres', payload); } catch (_) {}
      }
      if (searchOpts.forceFallback !== false){
        const fallback = spawnSafetyFallbackTile(game);
        const px = fallback.tx * tile + baseOffsetX;
        const py = fallback.ty * tile + baseOffsetY;
        moveEntityToWorld(entity, px, py);
      }
      return null;
    }
    const px = target.tx * tile + baseOffsetX;
    const py = target.ty * tile + baseOffsetY;
    moveEntityToWorld(entity, px, py);
    if ((target.tx !== tx || target.ty !== ty) && shouldLogSpawnSafety(searchOpts)){
      if (window.DEBUG_COLLISIONS) {
        try {
          console.debug('[SPAWN_SAFETY] Recolocado spawn empotrado', {
            char: searchOpts.char || describeSpawnTarget(entity),
            from: { tx, ty },
            to: { tx: target.tx, ty: target.ty }
          });
        } catch (_) {}
      }
    }
    return target;
  }

  function describePushable(ent){
    if (!ent) return 'pushable';
    const kind = (ent.kindName || ent.kind || ent.type || 'pushable');
    const label = ent.name || ent.id;
    return label ? `${kind}:${label}` : String(kind);
  }

  function findNearestFreeTile(G, startTx, startTy, condition, options = {}){
    const game = G || root.G;
    if (!game) return null;
    const maxRadiusRaw = Number.isFinite(options.maxRadius) ? options.maxRadius : 5;
    const maxRadius = Math.max(0, Math.round(maxRadiusRaw));
    const pushables = Array.isArray(options.pushables) ? options.pushables : listPushables(game);
    const ignoreSet = toIgnoreSet(options.ignore);
    const occupiedMap = options.occupiedMap || null;

    const tester = (typeof condition === 'function')
      ? (tx, ty) => condition(tx, ty, { game, pushables, ignore: ignoreSet, occupied: occupiedMap })
      : (tx, ty) => {
          if (!isTileWalkable(game, tx, ty)) return false;
          return !isTileOccupiedByPushable(game, tx, ty, {
            ignore: ignoreSet,
            pushables,
            occupiedMap
          });
        };

    for (let radius = 0; radius <= maxRadius; radius++){
      for (let dy = -radius; dy <= radius; dy++){
        for (let dx = -radius; dx <= radius; dx++){
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue;
          const tx = startTx + dx;
          const ty = startTy + dy;
          if (!Number.isFinite(tx) || !Number.isFinite(ty)) continue;
          if (!tester(tx, ty)) continue;
          return { tx, ty };
        }
      }
    }
    return null;
  }

  function ensureNoPushableOverlap(G, opts = {}){
    const game = G || root.G;
    if (!game) return [];
    const pushables = listPushables(game);
    if (pushables.length <= 1) return [];
    const logEnabled = opts.log !== false;
    const maxRadius = Number.isFinite(opts.maxRadius) ? opts.maxRadius : 6;
    const movements = [];
    const occupancy = new Map();

    for (const ent of pushables){
      const pos = entityTile(ent);
      if (!Number.isFinite(pos.tx) || !Number.isFinite(pos.ty)) continue;
      const key = tileKey(pos.tx, pos.ty);
      const first = occupancy.get(key);
      if (!first){
        occupancy.set(key, ent);
        continue;
      }
      if (first === ent) continue;
      if (logEnabled){
        try {
          console.warn(`WARNING: Pushable overlap detected at (${pos.tx},${pos.ty}) between ${describePushable(first)} and ${describePushable(ent)}. Relocating.`);
        } catch (_) {}
      }
      const target = findNearestFreeTile(game, pos.tx, pos.ty, null, {
        maxRadius,
        ignore: ent,
        pushables,
        occupiedMap: occupancy
      });
      if (target){
        moveEntityToTile(ent, target.tx, target.ty);
        occupancy.set(tileKey(target.tx, target.ty), ent);
        movements.push({ entity: ent, from: pos, to: target });
        if (logEnabled){
          try {
            console.info(`[PushableSafety] relocated ${describePushable(ent)} to (${target.tx},${target.ty}).`);
          } catch (_) {}
        }
      } else if (logEnabled){
        try {
          console.warn(`[PushableSafety] no free tile found near (${pos.tx},${pos.ty}) for ${describePushable(ent)}.`);
        } catch (_) {}
      }
    }

    return movements;
  }

  Placement.findNearestFreeTile = findNearestFreeTile;
  Placement.isTileOccupiedByPushable = function wrappedIsTileOccupied(G, tx, ty, options){
    return isTileOccupiedByPushable(G, tx, ty, options);
  };
  Placement.ensureNoPushableOverlap = ensureNoPushableOverlap;
  Placement.findSafeSpawnTile = function wrappedFindSafe(G, tx, ty, options){
    return findSafeSpawnTile(G, tx, ty, options);
  };
  Placement.placeEntitySafely = function wrappedPlaceSafely(entity, G, tx, ty, options){
    return placeEntitySafely(entity, G, tx, ty, options);
  };

  function spawnHero(tx, ty, cfg, G){
    const tile = TILE_SIZE();
    const world = toWorld(tx, ty);
    const px = world.x + tile * 0.5;
    const py = world.y + tile * 0.5;
    const heroKey = G?.selectedHero || cfg?.heroKey || root.selectedHeroKey;
    const opts = heroKey ? { skin: heroKey } : {};
    if (!root.ENABLE_COOP && G.player) {
      return G.player;
    }
    const hero = root.Entities?.Hero?.spawnPlayer?.(px, py, { ...opts, heroId: heroKey })
      || root.Entities?.Hero?.spawn?.(px, py, { ...opts, heroId: heroKey })
      || {
        kind: 'HERO',
        x: px,
        y: py,
        w: tile * 0.8,
        h: tile * 0.85,
        key: heroKey || 'hero_enrique',
        heroId: heroKey || 'enrique',
        rigOk: false
      };
    if (hero && !hero.rigOk) hero.rigOk = true;
    placeEntitySafely(hero, G, tx, ty, { char: root.PlacementAPI?.getCharForKey?.('hero_spawn', 'S'), maxRadius: 12 });
    G.player = hero;
    return hero;
  }

  function spawnPatient(tx, ty, opts, cfg, G){
    const tile = TILE_SIZE();
    const world = toWorld(tx, ty);
    const spawnOpts = { ...(opts || {}), autoBell: false };
    const patient = root.Entities?.Patient?.spawn?.(world.x, world.y, spawnOpts)
      || root.PatientsAPI?.createPatient?.(world.x, world.y, spawnOpts)
      || {
        kind: 'PATIENT',
        x: world.x,
        y: world.y,
        w: tile * 0.9,
        h: tile * 0.75,
        id: cryptoRand(),
        name: opts?.name || genFunnyName(),
        state: 'idle_bed',
        rigOk: true
      };
    if (!patient.id) patient.id = cryptoRand();
    patient.state = patient.state || 'idle_bed';
    patient.rigOk = patient.rigOk === true || true;
    ensurePatientCounters(G);
    if (!G.patients.includes(patient)) G.patients.push(patient);
    placeEntitySafely(patient, G, tx, ty, { char: (opts && opts.char) || 'p', maxRadius: 10 });
    return patient;
  }

  function spawnPill(tx, ty, opts, cfg, G){
    const tile = TILE_SIZE();
    const world = toWorld(tx, ty);
    const payload = { ...opts, patientId: opts?.patientId, _units: 'px' };
    const pill = root.Entities?.Objects?.spawnPill?.('pill', world.x + tile * 0.25, world.y + tile * 0.25, payload)
      || root.PatientsAPI?.createPillForPatient?.(findPatientById(G, opts?.patientId), 'near')
      || {
        kind: 'PILL',
        x: world.x + tile * 0.25,
        y: world.y + tile * 0.25,
        w: tile * 0.5,
        h: tile * 0.5,
        patientId: opts?.patientId,
        rigOk: true
      };
    pill.kind = pill.kind || 'PILL';
    pill.rigOk = pill.rigOk === true || true;
    return pill;
  }

  function spawnBell(tx, ty, opts, cfg, G){
    const tile = TILE_SIZE();
    const world = toWorld(tx, ty);
    const payload = { ...opts, _units: 'px' };
    const bell = root.BellsAPI?.spawnBell?.(world.x + tile * 0.1, world.y + tile * 0.1, payload)
      || root.spawnBell?.(world.x + tile * 0.1, world.y + tile * 0.1, payload)
      || {
        kind: 'BELL',
        x: world.x + tile * 0.1,
        y: world.y + tile * 0.1,
        w: tile * 0.6,
        h: tile * 0.6,
        patientId: opts?.patientId,
        rigOk: true,
        ringing: false
      };
    if (bell) {
      bell.kind = bell.kind || 'BELL';
      bell.rigOk = bell.rigOk === true || true;
      bell.on = bell.on || false;
    }
    return bell;
  }

  function spawnBellForPatient(patient, txHint, tyHint, cfg, G){
    if (!patient) return null;
    if (root.BellsAPI?.spawnPatientBell) {
      const bell = (Number.isInteger(txHint) && Number.isInteger(tyHint))
        ? root.BellsAPI.spawnPatientBell(patient, txHint, tyHint)
        : root.BellsAPI.spawnPatientBell(patient);
      if (bell) return bell;
    }
    const tile = TILE_SIZE();
    const rect = {
      x: patient.x || 0,
      y: patient.y || 0,
      w: patient.w || tile,
      h: patient.h || tile
    };
    const baseTx = Math.floor((rect.x + rect.w * 0.5) / tile);
    const baseTy = Math.floor((rect.y + rect.h * 0.5) / tile);
    const map = (G && Array.isArray(G.map)) ? G.map : (cfg?.G?.map || []);
    const isFree = (tx, ty) => Array.isArray(map[ty]) && map[ty][tx] === 0;
    let resolved = null;
    if (Number.isInteger(txHint) && Number.isInteger(tyHint)) {
      const adj = Math.max(Math.abs(txHint - baseTx), Math.abs(tyHint - baseTy)) === 1;
      if (adj && isFree(txHint, tyHint)) {
        resolved = { tx: txHint, ty: tyHint };
      }
    }
    if (!resolved) {
      const offsets = [
        { dx: 1, dy: 0 }, { dx: -1, dy: 0 },
        { dx: 0, dy: 1 }, { dx: 0, dy: -1 },
        { dx: 1, dy: 1 }, { dx: -1, dy: 1 },
        { dx: 1, dy: -1 }, { dx: -1, dy: -1 }
      ];
      for (const off of offsets) {
        const tx = baseTx + off.dx;
        const ty = baseTy + off.dy;
        if (!isFree(tx, ty)) continue;
        resolved = { tx, ty };
        break;
      }
    }
    if (!resolved) return null;
    const bell = spawnBell(resolved.tx, resolved.ty, { patientId: patient.id }, cfg, G);
    if (bell) bell.patientId = patient.id;
    return bell;
  }

  function spawnNPCPack(cfg, G){
    const out = [];
    for (const entry of getPlacements(cfg)) {
      const type = String(entry?.type || '').toLowerCase();
      if (type !== 'npc' && type !== 'npc_unique' && type !== 'staff') continue;
      const { tx, ty } = normalizePlacementToTile(entry, cfg);
      const world = toWorld(tx, ty);
      const sub = String(entry?.sub || entry?.npc || entry?.name || '').toLowerCase();
      const char = fallbackCharForPlacement(entry, sub || type);
      let failReason = '';
      const payload = { ...entry, _units: 'px' };
      let npc = null;
      try {
        if (root.Entities?.NPC?.spawn) {
          npc = root.Entities.NPC.spawn(sub, world.x, world.y, payload);
        }
        if (!npc) {
          npc = spawnNPCBySubtype(sub, world.x, world.y, payload);
        }
      } catch (err) {
        failReason = err?.message || String(err);
      }
      if (!npc && !failReason) failReason = 'NPC spawn returned null';
      if (!npc && root.PlacementAPI?.spawnFallbackPlaceholder) {
        const def = { kind: 'NPC', factoryKey: sub || type, type };
        const fallback = root.PlacementAPI.spawnFallbackPlaceholder(char, def, tx, ty, failReason || 'NPC spawn failed', { G, map: cfg?.map, autoRegister: false });
        if (fallback) {
          fallback.group = fallback.group || 'human';
          ensureNPCVisuals(fallback);
          placeEntitySafely(fallback, G, tx, ty, { char, maxRadius: 10 });
          out.push(fallback);
        }
        continue;
      }
      npc.rigOk = npc.rigOk === true;
      if (!npc.group) npc.group = 'human';
      ensureNPCVisuals(npc);
      placeEntitySafely(npc, G, tx, ty, { char: entry?.char || entry?.legacy || type, maxRadius: 10 });
      out.push(npc);
      try { root.EntityGroups?.assign?.(npc); } catch (_) {}
      try { root.EntityGroups?.register?.(npc, G); } catch (_) {}
    }
    return out;
  }

  function spawnNPCBySubtype(sub, x, y, payload){
    if (!sub) return null;
    if (sub.includes('guard') && root.Entities?.Guardia?.spawn) return root.Entities.Guardia.spawn({ tx: Math.round(x / TILE_SIZE()), ty: Math.round(y / TILE_SIZE()) });
    if (sub.includes('jefe') && root.Entities?.JefeServicio?.spawn) return root.Entities.JefeServicio.spawn(x, y, payload);
    if (sub.includes('supervisor') && root.Entities?.SupervisoraAPI?.spawn) return root.Entities.SupervisoraAPI.spawn(x, y, payload);
    if (sub.includes('celador') && root.Entities?.Celador?.spawn) return root.Entities.Celador.spawn(x, y, payload);
    if (sub.includes('medico') && root.MedicoAPI?.spawn) return root.MedicoAPI.spawn(x, y, payload);
    if (sub.includes('familiar') && root.Entities?.FamiliarMolesto?.spawn) return root.Entities.FamiliarMolesto.spawn(x, y, payload);
    if (sub.includes('tcae') && root.Entities?.TCAE?.spawn) return root.Entities.TCAE.spawn({ tx: Math.round(x / TILE_SIZE()), ty: Math.round(y / TILE_SIZE()) });
    if (sub.includes('limpieza') && root.Entities?.Cleaner?.spawn) return root.Entities.Cleaner.spawn(x, y, payload);
    if (sub.includes('enfermera') && root.Entities?.NurseSexy?.spawn) return root.Entities.NurseSexy.spawn(x, y, payload);
    return null;
  }

  const NPC_RIG_BY_SKIN = {
    'medico.png': 'npc_medico',
    'supervisora.png': 'npc_supervisora',
    'tcae.png': 'npc_tcae',
    'celador.png': 'npc_celador',
    'guardia.png': 'npc_guardia',
    'enfermera_sexy.png': 'npc_enfermera_sexy',
    'familiar_molesto.png': 'npc_familiar_molesto',
    'chica_limpieza.png': 'npc_chica_limpieza',
    'paciente_furiosa.png': 'patient_furiosa'
  };

  function entityLabel(entity){
    if (!entity) return 'desconocido';
    return entity.name || entity.id || entity.tag || entity.sub || entity.kind || 'npc';
  }

  function resolveRigForNPC(entity){
    if (!entity) return null;
    if (entity.puppet?.rigName) return entity.puppet.rigName;
    if (typeof entity.rigName === 'string' && entity.rigName) return entity.rigName;
    const skin = String(entity.skin || '').toLowerCase();
    if (skin && NPC_RIG_BY_SKIN[skin]) return NPC_RIG_BY_SKIN[skin];
    const sub = String(entity.sub || entity.role || '').toLowerCase();
    if (sub){
      const normalized = `npc_${sub.replace(/[^a-z0-9]+/g, '_')}`;
      if (root.Puppet?.RIGS && root.Puppet.RIGS[normalized]) return normalized;
    }
    return null;
  }

  function ensureNPCPuppet(npc){
    if (!npc) return;
    if (npc.puppet && npc.puppet.rigName && npc.rigOk === true) return;
    if (!root.Puppet?.bind && !root.PuppetAPI?.attach) return;
    let rig = resolveRigForNPC(npc);
    const fallback = 'npc_generic_human';
    if (!rig) rig = fallback;
    if (npc.puppet && npc.puppet.rigName === rig && npc.rigOk === true) return;
    const data = { skin: npc.skin };
    try {
      const puppet = root.Puppet?.bind?.(npc, rig, { z: npc.puppet?.z ?? 0, scale: npc.puppet?.scale ?? 1, data })
        || root.PuppetAPI?.attach?.(npc, { rig, z: npc.puppet?.z ?? 0, scale: npc.puppet?.scale ?? 1, data });
      if (puppet){
        npc.rigOk = true;
        npc.rigName = rig;
        if (rig === fallback){
          try { console.warn(`[Placement] NPC ${entityLabel(npc)} sin rig específico, usando '${rig}'.`); } catch (_) {}
        } else {
          try { console.log(`[Placement] NPC ${entityLabel(npc)} vinculado al rig '${rig}'.`); } catch (_) {}
        }
      }
    } catch (err){
      try { console.warn(`[Placement] No se pudo asignar rig '${rig}' a ${entityLabel(npc)}.`, err); } catch (_) {}
    }
  }

  function ensureNPCFlashlight(npc){
    if (!npc || npc.group !== 'human') return;
    if (npc.flashlight === false) return;
    if (npc._flashlightAttached) return;
    const attach = root.Entities?.attachFlashlight;
    if (typeof attach !== 'function') return;
    try {
      const tile = TILE_SIZE();
      const radius = Number.isFinite(npc.flashlightRadius) ? npc.flashlightRadius : tile * 4.8;
      const intensity = Number.isFinite(npc.flashlightIntensity) ? npc.flashlightIntensity : 0.55;
      const color = npc.flashlightColor || '#fff2c0';
      const id = attach(npc, { color, radius, intensity });
      if (id != null){
        npc._flashlightAttached = true;
        npc._flashlightId = id;
        try { console.log(`[Placement] Linterna asignada a ${entityLabel(npc)} (${color}).`); } catch (_) {}
      }
    } catch (err){
      try { console.warn(`[Placement] Error al adjuntar linterna a ${entityLabel(npc)}.`, err); } catch (_) {}
    }
  }

  function ensureNPCVisuals(npc){
    ensureNPCPuppet(npc);
    ensureNPCFlashlight(npc);
  }

  function spawnFuriousFromPlacement(x, y, cfg, G){
    const tile = TILE_SIZE();
    const size = tile * 0.9;
    const px = x - size * 0.5;
    const py = y - size * 0.5;
    if (root.FuriousAPI?.spawnFromPatient) {
      const stub = {
        x: px,
        y: py,
        w: size,
        h: size,
        vx: 0,
        vy: 0,
        dead: false,
        kind: 'PATIENT'
      };
      try {
        if (Array.isArray(G?.entities)) G.entities.push(stub);
        if (Array.isArray(G?.patients)) G.patients.push(stub);
        const spawned = root.FuriousAPI.spawnFromPatient(stub, { skipCounters: true });
        if (spawned) return spawned;
      } catch (err) {
        try { console.warn('[Placement] FuriousAPI.spawnFromPatient', err); } catch (_) {}
      } finally {
        if (Array.isArray(G?.patients)) {
          const idx = G.patients.indexOf(stub);
          if (idx >= 0) G.patients.splice(idx, 1);
        }
        if (Array.isArray(G?.entities)) {
          const idx = G.entities.indexOf(stub);
          if (idx >= 0) {
            try {
              if (typeof root.detachEntityRig === 'function') {
                root.detachEntityRig(stub);
              } else {
                root.PuppetAPI?.detach?.(stub);
              }
            } catch (_) {}
            G.entities.splice(idx, 1);
          }
        }
      }
    }
    const furious = {
      kind: 'FURIOUS',
      x: px,
      y: py,
      w: size,
      h: size,
      vx: 0,
      vy: 0,
      solid: true,
      dynamic: true,
      pushable: true,
      rigOk: false
    };
    try {
      const puppet = root.Puppet?.bind?.(furious, 'patient_furiosa', { z: 0, scale: 1 })
        || root.PuppetAPI?.attach?.(furious, { rig: 'patient_furiosa', z: 0, scale: 1 });
      if (puppet) furious.rigOk = true;
    } catch (_) {}
    ensureNPCVisuals(furious);
    return furious;
  }

  function spawnEnemiesPack(cfg, G){
    const out = [];
    for (const entry of getPlacements(cfg)) {
      const type = String(entry?.type || '').toLowerCase();
      const subtype = String(entry?.sub || '').toLowerCase();
      const { tx, ty } = normalizePlacementToTile(entry, cfg);
      const world = toWorld(tx, ty);
      const char = fallbackCharForPlacement(entry, subtype || type);
      let failReason = '';
      let entity = null;
      try {
        if (type === 'enemy' || type === 'spawner') {
          if (subtype.includes('mosquito') && root.MosquitoAPI?.spawn) {
            entity = root.MosquitoAPI.spawn(world.x, world.y, { _units: 'px' });
          } else if (subtype.includes('rat') && root.RatsAPI?.spawn) {
            entity = root.RatsAPI.spawn(world.x, world.y, { _units: 'px' });
          } else if (subtype.includes('furious')) {
            entity = spawnFuriousFromPlacement(world.x, world.y, cfg, G);
          }
        }
        if (!entity && type === 'mosquito' && root.MosquitoAPI?.spawn) {
          entity = root.MosquitoAPI.spawn(world.x, world.y, { _units: 'px' });
        }
        if (!entity && type === 'rat' && root.RatsAPI?.spawn) {
          entity = root.RatsAPI.spawn(world.x, world.y, { _units: 'px' });
        }
      } catch (err) {
        failReason = err?.message || String(err);
      }
      if (!entity && !failReason) failReason = 'Enemy spawn returned null';
      if (!entity && root.PlacementAPI?.spawnFallbackPlaceholder) {
        const def = { kind: subtype || type, factoryKey: subtype || type, type };
        const fallback = root.PlacementAPI.spawnFallbackPlaceholder(char, def, tx, ty, failReason || 'Enemy spawn failed', { G, map: cfg?.map, autoRegister: false });
        if (fallback) {
          if (!fallback.group) {
            if (subtype.includes('furious')) fallback.group = 'human';
            else fallback.group = 'animal';
          }
          ensureNPCVisuals(fallback);
          placeEntitySafely(fallback, G, tx, ty, { char, maxRadius: 10 });
          out.push(fallback);
        }
        continue;
      }
      if (entity) {
        entity.rigOk = entity.rigOk === true;
        if (!entity.group) {
          if (subtype.includes('mosquito') || type === 'mosquito') {
            entity.group = 'animal';
          } else if (subtype.includes('rat') || type === 'rat') {
            entity.group = 'animal';
          } else if (subtype.includes('furious')) {
            entity.group = 'human';
          }
        }
        if (entity.hostile !== true) entity.hostile = true;
        ensureNPCVisuals(entity);
        placeEntitySafely(entity, G, tx, ty, { char: entry?.char || subtype || type, maxRadius: 10 });
        out.push(entity);
        try { root.EntityGroups?.assign?.(entity); } catch (_) {}
        try { root.EntityGroups?.register?.(entity, G); } catch (_) {}
        if (Array.isArray(G.hostiles) && !G.hostiles.includes(entity)) {
          G.hostiles.push(entity);
        }
      }
    }
    return out;
  }

  function spawnWorldObjects(cfg, G){
    const out = [];
    for (const entry of getPlacements(cfg)) {
      const type = String(entry?.type || '').toLowerCase();
      const { tx, ty } = normalizePlacementToTile(entry, cfg);
      const world = toWorld(tx, ty);
      const char = fallbackCharForPlacement(entry, type);
      let failReason = '';
      let entity = null;
      try {
        if (type === 'cart' && root.Entities?.Cart?.spawn) {
          const sub = String(entry?.sub || '').toLowerCase();
          const normalized = sub === 'urgencias' ? 'er'
            : (sub === 'medicinas' || sub === 'meds' ? 'med'
            : (sub === 'comida' || sub === 'food' ? 'food' : (sub || 'med')));
          const payload = { ...entry, sub: normalized };
          entity = root.Entities.Cart.spawn(normalized, world.x, world.y, payload);
          if (entity) {
            placeEntitySafely(entity, G, tx, ty, { char: entry?.char || type, maxRadius: 8 });
          }
        } else if (type === 'door' && root.Entities?.Door?.spawn) {
          entity = root.Entities.Door.spawn(world.x, world.y, entry || {});
        } else if (type === 'boss_door' && root.Entities?.Door?.spawn) {
          const payload = { ...(entry || {}), bossDoor: true };
          entity = root.Entities.Door.spawn(world.x, world.y, payload);
        } else if (type === 'elevator' && root.Entities?.Elevator?.spawn) {
          entity = root.Entities.Elevator.spawn(world.x, world.y, entry || {});
        } else if (type === 'light' && root.Entities?.Light?.spawn) {
          const light = root.Entities.Light.spawn(world.x + TILE_SIZE() * 0.5, world.y + TILE_SIZE() * 0.5, entry || {});
          if (light) {
            light.isBroken = !!entry?.broken;
            entity = light;
          }
        } else if (type === 'boss_light' && root.Entities?.BossLight) {
          const light = root.Entities.spawnFromPlacement_BossLight?.({ ...entry, x: world.x, y: world.y })
            || root.Entities.BossLight.spawn?.(world.x, world.y, entry || {});
          if (light) entity = light;
        } else if (type === 'phone') {
          entity = root.PhoneAPI?.spawnPhone?.(world.x, world.y, entry || {})
            || root.spawnPhone?.(world.x, world.y, entry || {});
        } else if (type === 'bell') {
          entity = spawnBell(tx, ty, entry || {}, cfg, G);
        } else if (type === 'hazard_wet') {
          if (root.HazardsAPI?.spawnWet) {
            entity = root.HazardsAPI.spawnWet(tx, ty, entry || {});
          } else {
            failReason = 'HazardsAPI.spawnWet missing';
          }
        } else if (type === 'hazard_fire') {
          if (root.HazardsAPI?.spawnFire) {
            entity = root.HazardsAPI.spawnFire(tx, ty, entry || {});
          } else {
            failReason = 'HazardsAPI.spawnFire missing';
          }
        }
      } catch (err) {
        failReason = err?.message || String(err);
      }
      if (!entity && !failReason) failReason = 'World object spawn returned null';
      if (!entity && root.PlacementAPI?.spawnFallbackPlaceholder) {
        const def = { kind: entry?.kind || type, factoryKey: entry?.factoryKey || type, type };
        const fallback = root.PlacementAPI.spawnFallbackPlaceholder(char, def, tx, ty, failReason || 'World object spawn failed', { G, map: cfg?.map, autoRegister: false });
        if (fallback) {
          if (!fallback.group) {
            fallback.group = type.startsWith('hazard') ? 'hazard' : 'object';
          }
          placeEntitySafely(fallback, G, tx, ty, { char, maxRadius: 6 });
          out.push(fallback);
        }
        continue;
      }
      if (entity) {
        entity.rigOk = entity.rigOk === true || true;
        if (!entity.group) entity.group = type.startsWith('hazard') ? 'hazard' : 'object';
        out.push(entity);
        try { root.EntityGroups?.assign?.(entity); } catch (_) {}
        try { root.EntityGroups?.register?.(entity, G); } catch (_) {}
      }
    }
    return out;
  }

  function findPatientById(G, id){
    if (!id) return null;
    if (Array.isArray(G?.patients)) {
      return G.patients.find((p) => p && p.id === id) || null;
    }
    return null;
  }

  function genFunnyName(){
    const pool = ['Dolores Barriga', 'Ana Lgésica', 'Tomás Tico'];
    return pool[(Math.random() * pool.length) | 0];
  }

  function pillCodeFromName(){
    return 'DOLORITINA';
  }

  function cryptoRand(){
    try {
      return root.crypto?.getRandomValues(new Uint32Array(1))[0];
    } catch (_) {
      return (Math.random() * 1e9) | 0;
    }
  }

  Placement.applyPlacementsFromMapGen = Placement.applyFromAsciiMap;
})();
