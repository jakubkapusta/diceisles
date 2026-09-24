// Headless games used to judge a starting position before the player sees it.
// Every seat, including the player's, is played by the regular AI, so the result says how good the
// position is, not how good the player is.
import { rndInt, shuffle, generateMap, largestGroup } from './map.js';
import { aiChooseMove } from './ai.js';

export const MAX_DICE = 8;
export const MAX_STOCK = 64;
const START_DICE_PER_TERRITORY = 3;
const MAX_ROUNDS = 400; // a game still going after this many rounds counts as nobody's win

const rollSum = n => {
  let s = 0;
  for (let i = 0; i < n; i++) s += 1 + rndInt(6);
  return s;
};

// Hands out reinforcements at random to fields with room left; returns what didn't fit.
export function addDice(own, pool, onAdd) {
  const open = own.filter(t => t.dice < MAX_DICE);
  while (pool > 0 && open.length) {
    const k = rndInt(open.length);
    const t = open[k];
    t.dice++;
    onAdd?.(t);
    pool--;
    if (t.dice >= MAX_DICE) open[k] = open[open.length - 1], open.pop();
  }
  return pool;
}

// Plays one game from the given position to the end; returns the winner's id (-1 = no winner in time).
export function playOut(map, players, order) {
  const T = map.territories.map(t => ({ id: t.id, adj: t.adj, owner: t.owner, dice: t.dice }));
  const board = { territories: T };
  const ps = players.map(p => ({ id: p.id, alive: true, stock: 0, aggression: p.aggression }));
  const fields = new Array(ps.length).fill(0);
  for (const t of T) fields[t.owner]++;
  let alive = ps.length;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    for (const pid of order) {
      const p = ps[pid];
      if (!p.alive) continue;
      let move;
      while ((move = aiChooseMove(board, ps, p))) {
        const { from, to } = move;
        if (rollSum(from.dice) > rollSum(to.dice)) {
          const def = to.owner;
          fields[def]--;
          fields[pid]++;
          to.owner = pid;
          to.dice = from.dice - 1;
          if (!fields[def]) {
            ps[def].alive = false;
            if (--alive === 1) { from.dice = 1; return pid; }
          }
        }
        from.dice = 1;
      }
      const pool = largestGroup(board, pid) + p.stock;
      p.stock = Math.min(addDice(T.filter(t => t.owner === pid), pool), MAX_STOCK);
    }
  }
  return -1;
}

// A fresh random start: map, equal fields and dice for everyone, AI temperaments and turn order.
export function createPosition(count, perPlayer, aspect) {
  const map = generateMap(perPlayer * count, aspect);
  shuffle(map.territories.map(t => t.id)).forEach((tid, i) => {
    map.territories[tid].owner = i % count;
    map.territories[tid].dice = 1;
  });
  for (let pid = 0; pid < count; pid++) {
    addDice(map.territories.filter(t => t.owner === pid), perPlayer * (START_DICE_PER_TERRITORY - 1));
  }
  const players = Array.from({ length: count }, (_, id) => ({ id, aggression: 0.5 + Math.random() * 0.1 }));
  return { map, players, order: shuffle(players.map(p => p.id)) };
}

const FULL_TEST = 120; // games per accepted position
const BATCH = 20;

// Deals random starts until the player's seat (0) wins at least its fair share of simulated games,
// e.g. 1 in 4 with three opponents. When time runs out, returns the best start seen so far.
export function findPosition(count, perPlayer, aspect, budgetMs = 1500) {
  const target = 1 / count;
  const deadline = performance.now() + budgetMs;
  let best = null;
  do {
    const pos = createPosition(count, perPlayer, aspect);
    let wins = 0, games = 0;
    while (games < FULL_TEST && !(best && performance.now() > deadline)) {
      for (let g = 0; g < BATCH; g++) if (playOut(pos.map, pos.players, pos.order) === 0) wins++;
      games += BATCH;
      if (games >= 2 * BATCH && wins / games < target * 0.6) break; // clearly a bad start, don't waste time
    }
    pos.winRate = wins / games;
    pos.tested = games;
    const rank = p => (p.tested === FULL_TEST ? 1 : 0) + p.winRate;
    if (!best || rank(pos) > rank(best)) best = pos;
    if (games === FULL_TEST && pos.winRate >= target) return pos;
  } while (performance.now() < deadline);
  return best;
}
