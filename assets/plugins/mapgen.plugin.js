// filename: mapgen.plugin.js
// ─────────────────────────────────────────────────────────────────────────────
// MapGenAPI – Generador procedural ASCII para “Il Divo: Hospital Dash!”
//
// ✔ Niveles: 1 → 350×350, 2 → 700×700, 3 → 1050×1050 (configurable).
// ✔ Habitaciones con ÚNICA puerta (normal) y Boss-Room con puerta ESPECIAL.
// ✔ Pasillos laberínticos + cul-de-sacs (callejones sin salida).
// ✔ Sala de Control (spawn héroe) con teléfono, lejos de la Boss-Room.
// ✔ Conectividad garantizada: todo accesible desde Control (menos Boss mientras esté cerrada).
// ✔ Colocación de 7 pacientes + 7 pastillas + 7 timbres, con cercanía garantizada.
// ✔ Luces (algunas rotas con flicker), ascensores (1 par activo, 2 pares cerrados).
// ✔ Spawners (mosquitos, ratas, staff, carros) y NPC únicos (Jefe/ Supervisora) si existen.
// ✔ Detección automática de entidades “NOT NULL” en window.* y ENT.*
// ✔ Salida: { ascii, map, placements, areas, elevators, report, charset }
//
// API:
//   MapGenAPI.init(G?)                          // opcional, referenciar G (si quieres)
//   MapGenAPI.generate(options) -> {…}          // ver options más abajo
//
// options (todas opcionales):
//   levelId: number|string              // id de nivel (por defecto 1)
//   levelConfig: object                 // configuración completa desde level_rules.xml
//   rngSeed/seed: number|string         // RNG determinista
//   w,h,width,height: number            // forzar tamaño (sino usa nivel)
//   defs: object                        // override de detección de entidades
//   charset: object                     // override de caracteres ASCII
//   density: { rooms, lights, worms }   // tuning fino por tamaño
//
// Caracteres ASCII por defecto (override con options.charset):
//   '#': pared      '.' : suelo         'd': puerta normal  'u': puerta urgencias
//   'S': start      'T' : teléfono      'X' : boss (marcador)
//   'L': luz        'l' : luz rota      'E' : ascensor activo  'e': ascensor cerrado
//   'M': spwn mosq  'R' : spwn rata     'N' : spwn staff       'C': spwn carro
//   'p': paciente   'i' : pastilla      'b' : timbre
//
// NOTA RENDIMIENTO: 1050×1050 ≈ 1.1M tiles. El generador usa ocio O(W·H) solo en
// validaciones principales; el resto son operaciones por-sala. En móviles antiguos,
// considera bajar a 800×800 para nivel 3.
//
// ─────────────────────────────────────────────────────────────────────────────
(function (W) {
  'use strict';

  const rawSearch = (typeof location !== 'undefined' && typeof location.search === 'string')
    ? location.search
    : '';
  const MAP_PARAMS = new URLSearchParams(rawSearch || '');
  const hasMapParam = MAP_PARAMS.has('map');
  const requestedMode = hasMapParam
    ? (MAP_PARAMS.get('map') || '').trim().toLowerCase()
    : '';
  const MAP_MODE = requestedMode || 'normal';
  const usingDefaultMapMode = !hasMapParam || !requestedMode;
  if (!W.__MAP_MODE) {
    W.__MAP_MODE = MAP_MODE;
  }
  if (MAP_MODE === 'ascii' || MAP_MODE === 'debug') {
    W.DEBUG_FORCE_ASCII = true;
  }
  if (MAP_MODE === 'mini') {
    W.DEBUG_MINIMAP = true;
  }
  try {
    console.log('%cMAP_MODE', 'color:#0bf', MAP_MODE, usingDefaultMapMode ? '(default)' : '(query)');
  } catch (_) {}

  const _levelRulesCache = new Map();

  async function getLevelRules(levelId, mode = 'normal') {
    const id = String(levelId || '1');
    if (_levelRulesCache.has(id)) return _levelRulesCache.get(id);

    let parsed = null;
    if (typeof W.LevelRulesAPI?.getLevelConfig === 'function') {
      try {
        parsed = await W.LevelRulesAPI.getLevelConfig(id, mode);
      } catch (err) {
        try { console.warn('[MAPGEN_WARNING] getLevelRules LevelRulesAPI fallback', err); } catch (_) {}
      }
    }

    if (!parsed && typeof W.XMLRules?.load === 'function') {
      try {
        const data = await W.XMLRules.load(id);
        const { globals = {}, level = {}, rules = [], config = null } = data || {};
        const base = config || { ...globals, ...level, rules };
        const cooling = Number.isFinite(base.cooling)
          ? base.cooling
          : Number.isFinite(globals.cooling)
            ? globals.cooling
            : 20;
        parsed = {
          ...base,
          mode,
          rules: base.rules || rules,
          cooling,
          culling: Number.isFinite(base.culling) ? base.culling : Number(globals.culling) || 20
        };
      } catch (err) {
        try { console.warn('[MAPGEN_WARNING] getLevelRules fallback', err); } catch (_) {}
      }
    }

    if (!parsed) {
      const lvlNum = parseInt(id, 10) || 1;
      parsed = {
        id,
        mode,
        width: BASE * lvlNum,
        height: BASE * lvlNum,
        rooms: (LAYERS[lvlNum]?.rooms / 4) | 0 || 8,
        culling: 20,
        cooling: 20,
        rules: []
      };
    }

    _levelRulesCache.set(id, parsed);
    return parsed;
  }

  // --- REGLAS DE GENERACIÓN (mapa) ---
  const GEN_RULES = {
    MIN_CORRIDOR: 2,          // pasillo mínimo (tiles)
    MAX_CORRIDOR: 3,          // 💡 límite duro de ancho
    DOOR_NECK: 1,             // cuello de botella = 1 tile
    MIN_ROOM_GAP: 10,         // separación mínima entre habitaciones (en tiles)
    CORRIDOR_DOCK: 3,         // tramo que entra en el costado (≈ al centro)
    perRoom: (level) => ({ animals: level, staff: 1, celadores: 1 }),
    cartProb: { food: 0.6, meds: 0.3, urg: 0.1 },
  };

  // Helpers simples
  // --- Utils sobre grid (0/1/2: ajusta si tu representación difiere) ---
  function cloneGrid(g){ return g.map(r => r.slice()); }// --- Reachability (BFS) sobre grid 0/1 (0 suelo, 1 muro) ---
  function bfsReach(map, sx, sy){
    const H = map.length, W = map[0].length;
    const inb = (x,y)=> y>=0 && y<H && x>=0 && x<W;
    const vis = Array.from({length:H},()=>Array(W).fill(false));
    const q = [];
    if (!inb(sx,sy) || map[sy][sx]===1) return vis;
    vis[sy][sx] = true; q.push([sx,sy]);
    while(q.length){
      const [x,y] = q.shift();
      const dirs = [[1,0],[-1,0],[0,1],[0,-1]];
      for (const [dx,dy] of dirs){
        const nx=x+dx, ny=y+dy;
        if (!inb(nx,ny) || vis[ny][nx] || map[ny][nx]===1) continue;
        vis[ny][nx] = true; q.push([nx,ny]);
      }
    }
    return vis;
  }

  // --- Carvar corredor recto tipo Bresenham con ancho (3..5) ---
  // Pasillo en L estrictamente ortogonal (usa digH/digV)
  function carveOrthCorridor(map, x0, y0, x1, y1, width=3){
    const w = Math.max(1, Math.floor(width || 1));
    // escogemos el orden que menos “muerde” paredes
    const hFirst = Math.abs(x1-x0) >= Math.abs(y1-y0);
    if (hFirst){
      digH(map, Math.min(x0,x1), Math.max(x0,x1), y0, w);
      digV(map, Math.min(y0,y1), Math.max(y0,y1), x1, w);
    } else {
      digV(map, Math.min(y0,y1), Math.max(y0,y1), x0, w);
      digH(map, Math.min(x0,x1), Math.max(x0,x1), y1, w);
    }
  }

  // --- Conecta TODAS las habitaciones a Control (si alguna queda aislada) ---
  function ensureAllRoomsReachable(map, rooms, start){
    const center = (r)=>({ x:(r.x+r.w/2)|0, y:(r.y+r.h/2)|0 });
    let vis = bfsReach(map, start.x, start.y);

    // devuelve un punto interior alcanzable de una sala o null
    const roomHasReach = (r)=>{
      for (let y=r.y; y<r.y+r.h; y++)
        for (let x=r.x; x<r.x+r.w; x++)
          if (vis[y]?.[x]) return {x,y};
      return null;
    };

    // lista de salas no alcanzadas
    let pending = rooms.filter(r=>!roomHasReach(r));

    // mientras queden aisladas, conecta con el punto alcanzable más cercano
    while(pending.length){
      const r = pending[0];
      const c = center(r);

      // busca punto alcanzable más cercano a 'c'
      let best = null, bestD2 = Infinity;
      for (let y=0;y<map.length;y++){
        for (let x=0;x<map[0].length;x++){
          if (!vis[y][x]) continue;
          const d2 = (x-c.x)*(x-c.x)+(y-c.y)*(y-c.y);
          if (d2 < bestD2){ bestD2=d2; best={x,y}; }
        }
      }
      if (!best) break; // (mapa vacío raro)

      carveOrthCorridor(map, best.x, best.y, c.x, c.y, 3);
      // recalcula alcanzables tras carvar el nuevo corredor
      vis = bfsReach(map, start.x, start.y);
      pending = rooms.filter(rr=>!roomHasReach(rr));
    }
  }

  // Asegura "cuello" de 1 tile dentro de la sala para cada puerta detectada en el anillo.
  function enforceNecksWidth1(ascii, room, doors, cs){
    const H = ascii.length, W = ascii[0].length;
    const put = (x,y,ch)=>{ if (y>=0&&y<H&&x>=0&&x<W) ascii[y][x]=ch; };

    for (const d of doors){
      let dirX=0, dirY=0, xin=0, yin=0, side='';

      if (d.y === room.y-1){           // puerta en el lado superior → entra hacia +Y
        side='N'; xin = d.x; yin = room.y;        dirY = 1;
      } else if (d.y === room.y+room.h){ // inferior → entra hacia -Y
        side='S'; xin = d.x; yin = room.y+room.h-1; dirY = -1;
      } else if (d.x === room.x-1){     // izquierda → entra hacia +X
        side='W'; xin = room.x; yin = d.y;        dirX = 1;
      } else if (d.x === room.x+room.w){ // derecha → entra hacia -X
        side='E'; xin = room.x+room.w-1; yin = d.y; dirX = -1;
      } else continue;

      // 1 ó 2 tiles de profundidad con 1 tile de ancho
      for (let t=0; t<2; t++){
        const xx = xin + dirX*t, yy = yin + dirY*t;
        put(xx, yy, cs.floor);
        if (side==='N' || side==='S'){ put(xx-1,yy,cs.wall); put(xx+1,yy,cs.wall); }
        else                          { put(xx,yy-1,cs.wall); put(xx,yy+1,cs.wall); }
      }
    }
  }

  function inb(g,x,y){ return y>=0 && y<g.length && x>=0 && x<g[0].length; }

  // Engorda el suelo para que ningún pasillo quede < MIN_CORRIDOR
  function thickenFloor(grid, minWidth){
    const r = Math.max(0, Math.floor((minWidth-1)/2));
    if (r<=0) return grid;
    const H = grid.length, W = grid[0].length;
    const out = cloneGrid(grid);
    for (let y=0;y<H;y++){
      for (let x=0;x<W;x++){
        if (grid[y][x] !== 2) continue;           // 2 = suelo
        for (let dy=-r; dy<=r; dy++){
          for (let dx=-r; dx<=r; dx++){
            const xx=x+dx, yy=y+dy;
            if (!inb(grid,xx,yy)) continue;
            if (out[yy][xx]===1) out[yy][xx]=2;   // 1=muro → suelo
          }
        }
      }
    }
    return out;
  }

  // Deja una bocana de 1 tile y coloca una puerta
  function neckAndDoorAt(grid, roomRect, placements){
    const {x,y,w,h} = roomRect; // en tiles
    const sides = ['N','S','W','E'];
    for (let tries=0; tries<8; tries++){
      const side = sides[Math.floor(Math.random()*sides.length)];
      let px, py;
      if (side==='N'){ px=Math.floor(x+w/2); py=y-1; }
      if (side==='S'){ px=Math.floor(x+w/2); py=y+h; }
      if (side==='W'){ px=x-1;              py=Math.floor(y+h/2); }
      if (side==='E'){ px=x+w;              py=Math.floor(y+h/2); }
      if (!inb(grid,px,py)) continue;
      grid[py][px] = 2; // abre hueco de 1 tile
      placements.push({ kind:'door', x:px, y:py, opts:{ locked:false }});
      return;
    }
  }

  function pickOne(arr){ return arr[(Math.random()*arr.length)|0]; }

  // Engorda SOLO corredores (0=suelocorredor, 1=muro). No toca suelos de habitación.
  function thickenCorridors(grid, minWidth, rooms){
    const H = grid.length, W = grid[0].length;

    // 1) Máscara de habitaciones para no invadirlas
    const roomMask = Array.from({length:H},()=>Array(W).fill(false));
    for (const r of rooms){
      for (let yy=r.y; yy<r.y+r.h; yy++){
        for (let xx=r.x; xx<r.x+r.w; xx++){
          if (yy>=0 && yy<H && xx>=0 && xx<W) roomMask[yy][xx] = true;
        }
      }
    }

    // 2) Radio en función del ancho deseado (3..5 → r=1..2)
    const r = Math.max(0, Math.floor((minWidth-1)/2));
    if (r<=0) return grid;

    // 3) Snapshot para leer (src) y un buffer de salida (out)
    const src = cloneGrid(grid);
    const out = cloneGrid(grid);

    // 4) Ensancha SOLO alrededor de los corredores originales de src
    for (let y=1; y<H-1; y++){
      for (let x=1; x<W-1; x++){
        // corredor original (suelo fuera de habitaciones)
        if (src[y][x]!==0 || roomMask[y][x]) continue;

        for (let dy=-r; dy<=r; dy++){
          for (let dx=-r; dx<=r; dx++){
            const yy = y+dy, xx = x+dx;
            if (yy<=0 || yy>=H-1 || xx<=0 || xx>=W-1) continue;
            if (roomMask[yy][xx]) continue;     // NO tocar dentro de habitaciones
            if (src[yy][xx] === 1) out[yy][xx] = 0; // muro → suelo (una sola pasada)
          }
        }
      }
    }

    // 5) Vuelca el resultado al grid original
    for (let y=0; y<H; y++){
      for (let x=0; x<W; x++){
        grid[y][x] = out[y][x];
      }
    }
    return grid;
  }

  // Cuenta y repara uniones solo por esquina.
  // Si dos suelos se tocan en diagonal y ambos vecinos ortogonales son muro,
  // abrimos UN vecino ortogonal para convertir la unión en válida.
  // Cierra uniones SOLO por esquina (no abre pasos). Trabaja en el grid 0/1.
  function sealDiagonalCorners(map, maxPasses=3){
    const H = map.length, W = map[0].length;
    for (let pass=0; pass<maxPasses; pass++){
      let changed = 0;
      for (let y=1; y<H-1; y++){
        for (let x=1; x<W-1; x++){
          // caso diag ↘ : suelos en (x,y) y (x+1,y+1) pero ortogonales bloqueados
          if (map[y][x]===0 && map[y+1][x+1]===0 && map[y][x+1]===1 && map[y+1][x]===1){
            // sellamos UNO de los dos suelos diagonales
            if (Math.random()<0.5) map[y][x] = 1; else map[y+1][x+1] = 1;
            changed++; continue;
          }
          // caso diag ↗
          if (map[y][x]===0 && map[y-1][x+1]===0 && map[y][x+1]===1 && map[y-1][x]===1){
            if (Math.random()<0.5) map[y][x] = 1; else map[y-1][x+1] = 1;
            changed++; continue;
          }
        }
      }
      if (!changed) break;
    }
  }

  // Crear cuello de botella visual en ASCII alrededor de la puerta
  function applyNeck(ascii, x, y, cs){
    const H = ascii.length, W = ascii[0].length;
    const wall = cs.wall, floor = cs.floor;
    const at = (xx,yy)=> (yy>=0&&yy<H&&xx>=0&&xx<W) ? ascii[yy][xx] : wall;
    const isWalk = (xx,yy)=> {
      const c = at(xx,yy);
      return (c===floor || c===cs.door || c===cs.bossDoor);
    };

    // ¿pared principal arriba/abajo (corredor vertical) o izq/der (corredor horizontal)?
    const horizontalWall =
      (at(x, y-1) === wall && isWalk(x, y+1)) ||
      (at(x, y+1) === wall && isWalk(x, y-1));

    if (horizontalWall){
      // corredor vertical -> tapa laterales, deja 1-tile
      if (x-1 >= 0 && ascii[y][x-1] !== cs.door && ascii[y][x-1] !== cs.bossDoor) ascii[y][x-1] = wall;
      if (x+1 <  W && ascii[y][x+1] !== cs.door && ascii[y][x+1] !== cs.bossDoor) ascii[y][x+1] = wall;
    } else {
      // corredor horizontal -> tapa arriba/abajo, deja 1-tile
      if (y-1 >= 0 && ascii[y-1][x] !== cs.door && ascii[y-1][x] !== cs.bossDoor) ascii[y-1][x] = wall;
      if (y+1 <  H && ascii[y+1][x] !== cs.door && ascii[y+1][x] !== cs.bossDoor) ascii[y+1][x] = wall;
    }
  }

// Reduce cualquier hueco del perímetro a 1 tile EXACTO por banda de pasillo.
// Si una banda no es pasillo real (solo “hoyo” 1-tile), se sella completa.
// Además blinda esquinas para evitar uniones por diagonal.
function fixRoomPerimeterGaps(ascii, room, cs){
  const H = ascii.length, W = ascii[0].length;
  const at  = (x,y)=> (y>=0&&y<H&&x>=0&&x<W) ? ascii[y][x] : cs.wall;
  const isW = (x,y)=> at(x,y) === cs.wall;
  const isD = (x,y)=> { const c = at(x,y); return c===cs.door || c===cs.bossDoor; };
  const isF = (x,y)=> at(x,y) === cs.floor;

  // Devuelve el índice dentro de [i..j) que debe quedarse abierto como puerta
  // (elige la puerta existente más cercana al centro; si no hay, el mejor
  //  punto dentro de la banda que realmente sea pasillo "profundo")
  function pickOneInRun(line, i, j, nX, nY, centerCoord, orient){
    // posiciones del run que continúan siendo pasillo al avanzar 1–2 hacia fuera
    const corridorIdx = [];
    for (let k=i; k<j; k++){
      const p = line[k];
      const x1 = p.x + nX, y1 = p.y + nY;
      const x2 = p.x + 2*nX, y2 = p.y + 2*nY;
      // exigimos al menos 2 de profundidad para evitar “hoyos” sin salida
      if (isF(x1,y1) && isF(x2,y2)) corridorIdx.push(k);
    }
    if (corridorIdx.length === 0) return -1; // no es pasillo real → cerrar todo

    // ¿hay puertas existentes en el tramo?
    const doorIdx = [];
    for (let k=i; k<j; k++) if (isD(line[k].x, line[k].y)) doorIdx.push(k);

    // función distancia al centro de la sala en el eje visible de este lado
    const dist = (k)=>{
      const p = line[k];
      return (orient==='H') ? Math.abs(p.x - centerCoord) : Math.abs(p.y - centerCoord);
    };

    if (doorIdx.length > 0){
      // conservar UNA puerta: la más centrada respecto a la sala
      doorIdx.sort((a,b)=> dist(a)-dist(b));
      return doorIdx[0];
    } else {
      // no había puerta: abrir UNA en el mejor punto del pasillo
      corridorIdx.sort((a,b)=> dist(a)-dist(b));
      return corridorIdx[0];
    }
  }

    // Procesa una línea del anillo exterior (top/bottom = H, left/right = V)
    function processLine(line, nX, nY, orient){
      // orient: 'H' (línea horizontal) o 'V' (línea vertical)
      // nX,nY: vector normal que apunta HACIA FUERA de la sala en esa línea
      const centerCoord = (orient==='H')
        ? (room.x + (room.w>>1))
        : (room.y + (room.h>>1));

      let i = 0;
      while (i < line.length){
        // saltar muros
        while (i < line.length && isW(line[i].x, line[i].y)) i++;
        if (i >= line.length) break;

        // tramo abierto [i..j)
        let j = i;
        while (j < line.length && !isW(line[j].x, line[j].y)) j++;

        // elegir UNA única celda que quedará como puerta (o -1 para cerrar todo)
        const keep = pickOneInRun(line, i, j, nX, nY, centerCoord, orient);

        // cerrar todo el tramo…
        for (let k=i; k<j; k++){
          const p = line[k];
          ascii[p.y][p.x] = cs.wall;
        }
        // …y si hay posición elegida, marcarla como puerta
        if (keep !== -1){
          const p = line[keep];
          // si ya había puerta boss, respetar su char; si no, puerta normal
          if (!isD(p.x,p.y)) ascii[p.y][p.x] = cs.door;
          else ascii[p.y][p.x] = at(p.x,p.y); // deja el que hubiese (d/D)
        }

        i = j;
      }
    }

    // anillo exterior (1 celda FUERA del rectángulo de la sala)
    const top=[];    for (let x=room.x; x<room.x+room.w; x++) top.push({x, y:room.y-1});
    const bottom=[]; for (let x=room.x; x<room.x+room.w; x++) bottom.push({x, y:room.y+room.h});
    const left=[];   for (let y=room.y; y<room.y+room.h; y++) left.push({x:room.x-1, y});
    const right=[];  for (let y=room.y; y<room.y+room.h; y++) right.push({x:room.x+room.w, y});

    //        línea   , normal hacia fuera, orientación
    processLine(top   ,  0, -1, 'H');
    processLine(bottom,  0,  1, 'H');
    processLine(left  , -1,  0, 'V');
    processLine(right ,  1,  0, 'V');

    // blindar esquinas del anillo (evita diagonales)
    const corners = [
      {x:room.x-1,      y:room.y-1},
      {x:room.x+room.w, y:room.y-1},
      {x:room.x-1,      y:room.y+room.h},
      {x:room.x+room.w, y:room.y+room.h},
    ];
    for (const c of corners){
      if (c.x>=0 && c.x<W && c.y>=0 && c.y<H){
        const ch = ascii[c.y][c.x];
        if (ch!==cs.door && ch!==cs.bossDoor) ascii[c.y][c.x] = cs.wall;
      }
    }
  }

  // Pone muro en TODO el perímetro de la habitación excepto en la puerta d{x,y}
  function sealRoomAsciiExceptDoor(ascii, room, dOrList, cs){
    const doors = Array.isArray(dOrList) ? dOrList : [dOrList];
    const {x,y,w,h} = room, H=ascii.length, W=ascii[0].length;
    const inb=(xx,yy)=> yy>=0&&yy<H&&xx>=0&&xx<W;
    const isDoor=(xx,yy)=> doors.some(d => d && d.x===xx && d.y===yy);

    for (let xx=x; xx<x+w; xx++){
      const ty=y-1, by=y+h;
      if (inb(xx,ty) && !isDoor(xx,ty)) ascii[ty][xx] = cs.wall;
      if (inb(xx,by) && !isDoor(xx,by)) ascii[by][xx] = cs.wall;
    }
    for (let yy=y; yy<y+h; yy++){
      const lx=x-1, rx=x+w;
      if (inb(lx,yy) && !isDoor(lx,yy)) ascii[yy][lx] = cs.wall;
      if (inb(rx,yy) && !isDoor(rx,yy)) ascii[yy][rx] = cs.wall;
    }
  }

  // Spawns por habitación (añade a los "spawns" globales)
  function placePerRoomSpawns(rng, rooms, ctrl, boss, level, map, ascii, cs){
    const extra = { mosquito:[], rat:[], staff:[], cart:[] };
    const roomList = rooms.filter(r=> r!==ctrl && r!==boss);

    for (const room of roomList){
      const { animals, staff, celadores } = GEN_RULES.perRoom(level);

      // Criaturas hostiles: mezcla M/R
      for (let i=0;i<animals;i++){
        const prefer = Math.random()<0.5 ? 'mosquito' : 'rat';
        const p = placeInside(map, room) || centerOf(room);
        ascii[p.ty][p.tx] = cs.spAnimal || 'A';
        if (prefer==='mosquito') extra.mosquito.push({tx:p.tx,ty:p.ty});
        else extra.rat.push({tx:p.tx,ty:p.ty});
      }

      // Personal humano genérico 'N'
      for (let i=0;i<staff;i++){
        const p = placeInside(map, room) || centerOf(room);
        ascii[p.ty][p.tx] = cs.spStaff || 'N';
        extra.staff.push({tx:p.tx,ty:p.ty});
      }

      // 1 Celador (también como staff genérico 'N' en ASCII)
      for (let i=0;i<celadores;i++){
        const p = placeInside(map, room) || centerOf(room);
        ascii[p.ty][p.tx] = cs.spStaff || 'N';
        extra.staff.push({tx:p.tx,ty:p.ty});
      }

      // 1 carro por habitación (spawn 'C')
      {
        const p = placeInside(map, room) || centerOf(room);
        ascii[p.ty][p.tx] = cs.spCart || 'C';
        extra.cart.push({tx:p.tx,ty:p.ty});
      }
    }

    return extra;
  }

  function ensureGrid(options = {}){
    const G = W.G || (W.G = {});
    const width = clamp(options.width | 0 || 60, 20, 400);
    const height = clamp(options.height | 0 || 40, 20, 400);
    const roomsTarget = clamp(options.rooms | 0 || 8, 3, 60);
    const seed = options.seed ?? (G.seed ?? (Date.now() >>> 0));
    const rng = RNG(seed);

    const layout = generateNormalLayout({ width, height, levelConfig: { rooms: roomsTarget, rules: [] }, rng, charset: CHARSET_DEFAULT });
    const map = asciiToNumeric(layout);
    const rooms = layout._rooms || [];
    const control = layout._control || pickControlRoom(rooms, width, height);
    const entrance = layout._entrance || pickEntranceRoom(rooms);
    const boss = layout._boss || pickBossRoom(rooms, control);
    const bossEntrance = boss
      ? {
          tx: clamp(boss.x + Math.floor(boss.w / 2), 1, width - 2),
          ty: clamp(boss.y + Math.floor(boss.h / 2), 1, height - 2)
        }
      : null;

    G.map = map;
    G.mapW = width;
    G.mapH = height;
    G.mapAreas = {
      rooms,
      control,
      entrance,
      boss,
      bossEntrance
    };
    G.seed = seed;

    return { map, width, height, rooms, control, entrance, boss, bossEntrance, seed, corridorWidth: layout._corridorWidth };
  }

  function roomsOverlap(a, b, pad = 0) {
    return !(
      a.x + a.w + pad <= b.x ||
      b.x + b.w + pad <= a.x ||
      a.y + a.h + pad <= b.y ||
      b.y + b.h + pad <= a.y
    );
  }

  function digCorridor(map, from, to) {
    const path = [];
    let cx = from.x;
    let cy = from.y;
    while (cx !== to.x) {
      cx += cx < to.x ? 1 : -1;
      path.push({ x: cx, y: cy });
    }
    while (cy !== to.y) {
      cy += cy < to.y ? 1 : -1;
      path.push({ x: cx, y: cy });
    }
    for (const step of path) {
      if (step.y <= 0 || step.y >= map.length - 1 || step.x <= 0 || step.x >= map[0].length - 1) continue;
      map[step.y][step.x] = 0;
    }
  }

  function sealBorders(map) {
    const H = map.length;
    const Wd = map[0]?.length || 0;
    for (let x = 0; x < Wd; x++) {
      map[0][x] = 1;
      map[H - 1][x] = 1;
    }
    for (let y = 0; y < H; y++) {
      map[y][0] = 1;
      map[y][Wd - 1] = 1;
    }
  }

  function pickControlRoom(rooms, width, height) {
    const cx = width / 2;
    const cy = height / 2;
    let best = null;
    let bestScore = Infinity;
    for (const room of rooms) {
      const rx = room.x + room.w / 2;
      const ry = room.y + room.h / 2;
      const dist = (rx - cx) * (rx - cx) + (ry - cy) * (ry - cy);
      if (dist < bestScore) {
        bestScore = dist;
        best = room;
      }
    }
    return best || rooms[0] || null;
  }

  function pickEntranceRoom(rooms) {
    let best = null;
    let score = Infinity;
    for (const room of rooms) {
      const center = room.x + room.y;
      if (center < score) {
        score = center;
        best = room;
      }
    }
    return best || rooms[0] || null;
  }

  function pickBossRoom(rooms, control) {
    if (!rooms.length) return null;
    const ctrl = control || rooms[0];
    const cx = ctrl.x + ctrl.w / 2;
    const cy = ctrl.y + ctrl.h / 2;
    let best = null;
    let bestDist = -1;
    for (const room of rooms) {
      if (room === ctrl) continue;
      const rx = room.x + room.w / 2;
      const ry = room.y + room.h / 2;
      const dist = (rx - cx) * (rx - cx) + (ry - cy) * (ry - cy);
      if (dist > bestDist) {
        bestDist = dist;
        best = room;
      }
    }
    return best || rooms[rooms.length - 1] || ctrl;
  }

  const MapGenAPI = { _G: null, init(G){ this._G = G || W.G || (W.G={}); }, generate };
  W.MapGenAPI = MapGenAPI;
  const MapGen = W.MapGen = W.MapGen || {};
  MapGen.init = MapGenAPI.init.bind(MapGenAPI);
  MapGen.generate = MapGenAPI.generate;
  MapGen.ensureGrid = ensureGrid;
  MapGen.MAP_MODE = MAP_MODE;
  MapGen.createRNG = (seed) => RNG(seed);
  MapGen.getLastSeed = () => W.G?.seed;
  try {
    Object.defineProperties(MapGen, {
      map: { configurable: true, get(){ return W.G?.map || null; } },
      mapW: { configurable: true, get(){ return W.G?.mapW || 0; } },
      mapH: { configurable: true, get(){ return W.G?.mapH || 0; } },
      mapAreas: { configurable: true, get(){ return W.G?.mapAreas || null; } },
      seed: { configurable: true, get(){ return W.G?.seed; } }
    });
  } catch (_) {
    MapGen.map = W.G?.map;
    MapGen.mapW = W.G?.mapW;
    MapGen.mapH = W.G?.mapH;
    MapGen.mapAreas = W.G?.mapAreas;
    MapGen.seed = W.G?.seed;
  }

  W.__MAP_MODE = MAP_MODE;

  // ─────────────────────────────────────────
  // Config & constantes
  // ─────────────────────────────────────────
  const BASE = 350; // lado base por nivel
  const TILE = (typeof W.TILE_SIZE!=='undefined') ? W.TILE_SIZE : (W.TILE||32);

function charFor(key, fallback){
  if (typeof window !== 'undefined' && window.PlacementAPI?.getCharForKey) {
    const ch = window.PlacementAPI.getCharForKey(key, null);
    if (ch) return ch;
  }
  return fallback;
}

// **defecto + extra**
const CHARSET_DEFAULT = {
  wall:charFor('wall', '#'), floor:charFor('floor', '.'),
  door:charFor('door_normal', 'd'), bossDoor:charFor('door_boss', 'u'),
  elev:charFor('elevator', 'E'), elevClosed:charFor('elevator', 'E'),
  start:charFor('hero_spawn', 'S'), light:charFor('light_ok', 'L'), lightBroken:charFor('light_broken', 'l'),
  spAnimal:charFor('spawn_animal', 'A'), spStaff:charFor('spawn_npc', 'N'), spCart:charFor('spawn_cart', 'C'),
  patient:charFor('patient_bed', 'p'), pill:charFor('pill', 'i'), bell:charFor('bell', 'b'), phone:charFor('phone_central', 'T'), bossMarker:charFor('boss_main', 'X'),
  cartUrg:charFor('cart_emergency', 'U'), cartMed:charFor('cart_meds', '+'), cartFood:charFor('cart_food', 'F'),
  mosquito:charFor('mosquito', 'm'), rat:charFor('rat', 'r'),
  nurse:charFor('npc_nurse_sexy', 'n'), tcae:charFor('npc_tcae', 't'), celador:charFor('npc_celador', 'c'), cleaner:charFor('npc_cleaner', 'h'), guardia:charFor('npc_guard', 'g'), medico:charFor('npc_medico', 'k'),
  jefe_servicio:'J', supervisora:charFor('npc_supervisora', 'H'),
  coin:charFor('coin', '$'), bag:charFor('money_bag', '%'), food:charFor('food_small', 'y'), power:charFor('syringe_red', '1'),
  loot:charFor('loot_random', 'o')
};
const CHARSET = Object.assign({}, (window.CHARSET_DEFAULT || {}), CHARSET_DEFAULT);

  // Nivel → densidades base (se pueden sobreescribir con options.density)
  const LAYERS = {
    1: { rooms: 120, lights: 520, worms: 0.10, extraLoops: 0.08 },
    2: { rooms: 260, lights: 1100, worms: 0.12, extraLoops: 0.10 },
    3: { rooms: 420, lights: 1800, worms: 0.14, extraLoops: 0.12 },
  };

  // Escalado de spawns por nivel
  const SPAWN_SCALE = {
    mosquito: lvl => Math.max(1, Math.floor([2,4,7][lvl-1] || 2)),
    rat:      lvl => Math.max(1, Math.floor([2,5,8][lvl-1] || 2)),
    staff:    lvl => Math.max(1, Math.floor([1,2,3][lvl-1] || 1)),
    carts:    lvl => Math.max(1, Math.floor([1,2,3][lvl-1] || 1)),
  };

  // RNG (mulberry32)
  function mulberry32(a){return function(){let t=a+=0x6D2B79F5;t=Math.imul(t^t>>>15,t|1);t^=t+Math.imul(t^t>>>7,t|61);return((t^t>>>14)>>>0)/4294967296;};}
  function hashStr(s){let h=2166136261>>>0;for(let i=0;i<s.length;i++){h^=s.charCodeAt(i);h=Math.imul(h,16777619);}return h>>>0;}
  function RNG(seed){ const s = (typeof seed==='number' ? seed>>>0 : hashStr(String(seed))); const r = mulberry32(s); return { rand:r, int(a,b){return a+Math.floor(r()*(b-a+1));}, chance(p){return r()<p;}, pick(arr){return arr[(r()*arr.length)|0];}, shuffle(arr){for(let i=arr.length-1;i>0;i--){const j=(r()* (i+1))|0; [arr[i],arr[j]]=[arr[j],arr[i]];}return arr;} }; }

  const N4 = [[1,0],[-1,0],[0,1],[0,-1]];
  const clamp=(v,a,b)=>v<a?a:(v>b?b:v);
  const inB=(W,H,x,y)=> x>0 && y>0 && x<W-1 && y<H-1;

  // ─────────────────────────────────────────
  // Detección de entidades NOT NULL
  // ─────────────────────────────────────────
  function has(v){ return typeof v!=='undefined' && v!==null; }
  function detectDefs(){
    const ENT = W.ENT||{};
    const out = {
      animals: {
        mosquito: has(W.MosquitoAPI) || has(ENT.MOSQUITO),
        rat:      has(W.RatAPI)      || has(ENT.RAT),
      },
      humans: {
        celador: has(W.CeladorAPI) || has(ENT.CELADOR),
        tcae: has(W.TCAEAPI) || has(ENT.TCAE),
        nurse: has(W.SexyNurseAPI) || has(ENT.NURSE_SEXY),
        supervisor: has(W.SupervisoraAPI) || has(ENT.SUPERVISOR),
        jefe: has(W.JefeServicioAPI) || has(ENT.JEFE_SERVICIO),
        medico: has(W.MedicoAPI) || has(ENT.DOCTOR),
        patient: true,  // el motor base siempre puede dibujar pacientes
        staff: true     // spawner genérico de personal
      },
      carts: { food: has(W.CartsAPI)||has(ENT.CART), meds: has(W.CartsAPI)||has(ENT.CART), er: has(W.CartsAPI)||has(ENT.CART) },
      boss: { a:true, b: has(W.Boss2API), c: has(W.Boss3API) },
      items:{ bell:true, phone:true },
      structs:{ elevator:true },
      lights:{ enabled:true },
    };
    return out;
  }

  // ─────────────────────────────────────────
  // Flood para conectividad / distancias
  // ─────────────────────────────────────────
  function flood(map, sx, sy, blockRect=null){
    const H=map.length, W=map[0].length;
    const D=Array.from({length:H},()=>Array(W).fill(Infinity));
    const q=[];
    if (isWalkable(map,sx,sy,blockRect)){ D[sy][sx]=0; q.push([sx,sy]); }
    while(q.length){
      const [x,y]=q.shift();
      for(const[dx,dy] of N4){
        const nx=x+dx, ny=y+dy;
        if(!inB(W,H,nx,ny)) continue;
        if(!isWalkable(map,nx,ny,blockRect)) continue;
        if(D[ny][nx]>D[y][x]+1){ D[ny][nx]=D[y][x]+1; q.push([nx,ny]); }
      }
    }
    return D;
  }
  function isWalkable(map,x,y,blockRect){
    if (map[y]?.[x]===1) return false;
    if (blockRect){
      const {x1,y1,x2,y2} = blockRect;
      if (x>=x1 && x<=x2 && y>=y1 && y<=y2) return false;
    }
    return true;
  }

  // ─────────────────────────────────────────
  // Carving básico: habitaciones + corredores + cul-de-sacs
  // ─────────────────────────────────────────
  function carveRect(map, r, v=0){
    for(let y=r.y;y<r.y+r.h;y++)
      for(let x=r.x;x<r.x+r.w;x++)
        if (inB(map[0].length,map.length,x,y)) map[y][x]=v;
  }
  function overlap(a,b){return !(a.x+a.w<=b.x || b.x+b.w<=a.x || a.y+a.h<=b.y || b.y+b.h<=a.y);}
  function expand(r, p){return {x:r.x-p, y:r.y-p, w:r.w+2*p, h:r.h+2*p};}
  function centerOf(r){return {x: (r.x + ((r.w/2)|0)), y: (r.y + ((r.h/2)|0))};}
  function digH(map, x1, x2, y, w){
    const useW = Math.max(1, Math.floor(w || 1));
    const offset = Math.floor(useW / 2);
    for (let ww = 0; ww < useW; ww++){
      const yy = y + (ww - offset);
      for (let x = x1; x <= x2; x++){
        if (inB(map[0].length, map.length, x, yy)) map[yy][x] = 0; // 0 = suelo
      }
    }
  }
  function digV(map, y1, y2, x, w){
    const useW = Math.max(1, Math.floor(w || 1));
    const offset = Math.floor(useW / 2);
    for (let ww = 0; ww < useW; ww++){
      const xx = x + (ww - offset);
      for (let y = y1; y <= y2; y++){
        if (inB(map[0].length, map.length, xx, y)) map[y][xx] = 0; // 0 = suelo
      }
    }
  }

  function mst(points){
    // Kruskal light
    const edges=[];
    for(let i=0;i<points.length;i++)
      for(let j=i+1;j<points.length;j++){
        const a=points[i], b=points[j];
        const d=(a.x-b.x)*(a.x-b.x)+(a.y-b.y)*(a.y-b.y);
        edges.push({a,b,d});
      }
    edges.sort((u,v)=>u.d-v.d);
    const parent = new Map(points.map(p=>[p,p]));
    function find(x){ while(parent.get(x)!==x) x=parent.get(x); return x; }
    const res=[];
    for(const e of edges){
      const pa=find(e.a), pb=find(e.b);
      if (pa!==pb){ parent.set(pa,pb); res.push(e); if (res.length>=points.length-1) break; }
    }
    return res;
  }

  function sprinkleWorms(rng, map, count, rooms){
    const rand = (typeof rng === 'function') ? rng : rng.rand; // <- AQUÍ el cambio
    const H = map.length, W = map[0].length;
    const insideRoom = (x,y)=>{
      for (const r of rooms){
        if (x>=r.x && x<r.x+r.w && y>=r.y && y<r.y+r.h) return true;
      }
      return false;
    };
    for (let i=0;i<count;i++){
      let x = (rand()*W)|0, y = (rand()*H)|0, len = 8 + ((rand()*24)|0);
      for (let k=0;k<len;k++){
        if (x<=1||x>=W-2||y<=1||y>=H-2) break;
        if (!insideRoom(x,y)) map[y][x] = 0; // nunca dentro de habitaciones
        x += (rand()<0.5?1:-1);
        y += (rand()<0.5?1:-1);
      }
    }
  }

  // ─────────────────────────────────────────
  // Puertas (1 por sala) + puerta Boss especial
  // ─────────────────────────────────────────
  function openSingleDoor(rng, grid, room, doorChar){
    const cand = [];
    const {x,y,w,h} = room;
    const inb = (xx,yy)=> yy>=0&&yy<grid.length&&xx>=0&&xx<grid[0].length;

    function tryEdge(px,py, nx,ny){ // px,py = pared; nx,ny = fuera mirando corredor
      if (!inb(px,py) || !inb(nx,ny)) return;
      if (grid[py][px]!==1) return;      // pared
      if (grid[ny][nx]!==0) return;      // fuera debe ser corredor
      cand.push({x:px,y:py});
    }

    // perímetro completo
    for (let xx=x; xx<x+w; xx++){ tryEdge(xx,y-1, xx,y-2); tryEdge(xx,y+h, xx,y+h+1); }
    for (let yy=y; yy<y+h; yy++){ tryEdge(x-1,yy, x-2,yy); tryEdge(x+w,yy, x+w+1,yy); }

    if (!cand.length) return null;
    const d = rng.pick(cand);
    grid[d.y][d.x] = 0;          // abre hueco exacto de 1 tile en la pared
    return d;                    // devolvemos {x,y} de la puerta en el GRID
  }

  function openMultipleDoors(rng, grid, room, count){
    const out = [];
    for (let i=0;i<count;i++){
      const d = openSingleDoor(rng, grid, room);
      if (!d) break;
      if (out.some(p => p.x===d.x && p.y===d.y)) { i--; continue; } // evita duplicados
      out.push(d);
    }
    return out;
  }

  // Forzar “exactamente 1 puerta” por sala: si hay más, las tapa salvo 1 aleatoria
  function enforceOneDoorPerRoom(rng, ascii, r, cs){
    const doors=[];
    for(let x=r.x; x<r.x+r.w; x++){ if (ascii[r.y-1]?.[x]===cs.door||ascii[r.y-1]?.[x]===cs.bossDoor) doors.push({x,y:r.y-1});
                                     if (ascii[r.y+r.h]?.[x]===cs.door||ascii[r.y+r.h]?.[x]===cs.bossDoor) doors.push({x,y:r.y+r.h}); }
    for(let y=r.y; y<r.y+r.h; y++){ if (ascii[y]?.[r.x-1]===cs.door||ascii[y]?.[r.x-1]===cs.bossDoor) doors.push({x:r.x-1,y});
                                     if (ascii[y]?.[r.x+r.w]===cs.door||ascii[y]?.[r.x+r.w]===cs.bossDoor) doors.push({x:r.x+r.w,y}); }
    if (doors.length<=1) return;
    const keep = rng.pick(doors);
    for(const d of doors){
      if (d.x===keep.x && d.y===keep.y) continue;
      // “cerrar” puerta: volver a muro
      ascii[d.y][d.x]=cs.wall;
    }
  }

  // ─────────────────────────────────────────
  // Helpers de colocación
  // ─────────────────────────────────────────
  function put(ascii,x,y,ch){ if (ascii[y] && ascii[y][x]!==undefined) ascii[y][x]=ch; }
  function rowsToString(A){ return A.map(r=>r.join('')).join('\n'); }
  function sealMapBorder(ascii, cs){
    const H=ascii.length, W=ascii[0].length;
    for (let x=0;x<W;x++){ ascii[0][x]=cs.wall; ascii[H-1][x]=cs.wall; }
    for (let y=0;y<H;y++){ ascii[y][0]=cs.wall; ascii[y][W-1]=cs.wall; }
  }
  function legendDef(ch, context){
    const api = (typeof window !== 'undefined' && window.AsciiLegendAPI) || null;
    if (api?.getDef) return api.getDef(ch, { context });
    const legend = (typeof window !== 'undefined' && window.AsciiLegend) || {};
    const def = legend[ch];
    if (!def) {
    try { console.warn('[MAPGEN_WARNING] Unknown char in map:', JSON.stringify(ch), context || ''); } catch (_) {}
    }
    return def || null;
  }

  function asciiToNumeric(A){
    const H=A.length,W=A[0].length, grid=Array.from({length:H},()=>Array(W));
    for(let y=0;y<H;y++){
      for(let x=0;x<W;x++){
        const ch = A[y][x];
        const def = legendDef(ch, 'MapGen.asciiToNumeric');
        grid[y][x] = def && def.blocking ? 1 : 0;
      }
    }
    return grid;
  }

  function isWalkableChar(ch, cs){
    if (ch === undefined || ch === cs.wall) return false;
    const def = legendDef(ch, 'MapGen.walkable');
    if (def){
      if (def.blocking) return false;
      if (typeof def.isWalkable !== 'undefined') return !!def.isWalkable;
    }
    return true;
  }

  function floodAscii(ascii, sx, sy, cs){
    const H = ascii.length, W = ascii[0].length;
    const inb = (x,y)=> y>=0 && y<H && x>=0 && x<W;
    const vis = Array.from({length:H},()=>Array(W).fill(false));
    const q=[];
    if (!inb(sx,sy) || !isWalkableChar(ascii[sy][sx], cs)) return vis;
    vis[sy][sx] = true; q.push([sx,sy]);
    while(q.length){
      const [x,y] = q.shift();
      for (const [dx,dy] of N4){
        const nx=x+dx, ny=y+dy;
        if (!inb(nx,ny) || vis[ny][nx] || !isWalkableChar(ascii[ny][nx], cs)) continue;
        vis[ny][nx] = true; q.push([nx,ny]);
      }
    }
    return vis;
  }

  function findRoomWalkableTile(ascii, room, cs, avoid=new Set()){
    const cx = room.centerX|0, cy = room.centerY|0;
    const coords = [];
    for (let y = room.y + 1; y < room.y + room.h - 1; y++){
      for (let x = room.x + 1; x < room.x + room.w - 1; x++){
        coords.push({x,y, d: Math.abs(x-cx)+Math.abs(y-cy)});
      }
    }
    coords.sort((a,b)=>a.d-b.d);
    for (const p of coords){
      const key = `${p.x},${p.y}`;
      if (avoid.has(key)) continue;
      if (isWalkableChar(ascii[p.y]?.[p.x], cs)) return { x:p.x, y:p.y };
    }
    return null;
  }
  function placeInside(map, r, tries=200){
    for(let k=0;k<tries;k++){
      const tx = clamp(r.x + 1 + (Math.random()*Math.max(1,r.w-2))|0, r.x+1, r.x+r.w-2);
      const ty = clamp(r.y + 1 + (Math.random()*Math.max(1,r.h-2))|0, r.y+1, r.y+r.h-2);
      if (map[ty]?.[tx]===0) return {tx,ty};
    }
    return null;
  }
  function placeNear(map, x,y, radius){
    for(let k=0;k<100;k++){
      const nx = x + ((Math.random()*2*radius)|0) - radius;
      const ny = y + ((Math.random()*2*radius)|0) - radius;
      if (map[ny]?.[nx]===0) return {tx:nx,ty:ny};
    }
    return null;
  }
  function farFrom(rng, map, ref, minDist){
    const W=map[0].length,H=map.length, cand=[];
    for(let y=2;y<H-2;y++){
      for(let x=2;x<W-2;x++){
        if (map[y][x]!==0) continue;
        const d2=(x-ref.x)*(x-ref.x)+(y-ref.y)*(y-ref.y);
        if (d2>=minDist*minDist) cand.push({tx:x,ty:y,score:d2});
      }
    }
    if(!cand.length) return null;
    cand.sort((a,b)=>b.score-a.score);
    return cand[rng.int(0, Math.min(10,cand.length-1))];
  }

  function ensureConnectivity(rng, map, start, blockRect, maxPatches=600){
    // Abre “costuras” si quedan islas inaccesibles (excepto boss-room bloqueada)
    const W=map[0].length,H=map.length;
    let D = flood(map, start.x, start.y, blockRect);
    const isInf=(x,y)=>D[y][x]===Infinity;
    let infCount=0;
    for(let y=1;y<H-1;y++) for(let x=1;x<W-1;x++) if(map[y][x]===0 && isInf(x,y)) infCount++;
    if (infCount<=0) return;

    let patches=0;
    while(infCount>0 && patches<maxPatches){
      patches++;
      // busca muro que conecte dos regiones (una accesible y otra inaccesible)
      let opened=false;
      for(let y=2;y<H-2 && !opened;y++){
        for(let x=2;x<W-2 && !opened;x++){
          if(map[y][x]!==1) continue; // muro candidato
          // ¿hay suelo accesible en un lado e inaccesible en el otro?
          let acc=0, inac=0;
          for(const[dx,dy] of N4){
            const nx=x+dx, ny=y+dy;
            if(!inB(W,H,nx,ny)) continue;
            if(map[ny][nx]===0){
              if(D[ny][nx]===Infinity) inac++; else acc++;
            }
          }
          if(acc>0 && inac>0){
            map[y][x]=0; opened=true;
          }
        }
      }
      D = flood(map, start.x, start.y, blockRect);
      infCount=0;
      for(let y=1;y<H-1;y++) for(let x=1;x<W-1;x++) if(map[y][x]===0 && D[y][x]===Infinity) infCount++;
    }
  }

  // ─────────────────────────────────────────
  // Nombres de pacientes (ejemplo)
  // ─────────────────────────────────────────
  function funnyPatientName(i){
    const base = [
      'Dolores De Barriga','Ana Lítica','Rafael Alergia','Aitor Tilla',
      'Elsa Pato','Luz Cuesta Mogollón','Armando Bronca','Paco Trón',
      'Sara Pilla','Prudencio Gasa'
    ];
    return base[i % base.length];
  }

  function generateLegendPreset(options={}) {
    const width = 20;
    const height = 12;
    const asciiRows = Array.from({ length: height }, (_, y) => (
      Array.from({ length: width }, (_, x) => {
        if (y === 0 || y === height - 1 || x === 0 || x === width - 1) return '#';
        return '.';
      })
    ));
    asciiRows[1][1] = 'S';

    const placements = [
      { type: 'door', x: 10, y: 5, locked: true, _units: 'tile' },
      { type: 'elevator', x: 4, y: 8, active: true, pairId: 1, _units: 'tile' },
      { type: 'cart', sub: 'medicinas', x: 6, y: 4, _units: 'tile' },
      { type: 'patient', x: 8, y: 5, id: 'legend_patient', _units: 'tile' },
      { type: 'pill', sub: 'azul', x: 9, y: 5, targetName: 'legend_patient', _units: 'tile' },
      { type: 'bell', x: 7, y: 5, link: 'legend_patient', _units: 'tile' },
      { type: 'boss', x: 16, y: 8, nearWall: true, _units: 'tile' },
      { type: 'light', x: 3, y: 3, _units: 'tile' },
      { type: 'light', x: 6, y: 6, broken: true, _units: 'tile' },
      { type: 'boss_light', x: 16, y: 7, _units: 'tile' },
      { type: 'npc', sub: 'medico', x: 5, y: 2, _units: 'tile' },
      { type: 'npc', sub: 'supervisora', x: 12, y: 3, _units: 'tile' },
      { type: 'npc', sub: 'guardia', x: 4, y: 6, _units: 'tile' },
      { type: 'npc', sub: 'familiar_molesto', x: 8, y: 7, _units: 'tile' },
      { type: 'npc', sub: 'enfermera_sexy', x: 10, y: 7, _units: 'tile' },
      { type: 'enemy', sub: 'rat', x: 14, y: 4, _units: 'tile' },
      { type: 'enemy', sub: 'mosquito', x: 15, y: 4, _units: 'tile' }
    ];

    const areas = {
      control: { x: 1, y: 1, w: 4, h: 4 },
      boss: { x: 14, y: 6, w: 4, h: 4 }
    };

    const asciiString = rowsToString(asciiRows);
    const seed = options.seed ?? 'legend';
    const charset = { ...CHARSET_DEFAULT, ...(options.charset || {}) };
    const result = {
      ascii: asciiString,
      map: asciiToNumeric(asciiRows),
      placements,
      areas,
      elevators: { activePair: [], closed: [] },
      report: [{ summary: { ok: true, legend: true, width, height } }],
      charset,
      seed,
      level: 1,
      width,
      height
    };

    try {
      W.__LEGEND_PRESET = { placements: placements.map(p => ({ ...p })) };
    } catch (_) {}

    return result;
  }

  // ─────────────────────────────────────────
  // GENERATE (núcleo principal)
  // ─────────────────────────────────────────

  async function generate(levelOrOptions = 1, legacyOptions = {}){
    if (MAP_MODE === 'legend') {
      return generateLegendPreset(typeof levelOrOptions === 'object' ? levelOrOptions : legacyOptions);
    }

    const isLegacyCall = Number.isFinite(levelOrOptions) && typeof legacyOptions === 'object';
    const options = isLegacyCall ? { ...legacyOptions, levelId: levelOrOptions } : (levelOrOptions || {});

    const levelId = clamp(options.levelId ?? options.level ?? (isLegacyCall ? levelOrOptions : 1), 1, 3);
    const mode = (options.mode || MAP_MODE || 'normal').toLowerCase();
    let levelConfig = options.levelConfig || null;
    if (!levelConfig) {
      levelConfig = await getLevelRules(levelId, mode);
    }
    if (!levelConfig) {
      throw new Error('[MapGenAPI] missing levelConfig');
    }

    const cs   = { ...CHARSET_DEFAULT, ...(options.charset||{}) };
    const seed = options.rngSeed ?? options.seed ?? (W.G?.seed ?? (Date.now()>>>0));
    const rng  = RNG(seed);

    const width  = clamp(options.width ?? options.w ?? (levelConfig.width || BASE*levelId), 20, BASE*3);
    const height = clamp(options.height ?? options.h ?? (levelConfig.height || BASE*levelId), 20, BASE*3);

    if (MAP_MODE === 'debug' || MAP_MODE === 'ascii') {
      return generateLegendPreset({ ...options, seed });
    }

    const asciiRows = generateNormalLayout({
      width,
      height,
      levelConfig,
      rng,
      charset: cs
    });

    const allRooms = asciiRows._rooms || [];
    const reachGrid = asciiRows._reachable || null;
    const allReachable = allRooms.every(r => reachGrid?.[r.centerY]?.[r.centerX]);
    const bossReachable = asciiRows._boss ? !!reachGrid?.[asciiRows._boss.centerY]?.[asciiRows._boss.centerX] : false;
    const numericMap = asciiToNumeric(asciiRows);
    const totalTiles = width * height;
    let walkableTiles = 0;
    for (let y = 0; y < numericMap.length; y++) {
      for (let x = 0; x < numericMap[y].length; x++) {
        if (numericMap[y][x] === 0) walkableTiles++;
      }
    }
    const floorPercent = totalTiles > 0 ? (walkableTiles / totalTiles) * 100 : 0;
    const occupancyTarget = Number(levelConfig.mapOccupancyRatio ?? levelConfig.map_occupancy_ratio ?? levelConfig.mapOccupancy ?? asciiRows._occupancyTarget ?? 0.9) || 0.9;
    const occupancyAchieved = asciiRows._occupancy?.ratio ?? (walkableTiles / Math.max(1, totalTiles));
    const roomsRequested = Number.isFinite(levelConfig.rooms) ? levelConfig.rooms : (asciiRows._roomsRequested ?? allRooms.length);
    const roomsGenerated = Array.isArray(allRooms) ? allRooms.length : 0;
    const corridorsBuilt = Number(asciiRows._corridors || 0);

    const generation = {
      seed,
      width,
      height,
      roomsCount: roomsGenerated,
      corridorWidth: asciiRows._corridorWidth,
      corridorWidthUsed: asciiRows._corridorWidth,
      cooling: levelConfig.cooling ?? 20,
      culling: levelConfig.culling,
      allRoomsReachable: allReachable,
      bossReachable,
      roomsRequested,
      roomsGenerated,
      corridorsBuilt,
      totalTiles,
      walkableTiles,
      floorPercent,
      occupancyTarget,
      occupancyAchieved,
      mode
    };

    const result = {
      ascii: rowsToString(asciiRows),
      map: numericMap,
      placements: [],
      areas: {
        control: asciiRows._control || null,
        boss: asciiRows._boss || null,
        miniboss: asciiRows._miniboss || null,
        rooms: allRooms
      },
      grid: asciiRows,
      rooms: allRooms,
      reachable: reachGrid,
      charset: cs,
      seed,
      level: levelId,
      width,
      height,
      levelRules: levelConfig,
      meta: {
        ...generation,
        generation
      }
    };

    try {
      const G = W.G || (W.G = {});
      G.seed = seed;
      G.map = result.map;
      G.mapAscii = asciiRows;
      G.mapRooms = allRooms;
      G.mapAreas = result.areas;
      // Cámara y colisión leen estos bounds/tamaños; se mantienen coherentes tras los cambios de densidad/conexiones
      G.levelRules = levelConfig;
      G.levelMeta = result.meta;
      G.mapGenerationMeta = generation;
      if (typeof W.LevelRulesAPI === 'object') {
        W.LevelRulesAPI.current = levelConfig;
      }
    } catch (_) {}

    return result;
  }
  // ─────────────────────────────────────────
  // Sub-rutinas de generación (detalladas)
  // ─────────────────────────────────────────
  function create2DArray(h, w, fill){
    return Array.from({ length: h }, () => Array(w).fill(fill));
  }

  function randInt(rng, min, max){
    const lo = Math.min(min, max);
    const hi = Math.max(min, max);
    return rng.int ? rng.int(lo, hi) : (lo + Math.floor((rng.rand?.() ?? Math.random()) * (hi - lo + 1)));
  }

  function planRoomSize(rng, targetArea, width, height, margin=2){
    const minSide = 6;
    const usableW = Math.max(minSide, width - (margin + 1) * 2);
    const usableH = Math.max(minSide, height - (margin + 1) * 2);
    const area = Math.max(targetArea, minSide * minSide);
    const ratio = 0.7 + ((rng.rand?.() ?? Math.random()) * 0.6); // 0.7 - 1.3
    let w = Math.max(minSide, Math.round(Math.sqrt(area * ratio)));
    let h = Math.max(minSide, Math.round(area / w));
    w = clamp(w, minSide, usableW);
    h = clamp(h, minSide, usableH);
    return { w, h };
  }

  function roomsOverlapWithPadding(a, b, pad=1){
    return !(
      a.x + a.w + pad <= b.x ||
      b.x + b.w + pad <= a.x ||
      a.y + a.h + pad <= b.y ||
      b.y + b.h + pad <= a.y
    );
  }

  function roomFits(room, width, height, margin=1){
    return room.x >= margin && room.y >= margin &&
           room.x + room.w <= width - margin &&
           room.y + room.h <= height - margin;
  }

  function markRoom(ascii, room, cs){
    for (let y = room.y; y < room.y + room.h; y++) {
      for (let x = room.x; x < room.x + room.w; x++) {
        const isBorder =
          x === room.x ||
          x === room.x + room.w - 1 ||
          y === room.y ||
          y === room.y + room.h - 1;

        if (ascii[y]?.[x] === undefined) continue;

        if (isBorder) {
          ascii[y][x] = cs.wall;
        } else {
          ascii[y][x] = '.';
        }
      }
    }
  }

  function applyRoomFloorChars(grid, room){
    let tile;
    switch (room.type){
      case 'control':
        tile = '-';
        break;
      case 'boss':
        tile = ';';
        break;
      case 'miniboss':
        tile = ',';
        break;
      default:
        tile = '.';
        break;
    }

    for (let y = room.y + 1; y < room.y + room.h - 1; y++){
      for (let x = room.x + 1; x < room.x + room.w - 1; x++){
        if (grid[y]?.[x] !== undefined && isFloorTile(grid[y][x])) grid[y][x] = tile;
      }
    }
  }

  function addRoomMetadata(room){
    room.centerX = room.x + Math.floor(room.w / 2);
    room.centerY = room.y + Math.floor(room.h / 2);
    return room;
  }

  function chooseControlRoom(rng, width, height, sizePicker, existing){
    const margin = 2;
    for (let i = 0; i < 200; i++){
      const size = typeof sizePicker === 'function' ? sizePicker() : { w: 8, h: 8 };
      const maxX = Math.max(margin, Math.floor(width * 0.35));
      const minY = Math.max(margin, Math.floor(height * 0.55) - size.h);
      const x = randInt(rng, margin, Math.max(margin, Math.min(maxX, width - size.w - margin)));
      const y = randInt(rng, Math.min(height - size.h - margin, Math.max(margin, minY)), height - size.h - margin);
      const room = addRoomMetadata({ ...size, x, y, type:'control' });
      if (!roomFits(room, width, height, margin)) continue;
      if (existing.some(o => roomsOverlapWithPadding(room, o, 1))) continue;
      return room;
    }
    return null;
  }

  function chooseBossRoom(rng, width, height, sizePicker, controlRoom, existing){
    const margin = 2;
    let best = null;
    let bestDist = -1;
    for (let i = 0; i < 400; i++){
      const size = typeof sizePicker === 'function' ? sizePicker() : { w: 10, h: 10 };
      const x = randInt(rng, margin, width - size.w - margin);
      const y = randInt(rng, margin, height - size.h - margin);
      const room = addRoomMetadata({ ...size, x, y, type:'boss' });
      if (!roomFits(room, width, height, margin)) continue;
      if (existing.some(o => roomsOverlapWithPadding(room, o, 1))) continue;
      const dx = room.centerX - controlRoom.centerX;
      const dy = room.centerY - controlRoom.centerY;
      const d2 = dx*dx + dy*dy;
      if (d2 > bestDist){ bestDist = d2; best = room; }
    }
    return best;
  }

  function placeNormalRooms(rng, width, height, sizePickers, existing){
    const margin = 2;
    const rooms = [];
    let attempts = 0;
    const maxAttempts = Math.max(1200, sizePickers.length * 120);
    while (rooms.length < sizePickers.length && attempts < maxAttempts){
      attempts++;
      const picker = sizePickers[rooms.length] || sizePickers[sizePickers.length - 1];
      const size = typeof picker === 'function' ? picker() : { w: 8, h: 8 };
      const x = randInt(rng, margin, width - size.w - margin);
      const y = randInt(rng, margin, height - size.h - margin);
      const room = addRoomMetadata({ ...size, x, y, type:'normal' });
      if (!roomFits(room, width, height, margin)) continue;
      if (existing.some(o => roomsOverlapWithPadding(room, o, 1))) continue;
      if (rooms.some(o => roomsOverlapWithPadding(room, o, 1))) continue;
      rooms.push(room);
    }
    return rooms.length === sizePickers.length ? rooms : null;
  }

  function openDoorBetween(grid, room, fromX, fromY, isBossRoom, cs){
    let doorX = fromX;
    let doorY = fromY;

    if (doorX < room.x) doorX = room.x;
    if (doorX >= room.x + room.w) doorX = room.x + room.w - 1;
    if (doorY < room.y) doorY = room.y;
    if (doorY >= room.y + room.h) doorY = room.y + room.h - 1;

    grid[doorY][doorX] = isBossRoom ? cs.bossDoor : cs.door;
  }

  function isInsideRoom(room, x, y){
    return x >= room.x && x < room.x + room.w && y >= room.y && y < room.y + room.h;
  }

  function createRoomGraph(rooms){
    const g = new Map();
    rooms.forEach((r)=>g.set(r, new Set()));
    return g;
  }

  function linkRooms(graph, a, b){
    if (!graph) return;
    if (!graph.has(a)) graph.set(a, new Set());
    if (!graph.has(b)) graph.set(b, new Set());
    graph.get(a).add(b);
    graph.get(b).add(a);
  }

  function isRoomReachable(graph, start, target, skip){
    if (!graph || !start || !target) return false;
    const visited = new Set();
    const q = [start];
    while (q.length){
      const r = q.shift();
      if (!r || r === skip || visited.has(r)) continue;
      if (r === target) return true;
      visited.add(r);
      const next = graph.get(r) || new Set();
      for (const n of next){
        if (n === skip || visited.has(n)) continue;
        q.push(n);
      }
    }
    return false;
  }

  function bossPathMandatory(graph, control, miniboss, boss){
    if (!graph || !control || !miniboss || !boss) return false;
    // 1) Debe haber un camino control→boss
    if (!isRoomReachable(graph, control, boss, null)) return false;
    // 2) Si quitamos mini-boss, el boss debe quedar aislado del inicio
    return !isRoomReachable(graph, control, boss, miniboss);
  }

  function paintCorridorStripe(ascii, x, y, width, orientation, protectedRooms, cs){
    const offset = Math.floor(width / 2);
    const floorChar = '.';
    for (let w = 0; w < width; w++){
      const delta = w - offset;
      const tx = orientation === 'vertical' ? x + delta : x;
      const ty = orientation === 'vertical' ? y : y + delta;
      if (ascii[ty]?.[tx] === undefined) continue;
      const touchesRoom = protectedRooms?.some(r => isInsideRoom(r, tx, ty));
      if (touchesRoom) continue;
      ascii[ty][tx] = floorChar;
    }
  }

  function carveCorridorSegment(ascii, fromX, fromY, toX, toY, width, cs, protectedRooms){
    const isVertical = fromX === toX;
    const stepX = isVertical ? 0 : (toX > fromX ? 1 : -1);
    const stepY = isVertical ? (toY > fromY ? 1 : -1) : 0;
    const steps = isVertical ? Math.abs(toY - fromY) : Math.abs(toX - fromX);
    const orientation = isVertical ? 'vertical' : 'horizontal';

    paintCorridorStripe(ascii, fromX, fromY, width, orientation, protectedRooms, cs);

    let x = fromX;
    let y = fromY;
    for (let i = 0; i < steps; i++){
      x += stepX;
      y += stepY;
      paintCorridorStripe(ascii, x, y, width, orientation, protectedRooms, cs);
    }
  }

  function carveCorridor(ascii, start, end, width, rng, cs, protectedRooms){
    const horizontalFirst = rng.rand ? rng.rand() < 0.5 : Math.random() < 0.5;
    const mid = horizontalFirst
      ? { x: end.x, y: start.y }
      : { x: start.x, y: end.y };
    const roomsToProtect = Array.isArray(protectedRooms) ? protectedRooms : [];
    carveCorridorSegment(ascii, start.x, start.y, mid.x, mid.y, width, cs, roomsToProtect);
    carveCorridorSegment(ascii, mid.x, mid.y, end.x, end.y, width, cs, roomsToProtect);
  }

  function pickDoorPosition(room, targetCenter, width, height){
    const dx = targetCenter.x - room.centerX;
    const dy = targetCenter.y - room.centerY;
    const preferHorizontal = Math.abs(dx) >= Math.abs(dy);
    if (preferHorizontal){
      if (dx >= 0){
        const y = clamp(room.centerY, room.y + 1, room.y + room.h - 2);
        return { x: room.x + room.w - 1, y, outX: Math.min(width - 2, room.x + room.w), outY: y };
      }
      const y = clamp(room.centerY, room.y + 1, room.y + room.h - 2);
      return { x: room.x, y, outX: Math.max(1, room.x - 1), outY: y };
    }
    if (dy >= 0){
      const x = clamp(room.centerX, room.x + 1, room.x + room.w - 2);
      return { y: room.y + room.h - 1, x, outX: x, outY: Math.min(height - 2, room.y + room.h) };
    }
    const x = clamp(room.centerX, room.x + 1, room.x + room.w - 2);
    return { y: room.y, x, outX: x, outY: Math.max(1, room.y - 1) };
  }

  function ensureRoomsConnected(ascii, rooms, control, corridorWidth, rng, cs, graph, avoidRooms){
    const start = findRoomWalkableTile(ascii, control, cs) || { x: control.centerX|0, y: control.centerY|0 };
    let reachable = floodAscii(ascii, start.x, start.y, cs);

    const roomReachable = (room)=> reachable[room.centerY]?.[room.centerX];

    const skipSet = avoidRooms instanceof Set ? avoidRooms : new Set();

    let safety = rooms.length * 2;
    while (rooms.some(r=>!roomReachable(r)) && safety-- > 0){
      const reachableRooms = rooms.filter(r=>roomReachable(r) && !skipSet.has(r));
      const unreachable = rooms.filter(r=>!roomReachable(r) && !skipSet.has(r));
      if (!reachableRooms.length || !unreachable.length) break;

      const target = unreachable[0];
      let best = null;
      let bestD2 = Infinity;
      for (const base of reachableRooms){
        const dx = target.centerX - base.centerX;
        const dy = target.centerY - base.centerY;
        const d2 = dx*dx + dy*dy;
        if (d2 < bestD2){ bestD2 = d2; best = base; }
      }
      if (!best) break;

      connectRoomPair(ascii, best, target, corridorWidth, rng, cs, rooms, graph);
      reachable = floodAscii(ascii, start.x, start.y, cs);
    }

    return reachable;
  }

  function connectRoomPair(ascii, roomA, roomB, corridorWidth, rng, cs, allRooms, graph){
    const centerA = { x: roomA.centerX, y: roomA.centerY };
    const centerB = { x: roomB.centerX, y: roomB.centerY };
    const doorA = pickDoorPosition(roomA, centerB, ascii[0].length, ascii.length);
    const doorB = pickDoorPosition(roomB, centerA, ascii[0].length, ascii.length);

    openDoorBetween(ascii, roomA, doorA.x, doorA.y, roomA.type === 'boss', cs);
    openDoorBetween(ascii, roomB, doorB.x, doorB.y, roomB.type === 'boss', cs);

    const protectedRooms = Array.isArray(allRooms) ? allRooms : [roomA, roomB];
    carveCorridor(ascii, { x: doorA.outX, y: doorA.outY }, { x: doorB.outX, y: doorB.outY }, corridorWidth, rng, cs, protectedRooms);
    ascii._corridors = (ascii._corridors || 0) + 1;
    linkRooms(graph, roomA, roomB);
  }

  function connectRoomsWithMST(ascii, rooms, corridorWidth, rng, cs, opts){
    if (!rooms.length) return;
    const { graph=null, avoid=null } = opts || {};
    const avoidSet = avoid instanceof Set ? avoid : new Set();
    const connected = [rooms[0]];
    const remaining = rooms.slice(1);
    while (remaining.length){
      let bestPair = null;
      let bestDist = Infinity;
      for (const r of remaining){
        for (const c of connected){
          if (avoidSet.has(r) || avoidSet.has(c)) continue;
          const dx = r.centerX - c.centerX;
          const dy = r.centerY - c.centerY;
          const d2 = dx*dx + dy*dy;
          if (d2 < bestDist){ bestDist = d2; bestPair = { from: c, to: r }; }
        }
      }
      if (!bestPair) break;
      connectRoomPair(ascii, bestPair.from, bestPair.to, corridorWidth, rng, cs, rooms, graph);
      connected.push(bestPair.to);
      remaining.splice(remaining.indexOf(bestPair.to), 1);
    }
  }

  function computeOccupancy(ascii, cs){
    const H = ascii.length;
    const W = ascii[0]?.length || 0;
    let walkable = 0;
    for (let y=0; y<H; y++){
      for (let x=0; x<W; x++){
        if (isWalkableChar(ascii[y][x], cs)) walkable++;
      }
    }
    const total = H * W;
    return { walkable, total, ratio: total > 0 ? walkable / total : 0 };
  }

  function rectToBlockRect(room, padding=0){
    if (!room) return null;
    return {
      x1: room.x + padding,
      y1: room.y + padding,
      x2: room.x + room.w - 1 - padding,
      y2: room.y + room.h - 1 - padding
    };
  }

  function findNearestWalkable(ascii, origin, cs, maxRadius=36){
    for (let r=0; r<=maxRadius; r++){
      for (let dy=-r; dy<=r; dy++){
        for (let dx=-r; dx<=r; dx++){
          const x = origin.x + dx;
          const y = origin.y + dy;
          if (x<1 || y<1 || y>=ascii.length-1 || x>=ascii[0].length-1) continue;
          if (isWalkableChar(ascii[y][x], cs)) return { x, y };
        }
      }
    }
    return null;
  }

  function densifyMap(ascii, rooms, targetRatio, corridorWidth, rng, cs){
    const safeTarget = clamp(targetRatio || 0.9, 0.3, 0.98);
    let { ratio } = computeOccupancy(ascii, cs);
    if (ratio >= safeTarget) return;

    const H = ascii.length;
    const W = ascii[0].length;
    const boss = rooms.find(r=>r.type==='boss') || null;
    const bossBuffer = boss ? expand(boss, 3) : null;
    const maxAttempts = 28;
    let attempts = 0;

    while (ratio < safeTarget && attempts++ < maxAttempts){
      const rw = randInt(rng, 6, 12);
      const rh = randInt(rng, 5, 10);
      const rx = randInt(rng, 2, Math.max(2, W - rw - 3));
      const ry = randInt(rng, 2, Math.max(2, H - rh - 3));
      const rect = { x: rx, y: ry, w: rw, h: rh };

      if (bossBuffer && overlap(rect, bossBuffer)) continue;
      if (rooms.some(r => overlap(expand(rect, 1), expand(r, 0)))) continue;

      // Carvar un pequeño bloque de relleno y conectarlo al suelo más cercano
      carveRect(ascii, rect, cs.floor);
      const anchor = centerOf(rect);
      const near = findNearestWalkable(ascii, anchor, cs, 48);
      if (near){
        carveCorridor(ascii, anchor, near, Math.max(2, corridorWidth-1), rng, cs, rooms);
      }

      ratio = computeOccupancy(ascii, cs).ratio;
    }
  }

  function allBossPathsGoThroughMini(mapNumeric, start, boss, miniboss){
    if (!mapNumeric || !start || !boss || !miniboss) return false;
    const fullReach = flood(mapNumeric, start.x, start.y, null);
    if (fullReach?.[boss.y]?.[boss.x] === Infinity) return false;
    const block = rectToBlockRect(miniboss, 0);
    const blockedReach = flood(mapNumeric, start.x, start.y, block);
    return blockedReach?.[boss.y]?.[boss.x] === Infinity;
  }

  function parseRangeAvg(text, fallback=0){
    if (!text) return fallback;
    if (typeof text === 'number') return text;
    const str = String(text);
    if (str.includes('-')){
      const [a,b] = str.split('-').map(v=>parseFloat(v));
      if (Number.isFinite(a) && Number.isFinite(b)) return (a + b) / 2;
    }
    const n = parseFloat(str);
    return Number.isFinite(n) ? n : fallback;
  }

  function parsePerRoom(perRoomStr) {
    if (!perRoomStr) return { min: 0, max: 0 };
    const parts = String(perRoomStr).split('-');
    if (parts.length === 1) {
      const v = parseInt(parts[0], 10) || 0;
      return { min: v, max: v };
    }
    return {
      min: parseInt(parts[0], 10) || 0,
      max: parseInt(parts[1], 10) || 0
    };
  }

  function gatherRuleCount(rules, type, kind){
    if (!Array.isArray(rules)) return 0;
    let total = 0;
    for (const r of rules){
      if (!r || r.type !== type) continue;
      if (kind && r.kind && r.kind !== kind) continue;
      if (Number.isFinite(r.count)) total += r.count;
      else if (typeof r.count === 'string'){ total += parseFloat(r.count) || 0; }
      else if (r.perRoom){ total += parseRangeAvg(r.perRoom, 0); }
    }
    return total;
  }

  function randomInt(min, maxInclusive) {
    return min + Math.floor(Math.random() * (maxInclusive - min + 1));
  }

  function randomFreeTileInRoom(grid, room) {
    let tries = 0;
    while (tries++ < 100) {
      const x = randomInt(room.x + 1, room.x + room.w - 2);
      const y = randomInt(room.y + 1, room.y + room.h - 2);

      if (grid[y][x] === '.' || grid[y][x] === '-' || grid[y][x] === ',' || grid[y][x] === ';') {
        return { x, y };
      }
    }

    return { x: room.centerX, y: room.centerY };
  }

  function isFloorTile(ch) {
    const baseFloor = CHARSET_DEFAULT?.floor || '.';
    return ch === baseFloor || ch === '.' || ch === '-' || ch === ',' || ch === ';';
  }

  // ============================================================================
  //  NPC PLACEMENT – ZONA ESTABLE
  //  NO modificar la estructura de llaves/paréntesis de este bloque.
  //  Si necesitas cambiar la lógica interna, no toques:
  //    - La IIFE (function (W) { ... })(window);
  //    - La firma de _placeNpcsFromRule(grid, rooms, rule)
  // ============================================================================
  function _placeNpcsFromRule(grid, rooms, rule) {
    const perRoom = parsePerRoom(rule.perRoom);
    const minPer = Math.max(0, Math.min(perRoom.min, perRoom.max));
    const maxPer = Math.max(minPer, Math.max(perRoom.min, perRoom.max));
    let remaining = rule.unique ? 1 : (Number.isFinite(rule.count) ? rule.count : 0);
    if (remaining <= 0) return;

    const bossRoom = rooms.find(r => r.type === 'boss');
    const controlRoom = rooms.find(r => r.type === 'control');

    const char = (kind => {
      switch ((kind || '').toLowerCase()) {
        case 'medico': return 'k';
        case 'guardia': return 'g';
        case 'familiar': return 'v';
        case 'celador': return 'c';
        case 'limpieza': return 'h';
        case 'supervisora': return 'H';
        case 'jefe': return 'J';
        default: return 'N';
      }
    })(rule.kind);

    function roomsByPreference() {
      if (rule.unique && rule.kind === 'supervisora' && controlRoom) return [controlRoom];
      if (rule.unique && rule.kind === 'jefe' && bossRoom) {
        const bossCenter = { x: bossRoom.centerX, y: bossRoom.centerY };
        const candidates = rooms.filter(r => r.type !== 'boss' && r.type !== 'control');
        candidates.sort((a, b) => {
          const da = Math.pow(a.centerX - bossCenter.x, 2) + Math.pow(a.centerY - bossCenter.y, 2);
          const db = Math.pow(b.centerX - bossCenter.x, 2) + Math.pow(b.centerY - bossCenter.y, 2);
          return da - db;
        });
        return candidates;
      }
      const normals = rooms.filter(r => r.type === 'normal');
      const extra = rooms.filter(r => r.type === 'miniboss');
      if (controlRoom && !rule.unique) extra.push(controlRoom);
      return normals.concat(extra);
    }

    for (const room of roomsByPreference()) {
      if (remaining <= 0) break;
      const desired = rule.unique ? 1 : randomInt(minPer, maxPer);
      const nRoom = Math.min(remaining, Math.max(1, desired));
      for (let i = 0; i < nRoom && remaining > 0; i++) {
        const pos = randomFreeTileInRoom(grid, room);
        if (!pos || !isFloorTile(grid[pos.y][pos.x])) continue;
        grid[pos.y][pos.x] = char;
        remaining--;
        if (rule.unique) return;
      }
    }
  }
  // ============================================================================

  function placeEnemiesFromRule(grid, rooms, rule) {
    const perRoom = parsePerRoom(rule.perRoom);
    const minPer = Math.max(0, Math.min(perRoom.min, perRoom.max));
    const maxPer = Math.max(minPer, Math.max(perRoom.min, perRoom.max));
    let remaining = Number.isFinite(rule.count) ? rule.count : 0;
    if (remaining <= 0) return;

    const char = (kind => {
      switch ((kind || '').toLowerCase()) {
        case 'rat': return 'r';
        case 'mosquito': return 'm';
        case 'furious': return 'P';
        default: return 'A';
      }
    })(rule.kind);

    const eligible = rooms.filter(r => r.type === 'normal' || r.type === 'miniboss');

    for (const room of eligible) {
      if (remaining <= 0) break;
      const nRoom = Math.min(remaining, randomInt(minPer, maxPer));
      for (let i = 0; i < nRoom && remaining > 0; i++) {
        const pos = randomFreeTileInRoom(grid, room);
        if (!pos || !isFloorTile(grid[pos.y][pos.x])) continue;
        grid[pos.y][pos.x] = char;
        remaining--;
      }
    }
  }

  function placeCartsFromRule(grid, rooms, rule) {
    const perRoom = parsePerRoom(rule.perRoom);
    const minPer = Math.max(0, Math.min(perRoom.min, perRoom.max));
    const maxPer = Math.max(minPer, Math.max(perRoom.min, perRoom.max));
    let remaining = Number.isFinite(rule.count) ? rule.count : 0;
    if (remaining <= 0) return;

    const char = (kind => {
      switch ((kind || '').toLowerCase()) {
        case 'comida': return 'F';
        case 'medicina': return '+';
        case 'urgencias': return 'U';
        default: return 'C';
      }
    })(rule.kind);

    const bossRoom = rooms.find(r => r.type === 'boss');
    const candidates = rooms.filter(r => r.type !== 'boss');

    const sorted = [...candidates];
    if (rule.kind === 'urgencias' && bossRoom) {
      const center = { x: bossRoom.centerX, y: bossRoom.centerY };
      sorted.sort((a, b) => {
        const da = Math.pow(a.centerX - center.x, 2) + Math.pow(a.centerY - center.y, 2);
        const db = Math.pow(b.centerX - center.x, 2) + Math.pow(b.centerY - center.y, 2);
        return da - db;
      });
    }

    for (const room of sorted) {
      if (remaining <= 0) break;
      const nRoom = Math.min(remaining, randomInt(minPer, maxPer));
      for (let i = 0; i < nRoom && remaining > 0; i++) {
        const pos = randomFreeTileInRoom(grid, room);
        if (!pos || !isFloorTile(grid[pos.y][pos.x])) continue;
        grid[pos.y][pos.x] = char;
        remaining--;
      }
    }
  }

  function placePatientsFromRule(grid, rooms, rule) {
    const candidateRooms = rooms.filter(r => r.type === 'normal');

    let patientsLeft = rule.count || 0;
    let roomIndex = 0;

    while (patientsLeft > 0 && candidateRooms.length > 0) {
      const room = candidateRooms[roomIndex % candidateRooms.length];

      const pos = randomFreeTileInRoom(grid, room);
      const x = pos.x;
      const y = pos.y;

      if (grid[y][x] !== '.' && grid[y][x] !== '-' && grid[y][x] !== ',' && grid[y][x] !== ';') {
        roomIndex++;
        continue;
      }

      grid[y][x] = 'p';

      if (rule.bell) {
        if (grid[y][x + 1] && (grid[y][x + 1] === '.' || grid[y][x + 1] === '-' || grid[y][x + 1] === ',' || grid[y][x + 1] === ';')) {
          grid[y][x + 1] = 'b';
        } else if (grid[y][x - 1] && (grid[y][x - 1] === '.' || grid[y][x - 1] === '-' || grid[y][x - 1] === ',' || grid[y][x - 1] === ';')) {
          grid[y][x - 1] = 'b';
        }
      }

      if (grid[y + 1] && (grid[y + 1][x] === '.' || grid[y + 1][x] === '-' || grid[y + 1][x] === ',' || grid[y + 1][x] === ';')) {
        grid[y + 1][x] = 'i';
      }

      patientsLeft--;
      roomIndex++;
    }
  }

  function placeElevatorsFromRule(grid, rooms, rule) {
    const pairs = rule.count || 1;

    const eligibleRooms = rooms.filter(r => r.type !== 'boss');

    if (eligibleRooms.length < 2) return;

    for (let i = 0; i < pairs; i++) {
      const fromRoom = eligibleRooms.find(r => r.type === 'control') || eligibleRooms[0];
      let toRoom = eligibleRooms.find(r => r.type === 'miniboss') || eligibleRooms[eligibleRooms.length - 1];

      if (toRoom === fromRoom && eligibleRooms.length > 1) {
        toRoom = eligibleRooms[(eligibleRooms.indexOf(fromRoom) + 1) % eligibleRooms.length];
      }

      const fromPos = randomFreeTileInRoom(grid, fromRoom);
      const toPos   = randomFreeTileInRoom(grid, toRoom);

      grid[fromPos.y][fromPos.x] = 'E';
      grid[toPos.y][toPos.x]     = 'E';
    }
  }

  function placeControlRoomPhone(grid, rooms, used = new Set()) {
    const controlRoom = rooms.find(r => r.type === 'control');
    if (!controlRoom) return;

    for (let i = 0; i < 50; i++) {
      const pos = randomFreeTileInRoom(grid, controlRoom);
      const key = `${pos.x},${pos.y}`;
      if (used.has(key)) continue;
      grid[pos.y][pos.x] = 't';
      used.add(key);
      return;
    }
  }

  function generateNormalLayout({ width, height, levelConfig, rng, charset }){
    const cs = charset || CHARSET_DEFAULT;
    const totalRooms = Math.max(3, Number(levelConfig.rooms) || 8);
    const corridorWidth = Math.max(2, Math.min(4, Math.round(Math.min(width, height) / 30)));
    const maxRestarts = 20;
    const mapArea = width * height;
    // Ratio configurable de ocupación de celdas jugables (pasillos+salas)
    const occupancyTarget = clamp(
      Number(levelConfig.mapOccupancyRatio ?? levelConfig.map_occupancy_ratio ?? levelConfig.mapOccupancy ?? 0.9) || 0.9,
      0.35,
      0.98
    );

    for (let attempt = 0; attempt < maxRestarts; attempt++){
      const fillAim = clamp(occupancyTarget * 0.6, 0.4, 0.75);
      const jitter = ((rng.rand?.() ?? Math.random()) * 0.08) - 0.02;
      const fillRatio = clamp(fillAim + jitter - attempt * 0.015, 0.35, 0.8);
      const targetRoomsArea = mapArea * fillRatio;
      const normalsNeeded = Math.max(0, totalRooms - 3);
      const weights = { control: 1.15, boss: 1.4, miniboss: 1.2, normal: 1 };
      const totalWeight = weights.control + weights.boss + weights.miniboss + weights.normal * Math.max(1, normalsNeeded);
      const baseArea = targetRoomsArea / Math.max(1, totalWeight);
      const jitterSize = () => 0.85 + ((rng.rand?.() ?? Math.random()) * 0.3);
      const controlPicker = () => planRoomSize(rng, baseArea * weights.control * jitterSize(), width, height);
      const bossPicker = () => planRoomSize(rng, baseArea * weights.boss * jitterSize(), width, height);
      const normalPickers = [];
      if (normalsNeeded > 0) {
        normalPickers.push(() => planRoomSize(rng, baseArea * weights.miniboss * jitterSize(), width, height));
      }
      for (let n = 1; n < normalsNeeded; n++) {
        normalPickers.push(() => planRoomSize(rng, baseArea * weights.normal * jitterSize(), width, height));
      }

      const ascii = create2DArray(height, width, cs.wall);
      ascii._corridors = 0;
      ascii._roomsRequested = totalRooms;
      const rooms = [];
      const control = chooseControlRoom(rng, width, height, controlPicker, rooms);
      if (!control) continue;
      rooms.push(control);

      const boss = chooseBossRoom(rng, width, height, bossPicker, control, rooms);
      if (!boss) continue;
      rooms.push(boss);

      const normals = placeNormalRooms(rng, width, height, normalPickers, rooms);
      if (!normals) continue;
      rooms.push(...normals);

      const candidatesMiniBoss = rooms.filter(r => r !== control && r !== boss);
      const miniBoss = pickFarthestRoom(candidatesMiniBoss, { x: control.centerX, y: control.centerY }) || candidatesMiniBoss[0];
      if (miniBoss) miniBoss.type = 'miniboss';
      else continue;

      rooms.forEach((r) => markRoom(ascii, r, cs));
      rooms.forEach((r) => applyRoomFloorChars(ascii, r));
      const roomGraph = createRoomGraph(rooms);
      const roomsWithoutBoss = rooms.filter(r => r !== boss);
      connectRoomsWithMST(ascii, roomsWithoutBoss, corridorWidth, rng, cs, { graph: roomGraph, avoid: new Set([boss]) });
      ensureRoomsConnected(ascii, roomsWithoutBoss, control, corridorWidth, rng, cs, roomGraph, new Set([boss]));
      if (miniBoss && boss) {
        connectRoomPair(ascii, miniBoss, boss, corridorWidth, rng, cs, rooms, roomGraph);
      }
      // Relleno para alcanzar densidad objetivo sin crear islas vacías
      densifyMap(ascii, rooms, occupancyTarget, corridorWidth, rng, cs);
      const reachable = floodAscii(ascii, control.centerX|0, control.centerY|0, cs);
      const numericCheck = asciiToNumeric(ascii);
      const startTile = findRoomWalkableTile(ascii, control, cs) || { x: control.centerX|0, y: control.centerY|0 };
      const bossTile = findRoomWalkableTile(ascii, boss, cs) || { x: boss.centerX|0, y: boss.centerY|0 };
      // Validación de flujo: el mini-boss debe ser cuello de botella hacia el boss
      const miniGateOk = miniBoss ? allBossPathsGoThroughMini(numericCheck, startTile, bossTile, miniBoss) : true;
      if (!miniGateOk || !bossPathMandatory(roomGraph, control, miniBoss, boss)) continue;
      sealMapBorder(ascii, cs);

      const occupancyData = computeOccupancy(ascii, cs);

      const used = new Set();
      const occupy = (p)=>{ if (p) used.add(`${p.x},${p.y}`); };
      const pickFreeTile = (room)=>{
        for (let i = 0; i < 100; i++) {
          const pos = randomFreeTileInRoom(ascii, room);
          const key = `${pos.x},${pos.y}`;
          if (used.has(key)) continue;
          if (!isFloorTile(ascii[pos.y][pos.x])) continue;
          return pos;
        }
        return { x: room.centerX|0, y: room.centerY|0 };
      };

      // Hero spawn
      const heroPos = pickFreeTile(control);
      if (heroPos) { ascii[heroPos.y][heroPos.x] = cs.start; occupy(heroPos); }

      // Boss marker
      const bossPos = pickFreeTile(boss);
      if (bossPos) { ascii[bossPos.y][bossPos.x] = cs.bossMarker; occupy(bossPos); }

      const rules = levelConfig.rules || [];
      rules.forEach(rule => {
        switch (rule.type) {
          case 'patient':
            placePatientsFromRule(ascii, rooms, rule);
            break;
          case 'elevator':
            placeElevatorsFromRule(ascii, rooms, rule);
            break;
          case 'npc':
            _placeNpcsFromRule(ascii, rooms, rule);
            break;
          case 'enemy':
            placeEnemiesFromRule(ascii, rooms, rule);
            break;
          case 'cart':
            placeCartsFromRule(ascii, rooms, rule);
            break;
        }
      });
      placeControlRoomPhone(ascii, rooms, used);

      rooms.forEach(room => {
        const pos = pickFreeTile(room);
        const broken = Math.random() < 0.2;
        ascii[pos.y][pos.x] = broken ? 'l' : 'L';
        occupy(pos);
      });

      const lootSpawns = Math.max(1, Math.round(gatherRuleCount(rules, 'loot') || rooms.length / 4));

      const roomPool = rooms.filter(r=>r.type==='normal' || r.type==='control');
      function placeInRoomPool(char, count){
        for (let i=0; i<count; i++){
          const rr = rng.pick(roomPool) || control;
          const pos = pickFreeTile(rr);
          if (pos){ ascii[pos.y][pos.x] = char; occupy(pos); }
        }
      }

      placeInRoomPool(cs.loot || 'o', lootSpawns);

      sealMapBorder(ascii, cs);

      ascii._rooms = rooms;
      ascii._control = control;
      ascii._boss = boss;
      ascii._miniboss = miniBoss || null;
      ascii._corridorWidth = corridorWidth;
      ascii._reachable = reachable;
      ascii._roomGraph = roomGraph;
      ascii._roomsGenerated = rooms.length;
      ascii._occupancy = occupancyData;
      ascii._occupancyTarget = occupancyTarget;
      return ascii;
    }

    throw new Error('[MapGenAPI] failed to generate map for level ' + (levelConfig?.id || '?'));
  }

  function carveRoomAtCenterish(rng, map, Wd, Hd, meta={}){
    const rw = rng.int(14, 24), rh = rng.int(12, 20);
    const cx = rng.int(Math.floor(Wd*0.35), Math.floor(Wd*0.65));
    const cy = rng.int(Math.floor(Hd*0.35), Math.floor(Hd*0.65));
    const r  = { x: clamp(cx-(rw>>1), 2, Wd-rw-2), y: clamp(cy-(rh>>1), 2, Hd-rh-2), w:rw, h:rh, tag: meta.tag||'' };
    carveRect(map, r, 0);
    return r;
  }

  function attemptRooms(rng, map, rooms, target){
    const W=map[0].length, H=map.length;
    const tries = Math.max(target*3, 600);
    let placed=1; // ya hay control
    for(let i=0;i<tries && placed<target;i++){
      const rw = rng.int(8, 22), rh = rng.int(6, 20);
      const rx = rng.int(2, W-rw-3), ry = rng.int(2, H-rh-3);
      const rect = { x:rx, y:ry, w:rw, h:rh };
      const pad2 = expand(rect, 10); // >=10 tiles de separación entre salas
      let ok=true;
      for(const o of rooms){ if (overlap(pad2,o)) { ok=false; break; } }
      if (!ok) continue;
      carveRect(map, rect, 0);
      // guardar un poquito el “pad” en la propia sala para evitar puertas pegadas
      rooms.push(rect);
      placed++;
    }
  }

  function connectRoomsWithCorridors(rng, map, rooms, extraLoops){
    const centers = rooms.map(centerOf);
    const edges = mst(centers);
    for(const e of edges) carveL(map, e.a, e.b, rng);
    // loops extra
    const add = Math.floor(edges.length * extraLoops);
    for(let i=0;i<add;i++){
      const a = rng.pick(centers), b = rng.pick(centers);
      carveL(map, a, b, rng);
    }
  }

  function carveL(map, a, b, rng) {
    // Pasillo estrecho (2 tiles) y boca pequeña en el borde de la sala
    const w = 2;

    const ax = a.x|0, ay = a.y|0;
    const bx = b.x|0, by = b.y|0;

    // Punto medio entre centros (charnera de la "L")
    const mid = (p,q)=> (p+q)>>1;
    const mx = mid(ax,bx), my = mid(ay,by);

    // Trazo en L (H+V o V+H), limitado al entorno; NO barre paredes enteras
    if (rng && rng.chance ? rng.chance(0.5) : Math.random() < 0.5) {
      digH(map, Math.min(ax, mx), Math.max(ax, mx), ay, w);
      digV(map, Math.min(ay, by), Math.max(ay, by), mx, w);
      digH(map, Math.min(mx, bx), Math.max(mx, bx), by, w);
    } else {
      digV(map, Math.min(ay, my), Math.max(ay, my), ax, w);
      digH(map, Math.min(ax, bx), Math.max(ax, bx), my, w);
      digV(map, Math.min(my, by), Math.max(my, by), bx, w);
    }

    // Abre la boca EN EL BORDE de cada sala, alineada al centro del lateral, evitando esquinas
    openMouthToward(ax, ay, bx, by);
    openMouthToward(bx, by, ax, ay);

    function openMouthToward(cx, cy, tx, ty){
      // elegimos eje dominante hacia el destino
      const horiz = Math.abs(tx - cx) >= Math.abs(ty - cy);

      if (horiz) {
        const dir = (tx > cx) ? 1 : -1;
        let x = cx;
        // avanza desde el centro hasta chocar con pared (1) → borde
        while (map[cy][x] === 0) x += dir;
        // celda de pared y la celda exterior
        const doorX = x;
        const outX  = x + dir;
        // evita esquinas: desplaza una casilla si arriba/abajo son pared
        let y = cy;
        if (map[y-1]?.[doorX] === 1 && map[y+1]?.[doorX] === 1) {
          y += (ty > cy) ? 1 : -1;
        }
        // abre hueco de 1 tile (cuello) en la pared y un pellizco fuera
        digH(map, doorX, doorX, y, 1);
        digH(map, Math.min(outX, outX), Math.max(outX, outX), y, 1);
      } else {
        const dir = (ty > cy) ? 1 : -1;
        let y = cy;
        while (map[y][cx] === 0) y += dir;
        const doorY = y;
        const outY  = y + dir;
        let x = cx;
        if (map[doorY]?.[x-1] === 1 && map[doorY]?.[x+1] === 1) {
          x += (tx > cx) ? 1 : -1;
        }
        digV(map, doorY, doorY, x, 1);
        digV(map, Math.min(outY, outY), Math.max(outY, outY), x, 1);
      }
    }
  }

  function pickFarthestRoom(rooms, ref){
    let best=null, bestD=-1;
    for(const r of rooms){
      const c=centerOf(r);
      const d=(c.x-ref.x)*(c.x-ref.x)+(c.y-ref.y)*(c.y-ref.y);
      if(d>bestD){ bestD=d; best=r; }
    }
    return best;
  }

  function placeElevators(rng, map, rooms, ctrl, boss, ascii, cs){
    const usable = rooms.filter(r=> r!==ctrl && r!==boss);
    rng.shuffle(usable);
    const pairs = [];
    const closed = [];
    // Elegimos 3 salas distintas (si hay)
    const r1 = usable[0], r2 = usable[1], r3 = usable[2], r4 = usable[3];
    if (r1 && r2){
      const a = placeInside(map, r1) || centerOf(r1);
      const b = placeInside(map, r2) || centerOf(r2);
      put(ascii, a.tx, a.ty, cs.elev);
      put(ascii, b.tx, b.ty, cs.elev);
      pairs.push(a,b);
    }
    if (r3){
      const c = placeInside(map, r3) || centerOf(r3);
      put(ascii, c.tx, c.ty, cs.elevClosed);
      closed.push(c);
    }
    if (r4){
      const d = placeInside(map, r4) || centerOf(r4);
      put(ascii, d.tx, d.ty, cs.elevClosed);
      closed.push(d);
    }
    return { activePair: pairs, closed };
  }

  function placeLights(rng, map, ascii, cs, count, start){
    const W=map[0].length,H=map.length;
    const out=[];
    let placed=0, tries=0, maxTries=count*50;
    while(placed<count && tries<maxTries){
      tries++;
      const x=rng.int(2,W-3), y=rng.int(2,H-3);
      if (map[y][x]!==0) continue;
      if (Math.abs(x-start.x)+Math.abs(y-start.y)<6) continue; // alejar de start
      const around=[map[y-1][x],map[y+1][x],map[y][x-1],map[y][x+1]].filter(v=>v===1).length;
      if (around>=3) continue; // no pegado a pared
      const broken=rng.chance(0.14);
      put(ascii, x,y, broken? cs.lightBroken : cs.light);
      out.push({tx:x,ty:y,broken, color: pickLightColor(rng)});
      placed++;
    }
    return out;
  }
  function pickLightColor(rng){
    const pool=[
      'rgba(255,245,200,0.28)','rgba(180,220,255,0.25)',
      'rgba(220,255,210,0.25)','rgba(255,235,170,0.30)'
    ];
    return rng.pick(pool);
  }

  function placeSpawners(rng, map, ascii, cs, defs, lvl, start, ctrl, boss){
    const out={ mosquito:[], rat:[], staff:[], cart:[] };
    const W=map[0].length,H=map.length;
    const mins = { mosquito: 40, rat:30, staff:25, cart:22 };

    if (defs.animals.mosquito){
      const n = SPAWN_SCALE.mosquito(lvl);
      for(let i=0;i<n;i++){
        const p = farFrom(RNG(rng.rand()*1e9), map, start, mins.mosquito);
        if (!p) break; put(ascii, p.tx,p.ty, cs.spAnimal||'A'); out.mosquito.push({ ...p, prefers:'mosquito' });
      }
    }
    if (defs.animals.rat){
      const n = SPAWN_SCALE.rat(lvl);
      for(let i=0;i<n;i++){
        const p = farFrom(RNG(rng.rand()*1e9), map, start, mins.rat);
        if (!p) break; put(ascii, p.tx,p.ty, cs.spAnimal||'A'); out.rat.push({ ...p, prefers:'rat' });
      }
    }
    if (defs.humans.staff){
      const n = SPAWN_SCALE.staff(lvl);
      for(let i=0;i<n;i++){
        const p = farFrom(RNG(rng.rand()*1e9), map, start, mins.staff);
        if (!p) break; put(ascii, p.tx,p.ty, cs.spStaff||'N'); out.staff.push(p);
      }
    }
    if (defs.carts.food || defs.carts.meds || defs.carts.er){
      const n = SPAWN_SCALE.carts(lvl);
      for(let i=0;i<n;i++){
        const p = farFrom(RNG(rng.rand()*1e9), map, start, mins.cart);
        if (!p) break; put(ascii, p.tx,p.ty, cs.spCart||'C'); out.cart.push(p);
      }
    }
    return out;
    }

  function placePatientsSet(rng, map, ascii, cs, rooms, ctrl, boss){
    const candidates = rooms.filter(r=>r!==ctrl && r!==boss);
    const picked = RNG(rng.rand()*1e9).shuffle(candidates.slice()).slice(0,7);
    const patients=[], pills=[], bells=[];
    for(let i=0;i<picked.length;i++){
      const r=picked[i];
      const P = placeInside(map, r) || centerOf(r);
      const I = placeNear(map, P.tx, P.ty, RNG(rng.rand()*1e9).int(6,12)) || P;
      const B = placeNear(map, P.tx, P.ty, 4) || P;
      put(ascii, P.tx,P.ty, cs.patient);
      put(ascii, I.tx,I.ty, cs.pill);
      put(ascii, B.tx,B.ty, cs.bell);
      patients.push({tx:P.tx,ty:P.ty, name: funnyPatientName(i) });
      pills.push({tx:I.tx,ty:I.ty, targetName: funnyPatientName(i) });
      bells.push({tx:B.tx,ty:B.ty});
    }
    return { patients, pills, bells };
  }

  function validateDoorsPerRoom(ascii, rooms, cs, report){
    let ok=true;
    for(const r of rooms){
      let c=0;
      for(let x=r.x; x<r.x+r.w; x++){
        if (ascii[r.y-1]?.[x]===cs.door||ascii[r.y-1]?.[x]===cs.bossDoor) c++;
        if (ascii[r.y+r.h]?.[x]===cs.door||ascii[r.y+r.h]?.[x]===cs.bossDoor) c++;
      }
      for(let y=r.y; y<r.y+r.h; y++){
        if (ascii[y]?.[r.x-1]===cs.door||ascii[y]?.[r.x-1]===cs.bossDoor) c++;
        if (ascii[y]?.[r.x+r.w]===cs.door||ascii[y]?.[r.x+r.w]===cs.bossDoor) c++;
      }
      const isBoss = (r.tag==='boss') || false;
      const good = isBoss ? (c===1) : (c>=1 && c<=4);
      if (!good){ ok=false; report.push({warn:'room_door_count', room:r, count:c}); }
    }
    if (ok) report.push({ ok:'rooms_have_valid_door_count' });
  }

  function validateSetsReachability(map, start, blockBoss, patients, pills, bells, report){
    const D = flood(map, start.x, start.y, blockBoss);
    let unreachable=0;
    function chk(list,label){
      for(const p of list){ if (D[p.ty]?.[p.tx]===Infinity) { unreachable++; report.push({warn:'unreachable_'+label, at:p}); } }
    }
    chk(patients,'patient');
    chk(pills,'pill');
    chk(bells,'bell');
    if (unreachable===0) report.push({ ok:'all_sets_reachable_ex_boss' });
  }

  function countDiagonalViolations(map){
    const H=map.length, W=map[0].length;
    let v=0;
    for(let y=1;y<H-1;y++){
      for(let x=1;x<W-1;x++){
        if (map[y][x]!==0) continue;
        if (map[y+1][x+1]===0 && map[y][x+1]===1 && map[y+1][x]===1) v++;
        if (map[y-1][x+1]===0 && map[y][x+1]===1 && map[y-1][x]===1) v++;
      }
    }
    return v;
  }
  function countUnreachable(map, start, blockRect){
    const D = flood(map, start.x, start.y, blockRect);
    let n=0;
    for(let y=0;y<map.length;y++)
      for(let x=0;x<map[0].length;x++)
        if (map[y][x]===0 && D[y][x]===Infinity) n++;
    return n;
  }

  function buildPlacements(map, areas, rooms, corridors, ascii, level, rng, charset) {
    const placements = [];
    const rint = (a,b)=> (a + Math.floor(rng()*(b-a+1)));
    const pick = (arr)=> arr[Math.floor(rng()*arr.length)];
    function centerOf(room){ return {x: Math.floor(room.x + room.w/2), y: Math.floor(room.y + room.h/2)}; }
    function randomInside(room, margin=1){
      return { x: rint(room.x+margin, room.x+room.w-1-margin), y: rint(room.y+margin, room.y+room.h-1-margin) };
    }
    function nearPerimeter(room, dist=2){
      const side = pick(['TOP','BOTTOM','LEFT','RIGHT']); let x,y;
      if (side==='TOP'){ y = room.y+1+dist; x = rint(room.x+2, room.x+room.w-3); }
      if (side==='BOTTOM'){ y = room.y+room.h-2-dist; x = rint(room.x+2, room.x+room.w-3); }
      if (side==='LEFT'){ x = room.x+1+dist; y = rint(room.y+2, room.y+room.h-3); }
      if (side==='RIGHT'){ x = room.x+room.w-2-dist; y = rint(room.y+2, room.y+room.h-3); }
      return {x,y};
    }
    function sampleAlongCorridor(c, step=10){
      const cells=[]; if (c.w >= c.h){ const y = c.y + Math.floor(c.h/2);
        for (let x=c.x+2; x<c.x+c.w-2; x+=step) cells.push({x,y});
      } else { const x = c.x + Math.floor(c.w/2);
        for (let y=c.y+2; y<c.y+c.h-2; y+=step) cells.push({x,y});
      } return cells;
    }
    function markAscii(x,y,ch){ if (ascii[y] && ascii[y][x]) ascii[y][x] = ch; }

    // 1) HÉROES + TELÉFONO en Sala de Control
    const ctrl = areas.control; const pC = centerOf(ctrl);
    placements.push({type:'player', x:pC.x, y:pC.y, id:'P1'});
    placements.push({type:'follower', sub:'nurse', x:pC.x-2, y:pC.y});
    placements.push({type:'follower', sub:'tcae',  x:pC.x+2, y:pC.y});
    const ctrlPhone = { x: Math.floor(ctrl.x+ctrl.w/2), y: ctrl.y+1 };
    placements.push({type:'phone', x: ctrlPhone.x, y: ctrlPhone.y});

    // 2) BOSS pegado a pared en Boss-Room (+ marcador ASCII)
    const bossR = areas.boss;
    const pB = nearPerimeter(bossR, 2);
    placements.push({type:'boss', x:pB.x, y:pB.y, nearWall:true});
    markAscii(pB.x, pB.y, charset.bossMarker||'X');

    // 3) TODAS LAS PUERTAS (cerradas) incl. Boss Door si hay 'u'
    for (let y=0; y<ascii.length; y++){
      for (let x=0; x<ascii[y].length; x++){
        const ch = ascii[y][x];
        if (ch===charset.door || ch==='d' || ch==='D'){ placements.push({type:'door', x,y, locked:true}); }
        if (ch===charset.bossDoor || ch==='u'){ placements.push({type:'boss_door', x,y, locked:true, isBoss:true}); }
      }
    }

    // 4) LUCES: 1 por sala + pasillos cada ~10 tiles (10% rotas)
    for (const r of rooms){
      const c = centerOf(r); const broken = rng()<0.10;
      const colors = ['#eef','#ffd','#def'];
      placements.push({type:'light', x:c.x, y:c.y, broken, color: pick(colors)});
      markAscii(c.x, c.y, broken ? (charset.lightBroken||'l') : (charset.light||'L'));
    }
    for (const seg of corridors){
      for (const p of sampleAlongCorridor(seg, 10)){
        const broken = rng()<0.10; const colors = ['#eef','#ffd','#def'];
        placements.push({type:'light', x:p.x, y:p.y, broken, color: pick(colors)});
        markAscii(p.x, p.y, broken ? (charset.lightBroken||'l') : (charset.light||'L'));
      }
    }

    // 5) 34 ASCENSORES (17 pares) – una sala se queda sin ascensor
    const roomsCopy = rooms.slice();
    while (roomsCopy.length > 34) roomsCopy.splice(Math.floor(rng()*roomsCopy.length),1);
    let pairId = 1;
    for (let i=0; i+1<roomsCopy.length; i+=2){
      const A = roomsCopy[i], B = roomsCopy[i+1];
      const a = centerOf(A), b = centerOf(B);
      placements.push({type:'elevator', x:a.x, y:a.y, pairId});
      placements.push({type:'elevator', x:b.x, y:b.y, pairId});
      markAscii(a.x, a.y, charset.elev || 'E');
      markAscii(b.x, b.y, charset.elev || 'E');
      pairId++;
    }

    // 6) POBLACIÓN por sala y por tramo de pasillo: [1..3] animales y [1..3] humanos
    function populateAreaRect(rect){
      const animals = rint(1,3), humans = rint(1,3);
      for (let i=0;i<animals;i++){
        const p = randomInside(rect, 2); const sub = (rng()<0.5) ? 'mosquito' : 'rat';
        placements.push({type:'enemy', sub, x:p.x, y:p.y});
        markAscii(p.x, p.y, sub==='mosquito' ? (charset.mosquito||'m') : (charset.rat||'r'));
      }
      const staff = ['nurse','tcae','celador','cleaner','guardia','medico'];
      for (let i=0;i<humans;i++){
        const p = randomInside(rect, 2); const sub = pick(staff);
        placements.push({type:'npc', sub, x:p.x, y:p.y});
        const ch = sub === 'nurse' ? (charset.nurse || 'n')
          : sub === 'tcae' ? (charset.tcae || 't')
          : sub === 'celador' ? (charset.celador || 'c')
          : sub === 'cleaner' ? (charset.cleaner || 'h')
          : sub === 'guardia' ? (charset.guardia || 'g')
          : (charset.medico || 'k');
        markAscii(p.x, p.y, ch);
      }
    }
    for (const r of rooms) populateAreaRect(r);
    for (const c of corridors) populateAreaRect(c);

    // ÚNICOS: 1 jefe_servicio y 1 supervisora (no Control/Boss)
    const candidateRooms = rooms.filter(r=> r!==ctrl && r!==bossR);
    if (candidateRooms.length){
      const rJ = pick(candidateRooms), pJ = randomInside(rJ,2);
      placements.push({type:'npc_unique', sub:'jefe_servicio', x:pJ.x, y:pJ.y});
      markAscii(pJ.x, pJ.y, charset.jefe_servicio||'J');
    }
    if (candidateRooms.length>1){
      const rV = pick(candidateRooms), pV = randomInside(rV,2);
      placements.push({type:'npc_unique', sub:'supervisora', x:pV.x, y:pV.y});
      markAscii(pV.x, pV.y, charset.supervisora||'H');
    }

    // 7) CARROS por sala: 3..6 (10% urgencias, 30% medicinas, 60% comida)
    function placeRoomCarts(room){
      const n = rint(3,6);
      for (let i=0;i<n;i++){
        const p = randomInside(room,2);
        const roll = rng(); const sub = roll<0.10 ? 'er' : (roll<0.40 ? 'med' : 'food');
        placements.push({type:'cart', sub, x:p.x, y:p.y});
        markAscii(p.x,p.y, sub==='er' ? (charset.cartUrg||'U') : (sub==='med' ? (charset.cartMed||'+') : (charset.cartFood||'F')));
      }
    }
    for (const r of rooms) placeRoomCarts(r);

    // 8) ÍTEMS por sala (1 power, 2 comidas, 3 monedas; + bolsa si cerca de Boss)
    function dist2(a,b){ const dx=a.x-b.x, dy=a.y-b.y; return dx*dx+dy*dy; }
    const bossC = centerOf(bossR), nearBossR2 = Math.pow(120,2);
    for (const r of rooms){
      let p = randomInside(r,2);
      placements.push({type:'item', sub:'power', x:p.x, y:p.y}); markAscii(p.x,p.y, charset.power||'1');
      for (let i=0;i<2;i++){ p = randomInside(r,2);
        placements.push({type:'item', sub:'food', x:p.x, y:p.y}); markAscii(p.x,p.y, charset.food||'y');
      }
      for (let i=0;i<3;i++){ p = randomInside(r,2);
        placements.push({type:'item', sub:'coin', x:p.x, y:p.y}); markAscii(p.x,p.y, charset.coin||'$');
      }
      const rc = centerOf(r);
      if (dist2(rc,bossC) <= nearBossR2){ p = randomInside(r,2);
        placements.push({type:'item', sub:'bag', x:p.x, y:p.y}); markAscii(p.x,p.y, charset.bag||'%');
      }
    }

    // 9) SPAWNERS extra por nivel
    const baseSpM = level===1 ? rint(2,4) : (level===2 ? rint(3,6) : rint(4,8));
    const baseSpR = level===1 ? rint(2,3) : (level===2 ? rint(3,4) : rint(4,6));
    const baseSpS = level===1 ? rint(2,3) : (level===2 ? rint(3,4) : rint(4,6));
    const baseSpC = level===1 ? rint(1,2) : (level===2 ? rint(2,3) : rint(3,4));
    function dropAnimalSpawners(count, prefer){
      for (let i=0;i<count;i++){
        const r = pick(rooms); const p = randomInside(r,2);
        placements.push({type:'spawn_animal', x:p.x, y:p.y, prefers: prefer});
        markAscii(p.x,p.y, charset.spAnimal||'A');
      }
    }
    function dropSpawner(kind, count, ch){
      for (let i=0;i<count;i++){
        const r = pick(rooms); const p = randomInside(r,2);
        placements.push({type: kind, x:p.x, y:p.y});
        markAscii(p.x,p.y, ch);
      }
    }
    dropAnimalSpawners(baseSpM, 'mosquito');
    dropAnimalSpawners(baseSpR, 'rat');
    dropSpawner('spawn_staff', baseSpS, charset.spStaff||'N');
    dropSpawner('spawn_cart',  baseSpC, charset.spCart||'C');

    // 10) 7 PACIENTES + PASTILLAS + TIMBRES enlazados (no en Control ni Boss)
    const usedRooms = rooms.filter(r=> r!==ctrl && r!==bossR);
    const kindsPills = ['pastilla_azul','pastilla_zenidina','pastilla_tillalout','pastilla_gaviscon','pastilla_luzon','pastilla_patoplast','pastilla_generic'];
    const takeN = Math.min(7, usedRooms.length);
    for (let i=0;i<takeN;i++){
      const rP = usedRooms[i]; const pPt = randomInside(rP,2);
      placements.push({type:'patient', x:pPt.x, y:pPt.y, id:`patient${i+1}`});
      const pBell = randomInside(rP,2);
      placements.push({type:'bell', x:pBell.x, y:pBell.y, link:`patient${i+1}`});
      const rPi = pick(usedRooms.filter(rr=> rr!==rP)); const pPi = randomInside(rPi,2);
      const sub = pick(kindsPills);
      placements.push({type:'pill', sub, x:pPi.x, y:pPi.y, link:`patient${i+1}`});
      markAscii(pPt.x,pPt.y, charset.patient||'p');
      markAscii(pBell.x,pBell.y, charset.bell||'b');
      markAscii(pPi.x,pPi.y, charset.pill||'i');
    }

    return placements;
  }

// ============================================================================
//  FIN DEL PLUGIN mapgen.plugin.js
//  NO añadir código después de esta línea ni modificar este cierre.
// ============================================================================
})(window);
