import './style.css';
import { rndInt, pickRandom, shuffle, generateMap, largestGroup } from './map.js';
import { aiChooseMove } from './ai.js';
import { Board3D } from './board3d/Board3D.js';
import { Board2D } from './board2d/Board2D.js';
import { Sound } from './audio.js';

// Seat order matters: smaller games only use the first colors, so the best-looking biomes come first.
// green (you) · yellow · blue · pink · orange · purple · lime · red
const PLAYER_COLORS = ['#3fb68b', '#f2c14e', '#4aa3df', '#e07fc4', '#f28f3b', '#a06cd5', '#9acd32', '#e5566f'];
const MAP_SIZES = { small: 24, medium: 32, large: 44 }; // approximate number of territories
const START_DICE_PER_TERRITORY = 3;
const MAX_DICE = 8;
const MAX_STOCK = 64;
const AI_SPEEDS = {
  slow: { think: 650, roll: 800, after: 450, reinforce: 800 },
  normal: { think: 320, roll: 480, after: 220, reinforce: 450 },
  fast: { think: 90, roll: 160, after: 70, reinforce: 150 },
  instant: { instant: true, think: 0, roll: 0, after: 0, reinforce: 0 }, // AI turns resolved without animation
};
const AI_NAMES = {
  female: ['Agnieszka', 'Basia', 'Zosia', 'Kasia', 'Magda', 'Ola', 'Ewa', 'Hania', 'Gosia', 'Iza',
    'Marta', 'Julka', 'Ula', 'Dorota', 'Beata', 'Monika', 'Natalia', 'Weronika', 'Jadzia', 'Grażyna'],
  male: ['Bartek', 'Tomek', 'Marek', 'Piotrek', 'Wojtek', 'Kuba', 'Staszek', 'Krzysiek', 'Jacek', 'Paweł',
    'Michał', 'Adam', 'Janusz', 'Zbyszek', 'Mietek', 'Grzesiek', 'Łukasz', 'Kamil', 'Maciek', 'Franek'],
};
const HUMAN_TIMING = { roll: 420, after: 120, reinforce: 700 };
const PREFS_KEY = 'dice-isles-prefs';
const PIPS = { 1: [4], 2: [2, 6], 3: [2, 4, 6], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8] };

const $ = id => document.getElementById(id);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const sum = arr => arr.reduce((a, b) => a + b, 0);
const rollDice = n => Array.from({ length: n }, () => 1 + rndInt(6));
const aiTiming = () => AI_SPEEDS[$('speed').value];

function plural(n, one, few, many) {
  if (n === 1) return one;
  const m10 = n % 10, m100 = n % 100;
  return m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many;
}

// Alternates female and male names so every game gets a mix, then shuffles the seating.
function pickAiNames(n) {
  const pools = [shuffle([...AI_NAMES.female]), shuffle([...AI_NAMES.male])];
  let side = rndInt(2);
  const names = [];
  while (names.length < n) {
    names.push(pools[side].pop());
    side = 1 - side;
  }
  return shuffle(names);
}

const state = {
  phase: 'setup', // setup | play | over
  map: null,
  players: [],
  order: [],
  turn: 0,
  selected: -1,
  hover: -1,
  busy: false,
  token: 0, // bumped on every new game, so stale async loops stop
  battle: null,
  flashes: new Map(),
  endTurn: null,
  watching: false,
  message: '',
  skipped: { attacks: 0, lost: 0 }, // AI moves resolved in "instant" mode since the human's last turn
};

// Screen area covered by the floating HUD panels, so the camera frames the board in the free space.
function getInsets() {
  const top = $('hud-top').getBoundingClientRect(), bottom = $('hud-bottom').getBoundingClientRect();
  return { top: top.bottom + 8, bottom: window.innerHeight - bottom.top + 8 };
}

const sound = new Sound();
loadPrefs();
let renderer = createRenderer($('quality').value);
if (import.meta.env.DEV) { // handy for debugging in the console
  Object.assign(window, { state, sound });
  Object.defineProperty(window, 'renderer', { get: () => renderer });
}

