const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname)));

const MAX_PLAYERS = 8;
const MIN_TO_VOTE = 6;

const MAN_PHOTOS = [
  'MAN 1.jpg','MAN 2.jpg','MAN 3.jpg','MAN 4.jpg',
  'MAN 5.jpg','MAN 6.jpg','MAN 7.jpg','MAN 8.jpg'
];

let lobby = [];
let queue = [];
let chatMessages = [];
let gameActive = false;
let playerRoles = {}; // { "PLAYERNAME": "MAFIA", ... }
let doctorCooldown = {}; // { "PLAYERNAME": timestamp }
let policeCooldown = {}; // { "PLAYERNAME": timestamp }
let voteCounts = {}; // { "PLAYERNAME": count }
let playerVotes = {}; // { "VOTERNAME": "TARGETNAME" } — one vote per player
let eliminatedPlayers = new Set(); // persists during game

function getAvailablePhoto() {
  const used = [...lobby, ...queue].map(p => p.photo).filter(Boolean);
  const available = MAN_PHOTOS.filter(p => !used.includes(p));
  return available.length > 0 ? available[0] : MAN_PHOTOS[0];
}

io.on('connection', (socket) => {

  // Fresh registration from index.html
  socket.on('register', ({ name }) => {
    const nameLower = name.toLowerCase();
    const exists = lobby.find(p => p.name.toLowerCase() === nameLower)
                || queue.find(p => p.name.toLowerCase() === nameLower);
    if (exists) {
      socket.emit('register_error', 'Username already taken.');
      return;
    }

    const assignedPhoto = nameLower === 'lou' ? 'WOMAN.jpg' : getAvailablePhoto();
    const player = { id: socket.id, name: name.toUpperCase(), photo: assignedPhoto };

    if (lobby.length < MAX_PLAYERS) {
      lobby.push(player);
      socket.emit('registered', { status: 'lobby', player });
    } else {
      queue.push(player);
      socket.emit('registered', { status: 'queue', position: queue.length, player });
    }

    broadcastState();
  });

  // Rejoin from main.html after page navigation — update socket ID
  socket.on('rejoin', ({ name }) => {
    const nameLower = name.toLowerCase();
    const inLobby = lobby.find(p => p.name.toLowerCase() === nameLower);
    const inQueue = queue.find(p => p.name.toLowerCase() === nameLower);

    if (inLobby) {
      inLobby.id = socket.id;
      socket.emit('rejoined', { status: 'lobby' });
    } else if (inQueue) {
      inQueue.id = socket.id;
      socket.emit('rejoined', { status: 'queue', position: queue.indexOf(inQueue) + 1 });
    } else {
      // Not found — treat as new register
      const assignedPhoto = nameLower === 'lou' ? 'WOMAN.jpg' : getAvailablePhoto();
      const player = { id: socket.id, name: name.toUpperCase(), photo: assignedPhoto };
      if (lobby.length < MAX_PLAYERS) {
        lobby.push(player);
        socket.emit('rejoined', { status: 'lobby' });
      } else {
        queue.push(player);
        socket.emit('rejoined', { status: 'queue', position: queue.length });
      }
    }

    broadcastState();
  });

  // Set timer — lou only, broadcast to all clients
  socket.on('set_timer', (seconds) => {
    io.emit('timer_set', seconds);
  });

  // Set phase
  socket.on('set_phase', (phase) => {
    io.emit('phase_set', phase);
  });

  // Set round
  socket.on('set_round', (round) => {
    io.emit('round_set', round);
  });

  // Set roles — lou only, store and send individual roles to players
  socket.on('set_roles', (roles) => {
    playerRoles = roles;
    // Send each player their own role privately
    lobby.forEach(p => {
      const role = playerRoles[p.name];
      if (role) {
        io.to(p.id).emit('your_role', { name: p.name, role });
      }
    });
  });

  // Get my role — player requests their role
  socket.on('get_my_role', () => {
    const player = lobby.find(p => p.id === socket.id) || queue.find(p => p.id === socket.id);
    if (player && playerRoles[player.name]) {
      socket.emit('your_role', { name: player.name, role: playerRoles[player.name] });
    } else {
      socket.emit('your_role', { name: player?.name || 'UNKNOWN', role: null });
    }
  });

  // Doctor heal ability
  const COOLDOWN_TIME = 3600; // 1 hour in seconds

  socket.on('get_heal_status', () => {
    const player = lobby.find(p => p.id === socket.id);
    if (!player) return;
    
    const lastHeal = doctorCooldown[player.name];
    if (lastHeal) {
      const elapsed = (Date.now() - lastHeal) / 1000;
      if (elapsed < COOLDOWN_TIME) {
        socket.emit('heal_status', { 
          onCooldown: true, 
          remainingTime: Math.ceil(COOLDOWN_TIME - elapsed) 
        });
        return;
      }
    }
    socket.emit('heal_status', { onCooldown: false, remainingTime: 0 });
  });

  socket.on('heal_player', ({ targetId }) => {
    const healer = lobby.find(p => p.id === socket.id);
    const target = lobby.find(p => p.id === targetId);
    
    if (!healer || !target) return;
    if (playerRoles[healer.name] !== 'DOCTOR') return;
    
    // Check cooldown
    const lastHeal = doctorCooldown[healer.name];
    if (lastHeal) {
      const elapsed = (Date.now() - lastHeal) / 1000;
      if (elapsed < COOLDOWN_TIME) {
        socket.emit('heal_status', { 
          onCooldown: true, 
          remainingTime: Math.ceil(COOLDOWN_TIME - elapsed) 
        });
        return;
      }
    }
    
    // Set cooldown
    doctorCooldown[healer.name] = Date.now();
    
    // Notify healer
    socket.emit('heal_success', { target: target.name });
    
    // Broadcast heal (could be used by game logic)
    io.emit('player_healed', { healer: healer.name, target: target.name });
  });

  // Police investigate ability
  socket.on('get_investigate_status', () => {
    const player = lobby.find(p => p.id === socket.id);
    if (!player) return;
    const last = policeCooldown[player.name];
    if (last) {
      const elapsed = (Date.now() - last) / 1000;
      if (elapsed < COOLDOWN_TIME) {
        socket.emit('investigate_status', { onCooldown: true, remainingTime: Math.ceil(COOLDOWN_TIME - elapsed) });
        return;
      }
    }
    socket.emit('investigate_status', { onCooldown: false, remainingTime: 0 });
  });

  socket.on('investigate_player', ({ targetId }) => {
    const investigator = lobby.find(p => p.id === socket.id);
    const target = lobby.find(p => p.id === targetId);
    if (!investigator || !target) return;
    if (playerRoles[investigator.name] !== 'POLICE') return;

    const last = policeCooldown[investigator.name];
    if (last) {
      const elapsed = (Date.now() - last) / 1000;
      if (elapsed < COOLDOWN_TIME) {
        socket.emit('investigate_status', { onCooldown: true, remainingTime: Math.ceil(COOLDOWN_TIME - elapsed) });
        return;
      }
    }

    policeCooldown[investigator.name] = Date.now();
    const role = playerRoles[target.name] || 'UNKNOWN';
    socket.emit('investigate_result', { name: target.name, role });
  });
  // Mafia eliminate ability
  socket.on('eliminate_player', ({ targetId }) => {
    const attacker = lobby.find(p => p.id === socket.id);
    const target = lobby.find(p => p.id === targetId);
    if (!attacker || !target) return;
    if (playerRoles[attacker.name] !== 'MAFIA') return;

    socket.emit('eliminate_success', { target: target.name });
    io.emit('player_targeted', { mafia: attacker.name, target: target.name });
  });

  // Voting
  socket.on('cast_vote', ({ targetName }) => {
    const voter = lobby.find(p => p.id === socket.id);
    if (!voter) return;

    const voterName = voter.name;
    const prevTarget = playerVotes[voterName];

    // Remove previous vote if exists
    if (prevTarget && voteCounts[prevTarget] > 0) {
      voteCounts[prevTarget]--;
    }

    // Cast new vote
    playerVotes[voterName] = targetName;
    voteCounts[targetName] = (voteCounts[targetName] || 0) + 1;

    io.emit('vote_counts', voteCounts);
  });

  socket.on('get_vote_counts', () => {
    socket.emit('vote_counts', voteCounts);
  });

  // Elimination management (Lou only)
  socket.on('set_eliminated', ({ name, eliminated }) => {
    if (eliminated) {
      eliminatedPlayers.add(name);
    } else {
      eliminatedPlayers.delete(name);
    }
    io.emit('elimination_update', Array.from(eliminatedPlayers));
  });

  socket.on('get_eliminated', () => {
    socket.emit('elimination_update', Array.from(eliminatedPlayers));
  });

  // Announcement — broadcast to all players
  socket.on('send_announcement', ({ title, message }) => {
    io.emit('announcement', { title, message });
  });
  socket.on('chat_message', ({ name, photo, text }) => {
    const now = new Date();
    const time = now.getHours().toString().padStart(2,'0') + ':' + now.getMinutes().toString().padStart(2,'0');
    const msg = { name: name.toUpperCase(), photo, text, time };
    chatMessages.push(msg);
    io.emit('chat_message', msg);
  });

  // Get chat history
  socket.on('get_chat_history', () => {
    socket.emit('chat_history', chatMessages);
  });

  // Start new game
  socket.on('start_game', () => {
    gameActive = true;
    chatMessages = [];
    voteCounts = {};
    playerVotes = {};
    eliminatedPlayers = new Set();
    io.emit('game_started');
    io.emit('chat_history', chatMessages);
    io.emit('vote_counts', voteCounts);
    io.emit('elimination_update', []);
  });

  // Declare winner — clear chat
  socket.on('declare_winner', (winnerName) => {
    gameActive = false;
    chatMessages = [];
    io.emit('winner_declared', winnerName);
    io.emit('chat_cleared');
  });

  // Check game status
  socket.on('get_game_status', () => {
    socket.emit('game_status', { active: gameActive, messageCount: chatMessages.length });
  });

  socket.on('get_state', () => {
    socket.emit('state', buildState());
  });

  socket.on('disconnect', () => {
    const lobbyIdx = lobby.findIndex(p => p.id === socket.id);
    if (lobbyIdx !== -1) {
      lobby.splice(lobbyIdx, 1);
      if (queue.length > 0) {
        const next = queue.shift();
        lobby.push(next);
        io.to(next.id).emit('promoted');
      }
    } else {
      const queueIdx = queue.findIndex(p => p.id === socket.id);
      if (queueIdx !== -1) queue.splice(queueIdx, 1);
    }
    broadcastState();
  });
});

function buildState() {
  return {
    lobby,
    queue: queue.map((p, i) => ({ ...p, position: i + 1 })),
    votingEnabled: lobby.length >= MIN_TO_VOTE
  };
}

function broadcastState() {
  io.emit('state', buildState());
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Tycoon Mafia server running at http://localhost:${PORT}`);
});
