// assets/plugins/entities/elevators.entities.js
// Entidad de ascensor emparejado con animación chibi y cooldown
(function (W) {
  'use strict';

  const root = W || window;
  const G = root.G || (root.G = {});
  const ENT = (function ensureEnt(ns) {
    const e = ns || {};
    if (typeof e.ELEVATOR === 'undefined') e.ELEVATOR = 'elevator';
    return e;
  })(root.ENT || (root.ENT = {}));

  const TILE = root.TILE_SIZE || root.TILE || 32;
  const HERO_Z = typeof root.HERO_Z === 'number' ? root.HERO_Z : 10;

  const OPEN_TIME = 0.4;
  const OPEN_HOLD = 0.3;

  const elevators = [];

  function resetList() {
    elevators.length = 0;
  }

  function overlap(a, b) {
    if (!a || !b) return false;
    const ax1 = a.x - (a.w || 0) * 0.5;
    const ay1 = a.y - (a.h || 0) * 0.5;
    const ax2 = ax1 + (a.w || 0);
    const ay2 = ay1 + (a.h || 0);
    const bx1 = b.x - (b.w || 0) * 0.5;
    const by1 = b.y - (b.h || 0) * 0.5;
    const bx2 = bx1 + (b.w || 0);
    const by2 = by1 + (b.h || 0);
    return !(ax2 <= bx1 || bx2 <= ax1 || ay2 <= by1 || by2 <= ay1);
  }

  function logDebug(msg, payload) {
    if (!root.DEBUG_ELEVATOR) return;
    try {
      console.log(msg, payload || '');
    } catch (_) {}
  }

  function attachRig(e) {
    try {
      root.PuppetAPI?.attach?.(e, e.puppet);
    } catch (_) {}
  }

  function registerEntity(e) {
    try { root.EntityGroups?.assign?.(e); } catch (_) {}
    try { root.EntityGroups?.register?.(e, G); } catch (_) {}
    if (Array.isArray(G.entities) && !G.entities.includes(e)) G.entities.push(e);
  }

  function createElevator(x, y, opts = {}) {
    const e = {
      id: root.genId ? root.genId() : `elev_${Date.now()}_${Math.random().toString(16).slice(2)}`,
      kind: ENT.ELEVATOR,
      role: 'elevator',
      x,
      y,
      w: 24,
      h: 24,
      vx: 0,
      vy: 0,
      dir: 0,
      solid: false,
      isTileWalkable: true,
      health: opts.health ?? 3,
      maxHealth: opts.maxHealth ?? 3,
      touchDamage: 0,
      touchCooldown: 0.9,
      _touchCD: 0,
      fireImmune: true,
      populationType: 'none',
      aiState: 'idle_closed',
      aiTimer: 0,
      aiUpdate: elevatorAiUpdate,
      pairId: opts.pairId ?? null,
      pairedElevator: null,
      cooldown: 0,
      cooldownMax: opts.cooldownMax ?? 4,
      activationRadius: opts.activationRadius ?? 10,
      isBusy: false,
      puppet: {
        rig: 'elevator_box',
        z: HERO_Z,
        skin: opts.skin || 'elevator_default',
      },
      group: 'elevators',
    };

    attachRig(e);
    registerEntity(e);
    elevators.push(e);
    logDebug('[Elevator] Created', e.id);
    return e;
  }

  function findEntityOnElevator(e) {
    const candidates = [];
    if (G.player) candidates.push(G.player);
    if (Array.isArray(G.humans)) {
      for (const h of G.humans) if (h && h !== G.player) candidates.push(h);
    }
    for (const ent of candidates) {
      if (ent.dead) continue;
      if (overlap(e, ent)) return ent;
      const dx = (ent.x || 0) - e.x;
      const dy = (ent.y || 0) - e.y;
      if (Math.hypot(dx, dy) <= (e.activationRadius || 10)) return ent;
    }
    return null;
  }

  function teleportEntity(src, dst, ent) {
    if (!dst || !ent) return;
    // Teletransporte instantáneo manteniendo centro y pequeño offset vertical
    ent.x = dst.x;
    ent.y = dst.y + 2; // pequeño offset para evitar reactivación inmediata
    if (ent === G.player) {
      try { root.AudioAPI?.play?.('elevator_travel', { x: dst.x, y: dst.y }); } catch (_) {}
    }
    logDebug(`[Elevator] Teleport hero from pair #${src.pairId}`);
  }

  function setCooldown(a, b, value) {
    a.cooldown = Math.max(0, value);
    b.cooldown = Math.max(0, value);
    a.isBusy = true; b.isBusy = true;
  }

  function elevatorAiUpdate(e, dt = 0, forcedEnt = null) {
    if (!e || e.dead) return;

    if (e.cooldown > 0) {
      e.cooldown -= dt;
      if (e.cooldown <= 0) {
        e.cooldown = 0;
      }
    }

    if (!e.pairedElevator) {
      e.aiState = 'idle_closed';
      e.isBusy = false;
      return;
    }

    const occupant = forcedEnt || findEntityOnElevator(e);

    switch (e.aiState) {
      case 'idle_closed': {
        if (occupant && e.cooldown <= 0 && !e.isBusy && !e.pairedElevator.isBusy) {
          e.aiState = 'opening';
          e.aiTimer = OPEN_TIME;
          try { root.AudioAPI?.play?.('elevator_open', { x: e.x, y: e.y }); } catch (_) {}
        }
        break;
      }
      case 'opening': {
        e.aiTimer -= dt;
        if (e.aiTimer <= 0) {
          const dst = e.pairedElevator;
          const target = occupant || G.player;
          if (dst && target) {
            teleportEntity(e, dst, target);
            setCooldown(e, dst, e.cooldownMax);
            e.aiState = 'open';
            e.aiTimer = OPEN_HOLD;
            dst.aiState = 'open';
            dst.aiTimer = OPEN_HOLD;
          } else {
            e.aiState = 'idle_closed';
          }
        }
        break;
      }
      case 'open': {
        e.aiTimer -= dt;
        if (e.aiTimer <= 0) {
          e.aiState = e.cooldown > 0 ? 'cooldown' : 'idle_closed';
        }
        break;
      }
      case 'cooldown': {
        if (e.cooldown <= 0) {
          e.isBusy = false;
          e.aiState = 'idle_closed';
          try { root.AudioAPI?.play?.('elevator_close', { x: e.x, y: e.y }); } catch (_) {}
        }
        break;
      }
      default:
        e.aiState = 'idle_closed';
    }
  }

  function travel(elevator, ent) {
    if (!elevator || !elevator.pairedElevator) return false;
    if (elevator.cooldown > 0 || elevator.isBusy || elevator.pairedElevator.isBusy) return false;
    elevator.aiState = 'opening';
    elevator.aiTimer = OPEN_TIME;
    elevator._forceEntity = ent;
    return true;
  }

  function update(dt = 0) {
    for (const e of elevators) {
      if (!e || e.dead) continue;
      const occupant = e._forceEntity;
      if (occupant) e._forceEntity = null;
      e.aiUpdate?.(e, dt, occupant);
    }
  }

  function forceActivate(pairId) {
    for (const e of elevators) {
      if (e.pairId === pairId || e.id === pairId) {
        travel(e, G.player);
        return true;
      }
    }
    return false;
  }

  root.Entities = root.Entities || {};
  root.Entities.Elevator = {
    spawn(x, y, opts) { return createElevator(x, y, opts); },
    update,
    travel,
    forceActivate,
    reset: resetList,
    list: elevators,
    create: createElevator,
  };

  // API ligera para MapGen/Placement
  root.createElevator = root.createElevator || createElevator;
})(typeof window !== 'undefined' ? window : globalThis);
