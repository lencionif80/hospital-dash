// Entities.Guardia: NPC humano hostil y muy resistente con IA avanzada.
(function (root) {
  'use strict';

  const W = root || window;
  const G = W.G || (W.G = {});
  const DamageAPI = W.DamageAPI || null;
  const PhysicsAPI = W.PhysicsAPI || null;
  const PuppetAPI = W.PuppetAPI || null;
  const DoorAPI = W.DoorAPI || null;
  const ENT = (function ensureEnt(ns) {
    const e = ns || {};
    if (typeof e.GUARD === 'undefined') e.GUARD = 960;
    if (typeof e.CART === 'undefined') e.CART = 401;
    if (typeof e.CART_FOOD === 'undefined') e.CART_FOOD = 402;
    if (typeof e.CART_MED === 'undefined') e.CART_MED = 403;
    if (typeof e.CART_URG === 'undefined') e.CART_URG = 404;
    if (typeof e.DOOR_NORMAL === 'undefined') e.DOOR_NORMAL = 501;
    if (typeof e.DOOR_BOSS === 'undefined') e.DOOR_BOSS = 502;
    return e;
  })(W.ENT || (W.ENT = {}));

  const TILE = W.TILE_SIZE || W.TILE || 32;
  const HERO_Z = typeof W.HERO_Z === 'number' ? W.HERO_Z : 10;
  const HP_PER_HEART = W.HP_PER_HEART || 1;
  const MELEE_RANGE = 20;
  const GUN_RANGE = 160;
  const GUARD_SPEED = 40;
  const CART_PUSH_RADIUS = TILE * 4;
  const CART_PUSH_FORCE = 260;

  const DEBUG_GUARD = W.DEBUG_GUARD || false;

  function ensureCollections() {
    if (!Array.isArray(G.entities)) G.entities = [];
    if (!Array.isArray(G.npcs)) G.npcs = [];
  }

  function overlap(a, b) {
    return a && b && a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  }

  function hasLineOfSight(a, b) {
    const map = G.map;
    if (!Array.isArray(map) || !map.length) return true;
    const dx = (b.x || 0) - (a.x || 0);
    const dy = (b.y || 0) - (a.y || 0);
    const dist = Math.hypot(dx, dy) || 1;
    const steps = Math.max(2, Math.ceil(dist / (TILE * 0.5)));
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      const px = (a.x || 0) + dx * t;
      const py = (a.y || 0) + dy * t;
      const tx = Math.floor(px / TILE);
      const ty = Math.floor(py / TILE);
      if (map?.[ty]?.[tx] === 1) return false;
    }
    return true;
  }

  function normalize(dx, dy) {
    const len = Math.hypot(dx, dy) || 1;
    return { x: dx / len, y: dy / len };
  }

  function moveWithPhysics(e, dt) {
    if (PhysicsAPI?.moveEntity) {
      PhysicsAPI.moveEntity(e, dt);
    } else {
      e.x += (e.vx || 0) * dt;
      e.y += (e.vy || 0) * dt;
    }
  }

  function isCart(ent) {
    if (!ent || ent.dead) return false;
    const kinds = [ENT.CART, ENT.CART_FOOD, ENT.CART_MED, ENT.CART_URG];
    if (kinds.includes(ent.kind)) return true;
    return Boolean(ent.cartType || ent.cart || ent.isCart);
  }

  function maybeCloseNearbyDoors(e) {
    const entities = G.entities || [];
    const player = G.player;
    for (const door of entities) {
      if (!door || door.dead) continue;
      if (!(door.isDoor || door.kind === ENT.DOOR_NORMAL || door.kind === ENT.DOOR_BOSS || door.kind === 'door_normal')) continue;
      const dx = (door.x || 0) - e.x;
      const dy = (door.y || 0) - e.y;
      const distSq = dx * dx + dy * dy;
      if (distSq > (TILE * 3) * (TILE * 3)) continue;
      const doorOpen = door.isOpen || door.open || door.state === 'open';
      if (!doorOpen) continue;
      if (player) {
        const heroSide = Math.sign((player.x || 0) - (door.x || 0));
        const guardSide = Math.sign((e.x || 0) - (door.x || 0));
        if (heroSide === guardSide) continue;
      }
      if (DoorAPI?.closeDoor) {
        try { DoorAPI.closeDoor(door, e); } catch (_) {}
      }
      door.isOpen = false; door.open = false; door.state = 'closed'; door.solid = true;
    }
  }

  function maybeUseElevatorSmart(e, player) {
    if (!player) return;
    if (W.Entities?.Elevator?.maybeChase) {
      try { W.Entities.Elevator.maybeChase(e, player); return; } catch (_) {}
    }
    if (W.ElevatorAPI?.assistNPC) {
      try { W.ElevatorAPI.assistNPC(e, player); return; } catch (_) {}
    }
  }

  function maybePushNearestCartTowardsPlayer(e, player) {
    if (!player) return;
    const entities = G.entities || [];
    let best = null;
    let bestScore = -Infinity;
    const radiusSq = CART_PUSH_RADIUS * CART_PUSH_RADIUS;
    for (const ent of entities) {
      if (!isCart(ent)) continue;
      const dx = ent.x - e.x;
      const dy = ent.y - e.y;
      const distSq = dx * dx + dy * dy;
      if (distSq > radiusSq) continue;
      if (!hasLineOfSight(e, ent)) continue;
      const toHero = normalize(player.x - ent.x, player.y - ent.y);
      const alignment = Math.abs(toHero.x) + Math.abs(toHero.y);
      const score = -Math.sqrt(distSq) + alignment * 5 + (hasLineOfSight(ent, player) ? 6 : 0);
      if (score > bestScore) { bestScore = score; best = ent; }
    }
    if (!best) return;
    const dir = normalize(player.x - best.x, player.y - best.y);
    if (Math.abs(dir.x) < 0.2 && Math.abs(dir.y) < 0.2) return;
    best.vx = (best.vx || 0) + dir.x * CART_PUSH_FORCE;
    best.vy = (best.vy || 0) + dir.y * CART_PUSH_FORCE;
    e.isPushing = true;
    if (DEBUG_GUARD) console.log('[GUARD] pushing cart', best.id);
  }

  function shootGuardBullet(e, dirX, dirY) {
    if (!dirX && !dirY) return;
    const speed = 240;
    const bullet = {
      id: W.genId ? W.genId() : `guard-bullet-${Math.random().toString(36).slice(2)}`,
      kind: 'guard_bullet',
      role: 'projectile',
      x: e.x,
      y: e.y,
      w: 10,
      h: 10,
      vx: dirX * speed,
      vy: dirY * speed,
      solid: false,
      touchDamage: 1,
      touchCooldown: 0.2,
      _touchCD: 0,
      isHazard: true,
      puppet: { rig: 'projectile_yogurt', z: HERO_Z, skin: 'default' },
      life: 1.4,
      aiUpdate(dt, self) {
        self.life -= dt;
        if (self.life <= 0) { self.dead = true; return; }
        moveWithPhysics(self, dt);
        if (W.G && Array.isArray(G.map)) {
          const tx = Math.floor(self.x / TILE);
          const ty = Math.floor(self.y / TILE);
          if (G.map?.[ty]?.[tx] === 1) { self.dead = true; }
        }
        if (overlap(self, G.player)) {
          DamageAPI?.applyTouch?.(self, G.player);
          self.dead = true;
        }
      }
    };
    if (W.safeAttachRig) W.safeAttachRig(bullet, bullet.puppet, 'guardia.bullet');
    else try { PuppetAPI?.attach?.(bullet, bullet.puppet); } catch (_) { bullet.rigOk = false; }
    G.entities.push(bullet);
    G.movers?.push?.(bullet);
    if (DEBUG_GUARD) console.log('[GUARD] shot bullet', bullet.id);
    return bullet;
  }

  function guardAiUpdate(dt, e) {
    if (e.dead) return;
    if (e._touchCD > 0) e._touchCD -= dt;
    const player = G.player;
    if (!player) return;

    const dx = player.x - e.x;
    const dy = player.y - e.y;
    const dist = Math.hypot(dx, dy) || 1;

    maybeCloseNearbyDoors(e);
    maybeUseElevatorSmart(e, player);
    maybePushNearestCartTowardsPlayer(e, player);

    e.isAttacking = false;
    e.isPushing = false;

    if (dist < MELEE_RANGE) {
      e.vx = 0; e.vy = 0;
      e.isAttacking = true;
      e.state = 'attack';
      if (overlap(e, player)) {
        DamageAPI?.applyTouch?.(e, player);
      }
    } else if (dist < GUN_RANGE) {
      e.vx = 0; e.vy = 0;
      e.state = 'attack';
      shootGuardBullet(e, dx / dist, dy / dist);
    } else {
      const v = GUARD_SPEED;
      e.vx = (dx / dist) * v;
      e.vy = (dy / dist) * v;
      e.state = Math.abs(e.vx) > Math.abs(e.vy) ? 'walk_h' : 'walk_v';
    }
  }

  function guardPhysics(dt, e) {
    moveWithPhysics(e, dt);
  }

  function guardOnDamage(e, amount, cause) {
    if (e.dead) return;
    if (cause === 'fire' && e.fireImmune) return;
    e.health -= amount;
    if (e.health <= 0) {
      e.health = 0;
      e.dead = true;
      e.state = 'dead';
      e.deathCause = cause || 'damage';
      e.vx = e.vy = 0;
      if (!e._notifiedDeath) {
        e._notifiedDeath = true;
        try { W.SpawnerAPI?.notifyDeath?.({ entity: e, populationType: 'humans', template: 'guard' }); } catch (_) {}
      }
      if (DEBUG_GUARD) console.log('[GUARD] dead', e.deathCause);
      return;
    }
  }

  function guardOnCrush(e) {
    guardOnDamage(e, e.health || 1, 'crush');
  }

  function guardOnFire(e) {
    guardOnDamage(e, e.health || 1, 'fire');
  }

  function spawnGuardia(x, y, cfg = {}) {
    ensureCollections();
    const health = cfg.health ?? 6 * HP_PER_HEART;
    const e = {
      id: W.genId ? W.genId() : `guard-${Math.random().toString(36).slice(2)}`,
      kind: ENT.GUARD,
      role: 'npc',
      populationType: 'humans',
      x,
      y,
      w: 24,
      h: 24,
      dir: 0,
      vx: 0,
      vy: 0,
      solid: true,
      health,
      maxHealth: health,
      touchDamage: cfg.touchDamage ?? 1,
      touchCooldown: cfg.touchCooldown ?? 0.9,
      _touchCD: 0,
      fireImmune: false,
      state: 'idle',
      deathCause: null,
      puppet: { rig: 'npc_guard', z: HERO_Z, skin: 'default' },
      aiUpdate: guardAiUpdate,
      physicsUpdate: guardPhysics,
      onDamage: guardOnDamage,
      onCrush: guardOnCrush,
      onFire: guardOnFire,
    };

    if (W.safeAttachRig) W.safeAttachRig(e, e.puppet, 'guardia');
    else try { PuppetAPI?.attach?.(e, e.puppet); } catch (_) { e.rigOk = false; }
    G.entities.push(e);
    G.npcs.push(e);
    if (DEBUG_GUARD) console.log('[GUARD] spawned at', e.x, e.y);
    return e;
  }

  function spawnGuardiaAtTile(tx, ty, cfg) {
    const cx = (tx + 0.5) * TILE;
    const cy = (ty + 0.5) * TILE;
    return spawnGuardia(cx, cy, cfg);
  }

  const GuardiaAPI = {
    spawn: spawnGuardia,
    aiUpdate: guardAiUpdate,
    spawnFromAscii(tx, ty, def) { return spawnGuardiaAtTile(tx, ty, def || {}); },
    updateAll(dt = 0) {
      for (const e of G.entities || []) {
        if (e && e.kind === ENT.GUARD) guardAiUpdate(dt, e);
      }
    },
  };

  W.Entities = W.Entities || {};
  W.Entities.Guardia = GuardiaAPI;
})(window);
