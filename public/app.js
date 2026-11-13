const $ = (id) => document.getElementById(id);

const PIECE_GLYPHS = { k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟' };
const FILES = 'abcdefgh';
const NAME_KEY = 'chessit-name';
const SESSION_KEY = 'chessit-session';

const socket = io();

let session = loadSession(); // { code, color, token }
let state = null;            // latest state from the server
let selected = null;         // selected square, e.g. "e2"

// If the page was opened with a different room link, forget the old seat.
const urlRoom = new URLSearchParams(location.search).get('room');
if (session && urlRoom && urlRoom.toUpperCase() !== session.code) {
  session = null;
  clearSession();
}

function loadSession() {
  try {
    return JSON.parse(sessionStorage.getItem(SESSION_KEY));
  } catch (err) {
    return null;
  }
}

function saveSession() {
  try {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
  } catch (err) { /* storage unavailable, rejoin on refresh will not work */ }
}

function clearSession() {
  try {
    sessionStorage.removeItem(SESSION_KEY);
  } catch (err) { /* ignore */ }
}

function parseFen(fen) {
  const pieces = {};
  fen.split(' ')[0].split('/').forEach((row, i) => {
    let file = 0;
    const rank = 8 - i;
    for (const ch of row) {
      if (/\d/.test(ch)) {
        file += Number(ch);
      } else {
        pieces[FILES[file] + rank] = ch;
        file++;
      }
    }
  });
  return pieces;
}

function flash(text) {
  $('gameError').textContent = text;
  clearTimeout(flash.timer);
  flash.timer = setTimeout(() => ($('gameError').textContent = ''), 3000);
}

// ---------- Lobby ----------

function lobbyError(text) {
  $('lobbyError').textContent = text || '';
}

function enterGame(res) {
  session = { code: res.code, color: res.color, token: res.token };
  saveSession();

  $('lobby').hidden = true;
  $('game').hidden = false;
  $('roomInfo').textContent = `Room ${res.code}`;
  history.replaceState(null, '', `?room=${res.code}`);

  $('messages').textContent = '';
  res.messages.forEach(addChat);
  lobbyError('');
  applyState(res.state);
}

function showLobby(error) {
  session = null;
  clearSession();
  state = null;
  selected = null;
  $('game').hidden = true;
  $('lobby').hidden = false;
  $('roomInfo').textContent = '';
  history.replaceState(null, '', location.pathname);
  lobbyError(error);
}

$('name').value = localStorage.getItem(NAME_KEY) || '';
if (urlRoom) $('code').value = urlRoom.toUpperCase();

function currentName() {
  const name = $('name').value.trim();
  try { localStorage.setItem(NAME_KEY, name); } catch (err) { /* ignore */ }
  return name;
}

$('createBtn').addEventListener('click', () => {
  lobbyError('');
  socket.emit('create-room', { name: currentName() }, (res) => {
    if (res.ok) enterGame(res);
    else lobbyError(res.error);
  });
});

$('joinBtn').addEventListener('click', () => {
  lobbyError('');
  const code = $('code').value.trim().toUpperCase();
  if (!code) return lobbyError('Enter a room code.');
  socket.emit('join-room', { code, name: currentName() }, (res) => {
    if (res.ok) enterGame(res);
    else lobbyError(res.error);
  });
});

$('code').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('joinBtn').click();
});

// ---------- Game actions ----------

$('leaveBtn').addEventListener('click', () => {
  socket.emit('leave', {}, () => showLobby(''));
});

$('inviteBtn').addEventListener('click', async () => {
  const url = `${location.origin}/?room=${session.code}`;
  try {
    await navigator.clipboard.writeText(url);
    flash('Invite link copied.');
  } catch (err) {
    window.prompt('Copy this invite link:', url);
  }
});

$('chatForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = $('chatInput').value.trim();
  if (!text) return;
  socket.emit('chat', { text });
  $('chatInput').value = '';
});