// 'high' / 'low' are 3D quality levels, '2d' is the flat board.
function createRenderer(quality) {
  const options = { getInsets, onDiceLanded: () => sound.land() };
  const board = quality === '2d' ? new Board2D($('board-wrap'), options) : new Board3D($('board-wrap'), options);
  board.setQuality(quality);
  board.setFieldStyle($('fieldstyle').value);
  sound.setOcean(quality !== '2d');
  $('resetview').hidden = $('fieldstyle-row').hidden = quality === '2d'; // 3D-only options
  return board;
}

function applyGraphics(quality) {
  const wants2d = quality === '2d';
  if (wants2d !== renderer instanceof Board2D) {
    renderer.dispose();
    renderer = createRenderer(quality);
    if (state.map) renderer.setMap(state.map, state.players.map(p => p.color));
  } else {
    renderer.setQuality(quality);
  }
  draw();
}

const currentPlayer = () => state.players[state.order[state.turn]];
const isHumanTurn = () => state.phase === 'play' && !state.busy && currentPlayer().human && !!state.endTurn;
const territoriesOf = pid => state.map.territories.filter(t => t.owner === pid);
const live = token => token === state.token && state.phase === 'play';

// ---------- setup ----------

// Shape of the free screen area, so the island is generated tall on portrait phones and wide on desktops.
// The tilted 3D camera squashes the board vertically, so it asks for a taller island.
function boardAspect() {
  const { top, bottom } = getInsets();
  const aspect = window.innerWidth / Math.max(100, window.innerHeight - top - bottom);
  return $('quality').value === '2d' ? aspect : aspect * 0.7;
}

function setupNewGame() {
  state.token++;
  hideOverlay();
  const count = +$('opponents').value + 1;
  const perPlayer = Math.max(3, Math.round(MAP_SIZES[$('mapsize').value] / count));
  const map = generateMap(perPlayer * count, boardAspect());

  const aiNames = pickAiNames(count - 1);
  state.players = Array.from({ length: count }, (_, i) => ({
    id: i,
    name: i === 0 ? 'Ty' : aiNames[i - 1],
    color: PLAYER_COLORS[i],
    human: i === 0,
    alive: true,
    stock: 0,
    aggression: 0.5 + Math.random() * 0.1,
  }));

  // Equal number of territories and equal number of dice for everyone.
  shuffle(map.territories.map(t => t.id)).forEach((tid, i) => {
    map.territories[tid].owner = i % count;
    map.territories[tid].dice = 1;
  });
  for (const p of state.players) {
    const own = map.territories.filter(t => t.owner === p.id);
    let extra = perPlayer * (START_DICE_PER_TERRITORY - 1);
    while (extra > 0) {
      const open = own.filter(t => t.dice < MAX_DICE);
      if (!open.length) break;
      pickRandom(open).dice++;
      extra--;
    }
  }

  Object.assign(state, {
    phase: 'setup', map, order: shuffle(state.players.map(p => p.id)), turn: 0,
    selected: -1, hover: -1, busy: false, battle: null, flashes: new Map(), endTurn: null, watching: false,
    skipped: { attacks: 0, lost: 0 },
    message: 'Podgląd planszy. Wylosuj ponownie, jeśli układ Ci nie pasuje.',
  });
  renderer.setMap(map, state.players.map(p => p.color));
  $('battle').innerHTML = '<span class="hint">Tu pojawią się wyniki rzutów</span>';
  updateUI();
  renderer.resetView(); // the HUD may have changed height
  draw();
}

function startGame() {
  state.phase = 'play';
  state.token++;
  updateUI();
  renderer.resetView(); // the setup controls are gone, so there is more room for the board
  gameLoop(state.token);
}

// ---------- turn flow ----------

async function gameLoop(token) {
  while (live(token)) {
    const p = currentPlayer();
    if (p.alive) {
      if (p.human) await humanTurn();
      else await aiTurn(p, token);
      if (!live(token)) return;
      await reinforce(p, token);
      if (!live(token)) return;
    }
    state.turn = (state.turn + 1) % state.order.length;
  }
}

function humanTurn() {
  state.message = 'Twoja tura — kliknij swoje pole (min. 2 kostki), a potem sąsiednie pole przeciwnika.';
  const { attacks, lost } = state.skipped;
  if (attacks) {
    $('battle').innerHTML = `<span class="hint">Pominięte ruchy przeciwników: ${attacks} ${plural(attacks, 'atak', 'ataki', 'ataków')}`
      + ` · Twoje utracone pola: ${lost}</span>`;
  }
  state.skipped = { attacks: 0, lost: 0 };
  sound.turn();
  return new Promise(resolve => {
    state.endTurn = resolve;
    updateUI();
    draw();
  });
}

