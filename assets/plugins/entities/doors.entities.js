// assets/plugins/entities/doors.entities.js
// Sistema completo de puertas de hospital (normales y de urgencias)
(function (W) {
  'use strict';

  const root = W || window;
  const G = root.G || (root.G = {});
  const ENT = (function ensureEnt(ns) {
    const e = ns || {};
    if (typeof e.DOOR_NORMAL === 'undefined') e.DOOR_NORMAL = 'door_normal';
    if (typeof e.DOOR_URGENT === 'undefined') e.DOOR_URGENT = 'door_urgent';
    return e;
  })(root.ENT || (root.ENT = {}));

  const TILE = root.TILE_SIZE || root.TILE || 32;
  const HERO_Z = typeof root.HERO_Z === 'number' ? root.HERO_Z : 10;

  const DOOR_NEAR_DIST = 32;
  const OPEN_TIME = 0.35;
  const CLOSE_TIME = 0.35;
  const HOLD_TIME = 1.5;

  const doors = [];

  function toPxFromTile(t) {
    return t * TILE + TILE / 2;
  }

  function attachRig(e) {
    try {
      root.PuppetAPI?.attach?.(e, e.puppet);
      e.rigOk = true;
    } catch (err) {
      e.rigOk = false;
      if (root.DEBUG_RIGS) console.warn('[DoorRig] No se pudo adjuntar rig', err);
    }
  }

  function registerEntity(e) {
    try { root.EntityGroups?.assign?.(e); } catch (_) {}
    try { root.EntityGroups?.register?.(e, G); } catch (_) {}
    if (Array.isArray(G.entities) && !G.entities.includes(e)) G.entities.push(e);
  }

  function changeState(e, newState) {
    if (!e || e.aiState === newState) return;
    e.aiState = newState;
    e.aiTimer = 0;
    try { console.log(`[DOOR] ${e.kind} -> ${newState}`); } catch (_) {}
  }

  function isTileOnFire(tx, ty) {
    const api = root.FireAPI || root.Entities?.Fire;
    if (!api) return false;
    if (typeof api.isTileOnFire === 'function') return !!api.isTileOnFire(tx, ty);
    if (typeof api.isOnTile === 'function') return !!api.isOnTile(tx, ty);
    const fires = api.getActive?.();
    if (Array.isArray(fires)) {
      for (const f of fires) {
        const fx = Math.floor((f?.x ?? 0) / TILE);
        const fy = Math.floor((f?.y ?? 0) / TILE);
        if (fx === tx && fy === ty) return true;
      }
    }
    return false;
  }

  function canUrgentDoorOpen() {
    if (root.GameFlowAPI?.areAllPatientsCleared?.()) return true;
    if (typeof G.patientsRemaining === 'number') return G.patientsRemaining <= 0;
    if (typeof root.Gameflow?.patientsRemaining === 'number') return root.Gameflow.patientsRemaining <= 0;
    return false;
  }

  function playAudio(id, e) {
    if (!id) return;
    try { root.AudioAPI?.play?.(id, { x: e?.x, y: e?.y }); } catch (_) {}
  }

  function doorAiUpdate(e, dt = 0) {
    if (!e || e.dead) return;

    const tx = Math.floor(e.x / TILE);
    const ty = Math.floor(e.y / TILE);
    const burning = isTileOnFire(tx, ty);

    if (burning) {
      e.burnTimer = (e.burnTimer || 0) + dt;
      if (e.aiState !== 'burning' && e.aiState !== 'burnt') changeState(e, 'burning');
    } else {
      e.burnTimer = Math.max(0, (e.burnTimer || 0) - dt * 0.02);
    }

    if (e.burnTimer >= (e.burnThreshold || 60) && e.aiState !== 'burnt') {
      e.solid = false;
      e.isTileWalkable = true;
      e.state = 'dead';
      e.deathCause = 'fire';
      changeState(e, 'burnt');
      playAudio('door_break', e);
      return;
    }

    if (e.aiState === 'burnt') return;

    const player = G.player;
    const px = player ? (player.x + (player.w || 0) * 0.5) : 0;
    const py = player ? (player.y + (player.h || 0) * 0.5) : 0;
    const dist = player ? Math.hypot(px - e.x, py - e.y) : Infinity;
    const near = dist < (e.proximity || DOOR_NEAR_DIST);

    const urgentOk = !e.isUrgent || canUrgentDoorOpen();

    switch (e.aiState) {
      case 'closed': {
        e.solid = true;
        e.isTileWalkable = false;
        e.isOpen = false;
        if (near) {
          if (!urgentOk) {
            if (!e._warnedUrgent) {
              e._warnedUrgent = true;
              try { console.warn('[URGENT_DOOR] Bloqueada: aún quedan pacientes vivos.'); } catch (_) {}
              playAudio('error', e);
            }
          } else {
            changeState(e, 'opening');
            playAudio(e.audioProfile?.open || 'door_open', e);
          }
        }
        break;
      }
      case 'opening': {
        e.aiTimer += dt;
        if (e.aiTimer >= OPEN_TIME) {
          e.solid = false;
          e.isTileWalkable = true;
          e.isOpen = true;
          changeState(e, 'open');
        }
        break;
      }
      case 'open': {
        e.solid = false;
        e.isTileWalkable = true;
        e.isOpen = true;
        e.aiTimer += dt;
        if (near) {
          e.aiTimer = 0;
        } else if (e.aiTimer >= HOLD_TIME) {
          changeState(e, 'closing');
          playAudio(e.audioProfile?.close || 'door_close', e);
        }
        break;
      }
      case 'closing': {
        e.aiTimer += dt;
        if (near) {
          changeState(e, 'opening');
          playAudio(e.audioProfile?.open || 'door_open', e);
          break;
        }
        if (e.aiTimer >= CLOSE_TIME) {
          e.solid = true;
          e.isTileWalkable = false;
          e.isOpen = false;
          changeState(e, 'closed');
        }
        break;
      }
      case 'burning': {
        e.solid = false;
        e.isTileWalkable = true;
        e.isOpen = true;
        break;
      }
      default:
        changeState(e, 'closed');
        break;
    }
  }

  function createBaseDoor(kind, x, y, isUrgent) {
    const e = {
      id: root.genId ? root.genId() : Math.random().toString(36).slice(2),
      kind,
      role: 'door',
      populationType: 'doors',
      group: 'doors',
      isDoor: true,
      x,
      y,
      w: 24,
      h: 24,
      dir: 0,
      vx: 0,
      vy: 0,
      solid: true,
      isTileWalkable: false,
      health: 5,
      maxHealth: 5,
      fireImmune: false,
      touchDamage: 0,
      touchCooldown: 0.9,
      _touchCD: 0,
      aiState: 'closed',
      aiTimer: 0,
      burnTimer: 0,
      burnThreshold: 60,
      state: 'idle',
      deathCause: null,
      isUrgent: !!isUrgent,
      puppet: {
        rig: isUrgent ? 'door_hospital_urgent' : 'door_hospital',
        z: HERO_Z,
        skin: isUrgent ? 'door_urgent_red' : 'door_normal_green'
      },
      audioProfile: { open: 'door_open', close: 'door_close' },
      aiUpdate: doorAiUpdate
    };

    attachRig(e);
    registerEntity(e);
    doors.push(e);
    return e;
  }

  function spawnNormalDoor(px, py, opts = {}) {
    const x = typeof px === 'number' ? px : toPxFromTile(opts.tx || 0);
    const y = typeof py === 'number' ? py : toPxFromTile(opts.ty || 0);
    return createBaseDoor(ENT.DOOR_NORMAL, x, y, false);
  }

  function spawnUrgentDoor(px, py, opts = {}) {
    const x = typeof px === 'number' ? px : toPxFromTile(opts.tx || 0);
    const y = typeof py === 'number' ? py : toPxFromTile(opts.ty || 0);
    return createBaseDoor(ENT.DOOR_URGENT, x, y, true);
  }

  function spawnDoorFromAscii(tx, ty, opts = {}, isUrgent = false) {
    return isUrgent ? spawnUrgentDoor(undefined, undefined, { ...opts, tx, ty }) : spawnNormalDoor(undefined, undefined, { ...opts, tx, ty });
  }

  function updateAllDoors(dt) {
    for (const d of doors) {
      if (!d) continue;
      doorAiUpdate(d, dt);
    }
  }

  root.Entities = root.Entities || {};
  root.Entities.Doors = {
    spawnNormalDoor,
    spawnUrgentDoor,
    updateAllDoors,
    doorAiUpdate,
    _all: doors
  };

  root.Entities[ENT.DOOR_NORMAL] = { spawnFromAscii: (tx, ty, opts = {}) => spawnDoorFromAscii(tx, ty, opts, false) };
  root.Entities[ENT.DOOR_URGENT] = { spawnFromAscii: (tx, ty, opts = {}) => spawnDoorFromAscii(tx, ty, opts, true) };
})(typeof window !== 'undefined' ? window : globalThis);
