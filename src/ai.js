import { largestGroup } from './map.js';

// WIN_PROB[a][d] = chance that `a` attacking dice beat `d` defending dice (defender wins ties).
export const WIN_PROB = (() => {
  const dist = [[1]]; // dist[n][s] = P(sum of n dice == s)
  for (let n = 1; n <= 8; n++) {
    const prev = dist[n - 1];
    const cur = new Array(prev.length + 6).fill(0);
    prev.forEach((p, s) => {
      if (p) for (let f = 1; f <= 6; f++) cur[s + f] += p / 6;
    });
    dist.push(cur);
  }
  const cdf = dist.map(d => { let acc = 0; return d.map(p => (acc += p)); });
  const table = [];
  for (let a = 0; a <= 8; a++) {
    table.push([]);
    for (let d = 0; d <= 8; d++) {
      let p = 0;
      if (a && d) {
        dist[a].forEach((pa, s) => {
          if (pa) p += pa * (s - 1 < cdf[d].length ? cdf[d][s - 1] : 1);
        });
      }
      table[a].push(p);
    }
  }
  return table;
})();

// Picks the best attack for an AI player, or null when it prefers to end its turn.
export function aiChooseMove(map, players, me) {
  const T = map.territories;
  const diceBy = new Array(players.length).fill(0);
  let total = 0;
  for (const t of T) { diceBy[t.owner] += t.dice; total += t.dice; }

  // A runaway leader gets ganged up on.
  let leader = -1;
  for (const p of players) {
    if (!p.alive || p.id === me.id || diceBy[p.id] <= total * 0.4) continue;
    if (leader < 0 || diceBy[p.id] > diceBy[leader]) leader = p.id;
  }

  const baseGroup = largestGroup(map, me.id);
  let best = null;
  for (const from of T) {
    if (from.owner !== me.id || from.dice < 2) continue;
    for (const nid of from.adj) {
      const to = T[nid];
      if (to.owner === me.id) continue;
      const p = WIN_PROB[from.dice][to.dice];
      if (p < 0.3) continue;

      let score = p;
      if (from.dice === 8) score += 0.08; // a full stack can't grow anyway
      if (leader >= 0) score += to.owner === leader ? 0.12 : -0.08;

      const prevOwner = to.owner;
      to.owner = me.id;
      const gain = largestGroup(map, me.id) - baseGroup;
      to.owner = prevOwner;
      score += Math.min(gain, 5) * 0.04;

      // After a win the conquered field holds from.dice - 1 dice; count stronger enemies around it.
      let threats = 0;
      for (const m of to.adj) {
        const n = T[m];
        if (n.owner !== me.id && n.dice > from.dice - 1) threats++;
      }
      score -= threats * 0.025;

      if (!best || score > best.score) best = { from, to, score };
    }
  }
  // Waiting only pays off while reinforcements still fit on the board. Once dice overflow into
  // the stock (or we clearly dominate), passivity leads to a stalemate — take riskier fights.
  let threshold = me.aggression;
  if (me.stock > 0) threshold -= 0.2;
  if (diceBy[me.id] > total * 0.5) threshold -= 0.1;
  return best && best.score >= threshold ? best : null;
}