function endHumanTurn() {
  if (!isHumanTurn()) return;
  const resolve = state.endTurn;
  state.endTurn = null;
  state.selected = -1;
  resolve();
}

async function aiTurn(p, token) {
  state.message = `Ruch: ${p.name}…`;
  if (aiTiming().instant) {
    await sleep(0); // yield once per turn so the page stays responsive
    let move;
    while (live(token) && (move = aiChooseMove(state.map, state.players, p))) {
      const def = state.players[move.to.owner];
      const won = resolveBattle(move.from, move.to, rollDice(move.from.dice), rollDice(move.to.dice));
      state.skipped.attacks++;
      if (won && def.human) state.skipped.lost++;
      checkGameOver();
    }
    updateUI();
    draw();
    return;
  }
  updateUI();
  await sleep(aiTiming().think);
  while (live(token)) {
    const move = aiChooseMove(state.map, state.players, p);
    if (!move) break;
    state.selected = move.from.id;
    draw();
    await sleep(aiTiming().think);
    if (!live(token)) return;
    await attack(move.from, move.to, token, aiTiming());
  }
  state.selected = -1;
}

async function attack(from, to, token, timing) {
  state.busy = true;
  state.selected = -1;
  const atk = state.players[from.owner], def = state.players[to.owner];
  const a = rollDice(from.dice), d = rollDice(to.dice);
  state.battle = { from: from.id, to: to.id };
  updateUI();
  draw();
  renderer.battleStart(from.id, to.id, atk.color, timing.roll / 1000);
  sound.roll(timing.roll / 1000, a.length + d.length);

  await showBattle(atk, def, a, d, timing.roll);
  if (token !== state.token) return;

  const won = resolveBattle(from, to, a, d);
  renderer.battleResult(from.id, to.id, won, (won ? atk : def).color);
  if (won) sound.win(); else sound.lose();
  updateUI();
  draw();

  await sleep(timing.after);
  if (token !== state.token) return;
  state.battle = null;
  state.busy = false;
  checkGameOver();
  updateUI();
  draw();
}

// Applies the dice result to the board; returns whether the attacker won.
function resolveBattle(from, to, a, d) {
  const def = state.players[to.owner];
  const won = sum(a) > sum(d);
  if (won) {
    to.owner = from.owner;
    to.dice = from.dice - 1;
  }
  from.dice = 1;
  if (won && !territoriesOf(def.id).length) def.alive = false;
  return won;
}

async function reinforce(p, token) {
  const income = largestGroup(state.map, p.id);
  let pool = income + p.stock;
  const own = territoriesOf(p.id);
  const added = new Map();
  while (pool > 0) {
    const open = own.filter(t => t.dice < MAX_DICE);
    if (!open.length) break;
    const t = pickRandom(open);
    t.dice++;
    added.set(t.id, (added.get(t.id) || 0) + 1);
    pool--;
  }
  p.stock = Math.min(pool, MAX_STOCK);
  if (!p.human && aiTiming().instant) return;
  state.flashes = added;
  sound.reinforce(income, p.human ? 1 : 0.5);
  state.message = p.human
    ? `Otrzymujesz ${income} ${plural(income, 'kostkę', 'kostki', 'kostek')}.`
    : `${p.name} otrzymuje ${income} ${plural(income, 'kostkę', 'kostki', 'kostek')}.`;
  updateUI();
  draw();
  await sleep(p.human ? HUMAN_TIMING.reinforce : aiTiming().reinforce);
  if (token !== state.token) return;
  state.flashes = new Map();
  draw();
}

function checkGameOver() {
  const alive = state.players.filter(p => p.alive);
  if (alive.length === 1) {
    state.phase = 'over';
    const winner = alive[0];
    if (winner.human) sound.victory(); else if (!state.watching) sound.defeat();
    state.message = winner.human ? 'Wygrana!' : `Wygrywa ${winner.name}.`;
    showOverlay(
      winner.human ? 'Zwycięstwo!' : 'Koniec gry',
      winner.human ? 'Cała plansza należy do Ciebie.' : `Całą planszę zdobywa ${winner.name}.`,
      [['Nowa gra', setupNewGame, true]],
    );
  } else if (!state.players[0].alive && !state.watching) {
    state.watching = true;
    sound.defeat();
    showOverlay('Koniec gry dla Ciebie', 'Nie masz już żadnych pól.', [
      ['Nowa gra', setupNewGame, true],
      ['Oglądaj dalej', hideOverlay, false],
    ]);
  }
}