function onSquareClick(sq) {
  if (!state || !state.active || state.turn !== session.color) return;

  const targets = selected ? state.legal[selected] || [] : [];

  if (selected && targets.includes(sq)) {
    const from = selected;
    selected = null;
    renderBoard();
    socket.emit('move', { from, to: sq }, (res) => {
      if (!res.ok) flash(res.error);
    });
    return;
  }

  if (sq === selected) {
    selected = null;
  } else if (state.legal[sq]) {
    selected = sq;
  } else {
    selected = null;
  }
  renderBoard();
}

// ---------- Rendering ----------

function applyState(st) {
  state = st;
  if (selected && !state.legal[selected]) selected = null;
  $('status').textContent = st.status;
  renderPlayers();
  renderBoard();
  renderHistory();
}

function renderPlayers() {
  const el = $('playerList');
  el.textContent = '';

  const you = session.color;
  for (const [color, label] of [['w', 'White'], ['b', 'Black']]) {
    const p = state.players[color];
    let text;
    if (!p) text = 'Waiting...';
    else text = p.name + (p.connected ? '' : ' (disconnected)');

    const line = document.createElement('div');
    line.className = 'player';
    line.textContent = `${label}: ${text}${color === you ? ' (you)' : ''}`;
    el.appendChild(line);
  }
}

function renderBoard() {
  const board = $('board');
  board.textContent = '';
  if (!state) return;

  const pieces = parseFen(state.fen);
  const flip = session.color === 'b';
  const targets = selected ? state.legal[selected] || [] : [];
  const last = state.lastMove;

  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const file = flip ? 7 - col : col;
      const rank = flip ? row + 1 : 8 - row;
      const sq = FILES[file] + rank;
      const piece = pieces[sq];

      const el = document.createElement('div');
      el.className = 'square ' + ((file + rank) % 2 === 1 ? 'dark' : 'light');
      if (last && (sq === last.from || sq === last.to)) el.classList.add('last');
      if (sq === selected) el.classList.add('selected');
      if (targets.includes(sq)) el.classList.add(piece ? 'capture' : 'target');

      if (piece) {
        const span = document.createElement('span');
        const isWhite = piece === piece.toUpperCase();
        span.className = 'piece ' + (isWhite ? 'white' : 'black');
        span.textContent = PIECE_GLYPHS[piece.toLowerCase()] + '︎';
        el.appendChild(span);
      }

      if (col === 0) el.appendChild(coordLabel(String(rank), 'rank'));
      if (row === 7) el.appendChild(coordLabel(FILES[file], 'file'));

      el.addEventListener('click', () => onSquareClick(sq));
      board.appendChild(el);
    }
  }
}

function coordLabel(text, kind) {
  const span = document.createElement('span');
  span.className = 'coord ' + kind;
  span.textContent = text;
  return span;
}

function renderHistory() {
  const el = $('history');
  el.textContent = '';

  const moves = state.history;
  if (!moves.length) {
    el.textContent = 'No moves yet.';
    return;
  }

  const table = document.createElement('table');
  for (let i = 0; i < moves.length; i += 2) {
    const tr = document.createElement('tr');
    [String(i / 2 + 1) + '.', moves[i], moves[i + 1] || ''].forEach((text) => {
      const td = document.createElement('td');
      td.textContent = text;
      tr.appendChild(td);
    });
    table.appendChild(tr);
  }
  el.appendChild(table);
  el.scrollTop = el.scrollHeight;
}

function addChat(msg) {
  const box = $('messages');
  const div = document.createElement('div');

  if (msg.system) {
    div.className = 'msg system';
    div.textContent = msg.text;
  } else {
    div.className = 'msg';
    const name = document.createElement('b');
    name.textContent = msg.name + ': ';
    const text = document.createElement('span');
    text.textContent = msg.text;
    div.append(name, text);
  }

  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}

// ---------- Socket events ----------

socket.on('connect', () => {
  // On first load, page refresh or reconnect, take back our seat if we had one.
  if (!session) return;
  socket.emit('rejoin', { code: session.code, token: session.token }, (res) => {
    if (res.ok) enterGame(res);
    else showLobby(res.error);
  });
});

socket.on('disconnect', () => {
  if (session && state) flash('Connection lost. Reconnecting...');
});

socket.on('state', (st) => {
  if (session && st.code === session.code) applyState(st);
});

socket.on('chat', (msg) => {
  if (session) addChat(msg);
});
