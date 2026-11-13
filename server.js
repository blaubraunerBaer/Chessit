const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');
const { Chess } = require('chess.js');

const PORT = process.env.PORT || 3000;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MAX_MESSAGES = 100;
const PROMOTIONS = ['q', 'r', 'b', 'n'];

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const io = new Server(server);

// code -> { code, chess, seats: { w, b }, messages }
// seat -> { name, token, socketId, connected } or null
const rooms = new Map();

function makeCode() {
  let code;
  do {
    code = Array.from({ length: 5 }, () => CODE_CHARS[crypto.randomInt(CODE_CHARS.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function cleanName(name) {
  return String(name || '').trim().slice(0, 20) || 'Player';
}

function cleanCode(code) {
  return String(code || '').trim().toUpperCase();
}

function reply(ack, payload) {
  if (typeof ack === 'function') ack(payload);
}

function hasConnectedPlayer(room) {
  return Object.values(room.seats).some((s) => s && s.connected);
}

function publicState(room) {
  const { chess, seats } = room;
  const ready = !!(seats.w && seats.b);
  const allConnected = ready && seats.w.connected && seats.b.connected;
  const over = chess.isGameOver();
  const active = allConnected && !over;

  const legal = {};
  if (active) {
    for (const m of chess.moves({ verbose: true })) {
      (legal[m.from] ||= []).push(m.to);
    }
  }

  const verbose = chess.history({ verbose: true });
  const last = verbose[verbose.length - 1];

  const seatInfo = (s) => (s ? { name: s.name, connected: s.connected } : null);

  return {
    code: room.code,
    fen: chess.fen(),
    turn: chess.turn(),
    active,
    status: statusText(room),
    history: chess.history(),
    lastMove: last ? { from: last.from, to: last.to } : null,
    legal,
    players: { w: seatInfo(seats.w), b: seatInfo(seats.b) },
  };
}

function statusText(room) {
  const { chess, seats } = room;
  if (!seats.w || !seats.b) return 'Waiting for an opponent to join...';

  const side = chess.turn() === 'w' ? 'White' : 'Black';
  const other = side === 'White' ? 'Black' : 'White';
  if (chess.isCheckmate()) return `Checkmate! ${other} wins.`;
  if (chess.isStalemate()) return 'Draw by stalemate.';
  if (chess.isDraw()) return 'Draw.';

  const gone = Object.values(seats).find((s) => !s.connected);
  if (gone) return `${gone.name} is disconnected. Waiting for them to come back...`;

  return `${side} to move${chess.inCheck() ? ' (check)' : ''}`;
}

function sessionPayload(room, color, token) {
  return {
    ok: true,
    code: room.code,
    color,
    token,
    state: publicState(room),
    messages: room.messages,
  };
}

function broadcastState(room) {
  io.to(room.code).emit('state', publicState(room));
}

function pushMessage(room, msg) {
  room.messages.push(msg);
  if (room.messages.length > MAX_MESSAGES) room.messages.shift();
}

function systemMessage(room, text) {
  const msg = { system: true, text, time: Date.now() };
  pushMessage(room, msg);
  io.to(room.code).emit('chat', msg);
}

// Returns { room, color, seat } if this socket currently holds a seat, otherwise null.
function getMySeat(socket) {
  const room = rooms.get(socket.data.code);
  const color = socket.data.color;
  const seat = room && color ? room.seats[color] : null;
  if (!seat || seat.socketId !== socket.id) return null;
  return { room, color, seat };
}

function takeSeat(room, color, socket, name, token) {
  room.seats[color] = { name, token, socketId: socket.id, connected: true };
  socket.join(room.code);
  socket.data = { code: room.code, color };
}

io.on('connection', (socket) => {
  socket.data = {};

  socket.on('create-room', (data, ack) => {
    const name = cleanName(data && data.name);
    const code = makeCode();
    const room = { code, chess: new Chess(), seats: { w: null, b: null }, messages: [] };
    rooms.set(code, room);

    const token = crypto.randomUUID();
    takeSeat(room, 'w', socket, name, token);
    systemMessage(room, `${name} created the room. Share code ${code} with your opponent.`);
    broadcastState(room);
    reply(ack, sessionPayload(room, 'w', token));
  });

  socket.on('join-room', (data, ack) => {
    const room = rooms.get(cleanCode(data && data.code));
    if (!room) return reply(ack, { ok: false, error: 'No room with that code.' });

    const color = !room.seats.w ? 'w' : !room.seats.b ? 'b' : null;
    if (!color) return reply(ack, { ok: false, error: 'That room is full.' });

    const name = cleanName(data && data.name);
    const token = crypto.randomUUID();
    takeSeat(room, color, socket, name, token);
    systemMessage(room, `${name} joined as ${color === 'w' ? 'White' : 'Black'}.`);
    broadcastState(room);
    reply(ack, sessionPayload(room, color, token));
  });

  // Used after a page refresh or a dropped connection to take back the same seat.
  socket.on('rejoin', (data, ack) => {
    const room = rooms.get(cleanCode(data && data.code));
    const token = data && data.token;
    const color = room && ['w', 'b'].find((c) => room.seats[c] && room.seats[c].token === token);
    if (!color) {
      return reply(ack, { ok: false, error: 'Your seat in that room is no longer available.' });
    }

    const seat = room.seats[color];
    seat.socketId = socket.id;
    seat.connected = true;
    socket.join(room.code);
    socket.data = { code: room.code, color };
    systemMessage(room, `${seat.name} reconnected.`);
    broadcastState(room);
    reply(ack, sessionPayload(room, color, token));
  });

  socket.on('move', (data, ack) => {
    const me = getMySeat(socket);
    if (!me) return reply(ack, { ok: false, error: 'You are not in a room.' });
    const { room, color } = me;
    const { chess, seats } = room;

    if (!seats.w || !seats.b) return reply(ack, { ok: false, error: 'Waiting for an opponent.' });
    if (!seats.w.connected || !seats.b.connected) {
      return reply(ack, { ok: false, error: 'Your opponent is disconnected.' });
    }
    if (chess.isGameOver()) return reply(ack, { ok: false, error: 'The game is over.' });
    if (chess.turn() !== color) return reply(ack, { ok: false, error: "It's not your turn." });

    const promotion = data && PROMOTIONS.includes(data.promotion) ? data.promotion : 'q';
    let move = null;
    try {
      move = chess.move({ from: String(data.from), to: String(data.to), promotion });
    } catch (err) {
      move = null;
    }
    if (!move) return reply(ack, { ok: false, error: 'Illegal move.' });

    broadcastState(room);
    reply(ack, { ok: true });
  });

  socket.on('chat', (data) => {
    const me = getMySeat(socket);
    const text = String((data && data.text) || '').trim().slice(0, 300);
    if (!me || !text) return;

    const msg = { name: me.seat.name, color: me.color, text, time: Date.now() };
    pushMessage(me.room, msg);
    io.to(me.room.code).emit('chat', msg);
  });

  socket.on('leave', (data, ack) => {
    const me = getMySeat(socket);
    if (me) {
      const { room, color, seat } = me;
      room.seats[color] = null;
      socket.leave(room.code);
      systemMessage(room, `${seat.name} left the room.`);
      if (!hasConnectedPlayer(room)) rooms.delete(room.code);
      else broadcastState(room);
    }
    socket.data = {};
    reply(ack, { ok: true });
  });

  socket.on('disconnect', () => {
    const me = getMySeat(socket);
    if (!me) return;
    const { room, seat } = me;
    seat.connected = false;
    systemMessage(room, `${seat.name} disconnected.`);
    if (!hasConnectedPlayer(room)) rooms.delete(room.code);
    else broadcastState(room);
  });
});

server.listen(PORT, () => {
  console.log(`Chessit running at http://localhost:${PORT}`);
});