// ---------- input ----------

function targetsOfSelected() {
  const targets = new Set();
  if (state.selected < 0) return targets;
  const T = state.map.territories;
  const from = T[state.selected];
  for (const n of from.adj) if (T[n].owner !== from.owner) targets.add(n);
  return targets;
}

function isClickable(tid) {
  if (!isHumanTurn() || tid < 0) return false;
  const t = state.map.territories[tid];
  return (t.owner === currentPlayer().id && t.dice > 1) || targetsOfSelected().has(tid);
}

function onBoardClick(tid) {
  if (!isHumanTurn()) return;
  const me = currentPlayer();
  const T = state.map.territories;
  if (tid >= 0 && T[tid].owner === me.id) {
    state.selected = T[tid].dice > 1 && state.selected !== tid ? tid : -1;
    if (state.selected >= 0) sound.select();
  } else if (tid >= 0 && targetsOfSelected().has(tid)) {
    attack(T[state.selected], T[tid], state.token, HUMAN_TIMING);
    return;
  } else {
    state.selected = -1;
  }
  updateUI();
  draw();
}

// Listeners live on the container, so they keep working when the renderer (and its canvas) is swapped.
const board = $('board-wrap');

function pointerPos(e) {
  const r = board.getBoundingClientRect();
  return [e.clientX - r.left, e.clientY - r.top];
}

board.addEventListener('pointermove', e => {
  const tid = renderer.hitTest(...pointerPos(e));
  const hover = isClickable(tid) ? tid : -1;
  board.style.cursor = hover >= 0 ? 'pointer' : 'default';
  if (hover !== state.hover) {
    state.hover = hover;
    draw();
  }
});
board.addEventListener('pointerleave', () => {
  state.hover = -1;
  draw();
});
// Dragging rotates the camera, so only a click without movement counts as a move.
let pointerDownAt = null;
board.addEventListener('pointerdown', e => { pointerDownAt = [e.clientX, e.clientY]; });
board.addEventListener('click', e => {
  if (pointerDownAt && Math.hypot(e.clientX - pointerDownAt[0], e.clientY - pointerDownAt[1]) > 6) return;
  onBoardClick(renderer.hitTest(...pointerPos(e)));
});
board.addEventListener('contextmenu', e => {
  e.preventDefault();
  onBoardClick(-1);
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !$('menu').hidden) return setMenuOpen(false);
  if (e.target.tagName === 'SELECT' || !$('overlay').hidden) return;
  if (e.key === 'Escape') onBoardClick(-1);
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    endHumanTurn();
  }
});

$('reroll').addEventListener('click', setupNewGame);
$('opponents').addEventListener('change', setupNewGame);
$('mapsize').addEventListener('change', setupNewGame);
$('start').addEventListener('click', startGame);
$('endturn').addEventListener('click', endHumanTurn);
// In-page dialog instead of confirm(), which some browsers/embeds block or auto-dismiss.
$('newgame').addEventListener('click', () => {
  setMenuOpen(false);
  if (state.phase !== 'play') return setupNewGame();
  showOverlay('Nowa gra?', 'Bieżąca rozgrywka zostanie przerwana.', [
    ['Tak, nowa gra', setupNewGame, true],
    ['Anuluj', hideOverlay, false],
  ]);
});

// Secondary settings live in a dropdown, so the bar stays small during play (and on phones).
function setMenuOpen(open) {
  $('menu').hidden = !open;
  $('menu-toggle').setAttribute('aria-expanded', String(open));
}
$('menu-toggle').addEventListener('click', () => setMenuOpen($('menu').hidden));
document.addEventListener('pointerdown', e => {
  if (!$('menu').hidden && !$('menu').contains(e.target) && e.target !== $('menu-toggle')) setMenuOpen(false);
});

$('resetview').addEventListener('click', () => {
  renderer.resetView();
  setMenuOpen(false);
});
$('quality').addEventListener('change', () => {
  applyGraphics($('quality').value);
  savePrefs();
});
$('speed').addEventListener('change', savePrefs);
$('fieldstyle').addEventListener('change', () => {
  renderer.setFieldStyle($('fieldstyle').value);
  savePrefs();
});

// Browsers start audio only after a user gesture.
for (const type of ['pointerdown', 'keydown']) document.addEventListener(type, () => sound.unlock(), true);
$('sound').addEventListener('change', () => {
  applySound();
  savePrefs();
});

// 'all' = effects and the sea ambience, 'fx' = effects only, 'off' = silence.
function applySound() {
  const mode = $('sound').value;
  sound.setEnabled(mode !== 'off');
  sound.setAmbience(mode === 'all');
}

function savePrefs() {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({
      speed: $('speed').value, quality: $('quality').value, sound: $('sound').value, fields: $('fieldstyle').value,
    }));
  } catch { /* storage unavailable — preferences just won't persist */ }
}

// Runs before the renderer exists: it only fills in the controls.
function loadPrefs() {
  // Phones and tablets start on the lighter 3D setting unless the player picked something else.
  if (window.matchMedia('(pointer: coarse)').matches) $('quality').value = 'low';
  try {
    // Falls back to the key used before the game was renamed.
    const prefs = JSON.parse(localStorage.getItem(PREFS_KEY) ?? localStorage.getItem('dice-wars-prefs')) || {};
    if (AI_SPEEDS[prefs.speed]) $('speed').value = prefs.speed;
    if (['high', 'low', '2d'].includes(prefs.quality)) $('quality').value = prefs.quality;
    if (['all', 'fx', 'off'].includes(prefs.sound)) $('sound').value = prefs.sound;
    if (['biomes', 'colors'].includes(prefs.fields)) $('fieldstyle').value = prefs.fields;
    else if (typeof prefs.sound === 'boolean') $('sound').value = prefs.sound ? 'all' : 'off'; // older saves
  } catch { /* ignore broken or missing preferences */ }
  applySound();
}

// ---------- easter egg ----------

// Three quick clicks on the title bring out the author's dog for a moment.
let titleClicks = [];
$('title').addEventListener('click', () => {
  const now = performance.now();
  titleClicks = [...titleClicks.filter(t => now - t < 800), now];
  if (titleClicks.length >= 3) {
    titleClicks = [];
    showDog();
  }
});

function showDog() {
  if ($('dog')) return;
  const dog = new Image();
  dog.id = 'dog';
  dog.alt = '';
  dog.src = './easter/dog.webp';
  dog.decode().then(() => {
    dog.addEventListener('animationend', e => { if (e.target === dog) dog.remove(); });
    document.body.append(dog);
    setTimeout(() => sound.bark(), 550);
    setTimeout(() => floatHearts(dog), 750);
  }).catch(() => {}); // image unavailable (e.g. offline before it was ever cached): just skip it
}

function floatHearts(dog) {
  const r = dog.getBoundingClientRect();
  for (let i = 0; i < 7; i++) {
    setTimeout(() => {
      const heart = document.createElement('span');
      heart.className = 'dog-heart';
      heart.textContent = '❤️';
      heart.style.left = `${r.left + r.width * (0.62 + Math.random() * 0.22)}px`;
      heart.style.top = `${r.top + r.height * 0.04}px`;
      heart.style.setProperty('--dx', `${(Math.random() - 0.5) * 90}px`);
      heart.style.setProperty('--rot', `${(Math.random() - 0.5) * 50}deg`);
      heart.addEventListener('animationend', () => heart.remove());
      document.body.append(heart);
    }, i * 230);
  }
}

// ---------- installable app ----------

// The service worker makes the game work offline. Skipped in dev (it would cache stale modules)
// and when the build is opened straight from disk, where service workers aren't available.
if (import.meta.env.PROD && 'serviceWorker' in navigator && location.protocol.startsWith('http')) {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
}

// Browsers that support installing (Chrome, Edge, Android) announce it; offer it in the menu.
let installPrompt = null;
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  installPrompt = e;
  $('install').hidden = false;
});
window.addEventListener('appinstalled', () => {
  installPrompt = null;
  $('install').hidden = true;
});
$('install').addEventListener('click', async () => {
  setMenuOpen(false);
  if (!installPrompt) return;
  installPrompt.prompt();
  await installPrompt.userChoice;
  installPrompt = null;
  $('install').hidden = true;
});

// Only the canvas size matters here; HUD panels changing height (e.g. a longer status line)
// must not resize the canvas or move the camera.
new ResizeObserver(() => renderer.resize()).observe($('board-wrap'));

// ---------- UI ----------

function draw() {
  const human = isHumanTurn();
  renderer.update({
    players: state.players,
    selected: state.selected,
    targets: human ? targetsOfSelected() : new Set(),
    hover: human ? state.hover : -1,
    battle: state.battle,
    flashes: state.flashes,
  });
}

function updateUI() {
  const setup = state.phase === 'setup';
  $('setup-controls').hidden = !setup;
  $('game-controls').hidden = setup;
  $('newgame').hidden = setup;
  document.body.classList.toggle('playing', !setup);
  $('endturn').disabled = !isHumanTurn();

  let message = state.message;
  if (isHumanTurn() && state.selected >= 0) message = 'Wybierz cel ataku (podświetlone pola) albo kliknij swoje pole ponownie, by anulować.';
  $('status').textContent = message;

  const T = state.map.territories;
  $('players').innerHTML = state.order.map((pid, i) => {
    const p = state.players[pid];
    const fields = T.filter(t => t.owner === pid).length;
    const dice = sum(T.filter(t => t.owner === pid).map(t => t.dice));
    const income = largestGroup(state.map, pid);
    const current = state.phase === 'play' && i === state.turn;
    return `
      <div class="player${current ? ' current' : ''}${p.alive ? '' : ' dead'}">
        <span class="order">${i + 1}</span>
        <span class="swatch" style="background:${p.color}"></span>
        <div>
          <div class="pname">${p.name}</div>
          <div class="pstats">
            ${fields} ${plural(fields, 'pole', 'pola', 'pól')} · ${dice} ${plural(dice, 'kostka', 'kostki', 'kostek')}
            · <span title="Kostki na koniec tury (największy spójny obszar)">+${income}</span>
            ${p.stock ? `· <span title="Zapas kostek, które się nie zmieściły">zapas ${p.stock}</span>` : ''}
          </div>
        </div>
      </div>`;
  }).join('');
}

function dieHtml(value, color, rolling) {
  const pips = Array.from({ length: 9 }, (_, i) => `<i${PIPS[value].includes(i) ? ' class="on"' : ''}></i>`).join('');
  return `<span class="die${rolling ? ' rolling' : ''}" style="--c:${color}">${pips}</span>`;
}

function battleHtml(atk, def, a, d, won) {
  const side = (p, dice, cls) => `
    <div class="side ${cls}">
      <span class="swatch" style="background:${p.color}"></span>
      <span class="bname">${p.name}</span>
      <span class="dice">${dice.map(v => dieHtml(v, p.color, won === null)).join('')}</span>
      <span class="sum">${won === null ? '…' : sum(dice)}</span>
    </div>`;
  const atkCls = won === null ? '' : won ? 'win' : 'lose';
  const defCls = won === null ? '' : won ? 'lose' : 'win';
  return `${side(atk, a, 'atk ' + atkCls)}<span class="vs">vs</span>${side(def, d, 'def ' + defCls)}`;
}

async function showBattle(atk, def, a, d, ms) {
  const el = $('battle');
  const start = performance.now();
  while (performance.now() - start < ms) {
    el.innerHTML = battleHtml(atk, def, rollDice(a.length), rollDice(d.length), null);
    await sleep(70);
  }
  el.innerHTML = battleHtml(atk, def, a, d, sum(a) > sum(d));
}

function showOverlay(title, text, buttons) {
  $('overlay-title').textContent = title;
  $('overlay-text').textContent = text;
  const box = $('overlay-buttons');
  box.innerHTML = '';
  for (const [label, onClick, primary] of buttons) {
    const b = document.createElement('button');
    b.textContent = label;
    if (primary) b.className = 'primary';
    b.addEventListener('click', onClick);
    box.appendChild(b);
  }
  $('overlay').hidden = false;
}

function hideOverlay() {
  $('overlay').hidden = true;
}

setupNewGame();
