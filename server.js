const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = socketIO(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  pingTimeout: 60000,
  pingInterval: 25000
});

const PORT = process.env.PORT || 3000;

// Pool de palabras en español
const WORD_POOL = [
  'gato', 'perro', 'casa', 'árbol', 'sol', 'luna', 'estrella', 'flor',
  'corazón', 'amor', 'beso', 'abrazo', 'sonrisa', 'lágrima', 'mano',
  'ojo', 'boca', 'nariz', 'oreja', 'cabeza', 'teléfono', 'computadora',
  'carro', 'bicicleta', 'avión', 'barco', 'tren', 'libro', 'lápiz',
  'taza', 'plato', 'cuchara', 'tenedor', 'cuchillo', 'silla', 'mesa',
  'puerta', 'ventana', 'cama', 'almohada', 'zapato', 'camisa', 'pantalón',
  'sombrero', 'gafas', 'reloj', 'anillo', 'collar', 'pelota', 'juguete',
  'guitarra', 'piano', 'tambor', 'micrófono', 'cámara', 'televisor',
  'montaña', 'río', 'playa', 'nube', 'rayo', 'lluvia', 'nieve', 'arcoíris',
  'mariposa', 'pájaro', 'pez', 'elefante', 'león', 'jirafa', 'pingüino',
  'ballena', 'tiburón', 'delfín', 'tortuga', 'serpiente', 'araña',
  'pizza', 'hamburguesa', 'helado', 'pastel', 'galleta', 'chocolate',
  'manzana', 'banana', 'uva', 'fresa', 'sandía', 'piña', 'naranja',
  'café', 'té', 'agua', 'jugo', 'leche', 'pan', 'queso', 'huevo'
];

const ROUND_TIME = 90; // 90 segundos por ronda
const POINTS_FOR_GUESS = 100;

// Estructura de datos
const rooms = new Map();

class Room {
  constructor(roomId, creatorId, creatorName) {
    this.roomId = roomId;
    this.players = new Map();
    this.currentDrawer = null;
    this.currentWord = null;
    this.roundStartTime = null;
    this.roundActive = false;
    this.drawingData = [];
    this.guessedPlayers = new Set();
    this.roundNumber = 0;
    
    // Agregar creador
    this.addPlayer(creatorId, creatorName);
  }

  addPlayer(playerId, playerName) {
    this.players.set(playerId, {
      id: playerId,
      name: playerName,
      score: 0,
      isReady: false
    });
  }

  removePlayer(playerId) {
    this.players.delete(playerId);
  }

  getNextDrawer() {
    const playerIds = Array.from(this.players.keys());
    if (playerIds.length === 0) return null;
    
    if (!this.currentDrawer) {
      return playerIds[0];
    }
    
    const currentIndex = playerIds.indexOf(this.currentDrawer);
    const nextIndex = (currentIndex + 1) % playerIds.length;
    return playerIds[nextIndex];
  }

  selectRandomWord() {
    return WORD_POOL[Math.floor(Math.random() * WORD_POOL.length)];
  }

  startNewRound() {
    this.currentDrawer = this.getNextDrawer();
    this.currentWord = this.selectRandomWord();
    this.roundStartTime = Date.now();
    this.roundActive = true;
    this.drawingData = [];
    this.guessedPlayers.clear();
    this.roundNumber++;
  }

  endRound() {
    this.roundActive = false;
    this.currentWord = null;
    this.currentDrawer = null;
    this.drawingData = [];
    this.guessedPlayers.clear();
  }

  checkGuess(playerId, guess) {
    if (!this.currentWord || !this.roundActive) return false;
    if (playerId === this.currentDrawer) return false;
    if (this.guessedPlayers.has(playerId)) return false;
    
    const normalizedGuess = guess.toLowerCase().trim();
    const normalizedWord = this.currentWord.toLowerCase().trim();
    
    if (normalizedGuess === normalizedWord) {
      this.guessedPlayers.add(playerId);
      
      // Otorgar puntos
      const player = this.players.get(playerId);
      if (player) {
        const timeElapsed = (Date.now() - this.roundStartTime) / 1000;
        const timeBonus = Math.max(0, Math.floor((ROUND_TIME - timeElapsed) / 10) * 10);
        const points = POINTS_FOR_GUESS + timeBonus;
        player.score += points;
        
        return { correct: true, points, playerName: player.name };
      }
    }
    
    return { correct: false };
  }

  getRoomState() {
    return {
      roomId: this.roomId,
      players: Array.from(this.players.values()),
      currentDrawer: this.currentDrawer,
      currentWord: this.currentDrawer ? this.getHiddenWord() : null,
      roundActive: this.roundActive,
      roundNumber: this.roundNumber,
      roundStartTime: this.roundStartTime,
      playerCount: this.players.size
    };
  }

  getHiddenWord() {
    if (!this.currentWord) return null;
    return this.currentWord.replace(/[a-záéíóúñ]/gi, '_');
  }

  toJSON() {
    return this.getRoomState();
  }
}

// Rutas básicas
app.get('/', (req, res) => {
  res.json({ 
    status: 'Draw & Guess Server Online',
    rooms: rooms.size,
    timestamp: new Date().toISOString()
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Socket.IO eventos
io.on('connection', (socket) => {
  console.log('🔌 Cliente conectado:', socket.id);

  // Crear o unirse a sala
  socket.on('join_room', ({ roomId, playerId, playerName }) => {
    console.log(`🎮 ${playerName} (${playerId}) intentando unirse a sala: ${roomId}`);
    
    // ⚠️ CRÍTICO: Asignar ANTES de hacer cualquier cosa
    socket.roomId = roomId;
    socket.playerId = playerId;
    socket.playerName = playerName;
    
    let room = rooms.get(roomId);
    
    if (!room) {
      // Crear nueva sala
      room = new Room(roomId, playerId, playerName);
      rooms.set(roomId, room);
      console.log(`✨ Nueva sala creada: ${roomId}`);
    } else if (room.players.size >= 2 && !room.players.has(playerId)) {
      // Sala llena (pero permitir reconexión)
      console.log(`⛔ Sala llena: ${roomId}`);
      socket.emit('room_full');
      return;
    } else if (!room.players.has(playerId)) {
      // Unirse a sala existente
      room.addPlayer(playerId, playerName);
      console.log(`➕ ${playerName} se unió a sala: ${roomId}`);
    } else {
      // Reconexión de jugador existente
      console.log(`🔄 ${playerName} se reconectó a sala: ${roomId}`);
    }
    
    // Unirse a la sala de Socket.IO
    socket.join(roomId);
    
    // ⚠️ IMPORTANTE: Enviar estado de la sala inmediatamente
    const roomState = room.getRoomState();
    console.log(`📤 Enviando room_state a sala ${roomId}:`, roomState);
    io.to(roomId).emit('room_state', roomState);
    
    // Si hay 2 jugadores, notificar que pueden empezar
    if (room.players.size === 2) {
      console.log(`✅ Sala ${roomId} lista para empezar (2 jugadores)`);
      io.to(roomId).emit('ready_to_start');
    }
  });

  // Iniciar juego
  socket.on('start_game', () => {
    console.log(`🎮 start_game recibido de ${socket.playerId} en sala ${socket.roomId}`);
    
    const room = rooms.get(socket.roomId);
    if (!room) {
      console.log(`⚠️ Sala no encontrada: ${socket.roomId}`);
      return;
    }
    
    if (room.players.size < 2) {
      console.log(`⚠️ No hay suficientes jugadores (${room.players.size}/2)`);
      socket.emit('error', { message: 'Se necesitan 2 jugadores para comenzar' });
      return;
    }

    if (room.roundActive) {
      console.log(`⚠️ Ya hay una ronda activa en sala ${socket.roomId}`);
      return;
    }
    
    room.startNewRound();
    console.log(`🎨 Nueva ronda iniciada en ${socket.roomId}`);
    console.log(`   Dibujante: ${room.currentDrawer}`);
    console.log(`   Palabra: ${room.currentWord}`);
    
    // Enviar palabra al dibujante
    const drawerSocket = Array.from(io.sockets.sockets.values())
      .find(s => s.playerId === room.currentDrawer && s.roomId === socket.roomId);
    
    if (drawerSocket) {
      drawerSocket.emit('your_turn', { word: room.currentWord });
      console.log(`📨 Palabra "${room.currentWord}" enviada a ${room.currentDrawer}`);
    } else {
      console.log(`⚠️ No se encontró socket del dibujante ${room.currentDrawer}`);
    }
    
    // Notificar a todos sobre la ronda
    const roundData = {
      drawer: room.currentDrawer,
      drawerName: room.players.get(room.currentDrawer)?.name || 'Jugador',
      hiddenWord: room.getHiddenWord(),
      roundNumber: room.roundNumber,
      timeLimit: ROUND_TIME
    };
    
    console.log(`📤 Enviando round_started a sala ${socket.roomId}:`, roundData);
    io.to(socket.roomId).emit('round_started', roundData);
    
    // Timer automático
    setTimeout(() => {
      const currentRoom = rooms.get(socket.roomId);
      if (currentRoom && currentRoom.roundActive) {
        console.log(`⏰ Tiempo agotado en sala ${socket.roomId}`);
        currentRoom.endRound();
        io.to(socket.roomId).emit('round_ended', {
          word: currentRoom.currentWord || 'N/A',
          scores: Array.from(currentRoom.players.values())
        });
      }
    }, ROUND_TIME * 1000);
  });

  // Datos de dibujo (optimizado)
  socket.on('draw', (data) => {
    const room = rooms.get(socket.roomId);
    if (!room || socket.playerId !== room.currentDrawer) return;
    
    // Broadcast a todos excepto al emisor
    socket.to(socket.roomId).emit('draw', data);
  });

  // Limpiar canvas
  socket.on('clear_canvas', () => {
    const room = rooms.get(socket.roomId);
    if (!room || socket.playerId !== room.currentDrawer) return;
    
    room.drawingData = [];
    console.log(`🧹 Canvas limpiado en sala ${socket.roomId}`);
    io.to(socket.roomId).emit('clear_canvas');
  });

  // Chat y adivinanzas
  socket.on('send_message', ({ message }) => {
    const room = rooms.get(socket.roomId);
    if (!room) return;
    
    const player = room.players.get(socket.playerId);
    if (!player) return;
    
    console.log(`💬 Mensaje de ${player.name}: ${message}`);
    
    // Verificar si es una adivinanza
    const guessResult = room.checkGuess(socket.playerId, message);
    
    if (guessResult.correct) {
      // Adivinanza correcta
      console.log(`✅ ${player.name} adivinó correctamente!`);
      io.to(socket.roomId).emit('correct_guess', {
        playerId: socket.playerId,
        playerName: player.name,
        points: guessResult.points
      });
      
      io.to(socket.roomId).emit('room_state', room.getRoomState());
      
      // Si todos adivinaron, terminar ronda
      const nonDrawers = room.players.size - 1;
      if (room.guessedPlayers.size >= nonDrawers && nonDrawers > 0) {
        console.log(`🏁 Todos adivinaron en sala ${socket.roomId}`);
        room.endRound();
        io.to(socket.roomId).emit('round_ended', {
          word: room.currentWord,
          scores: Array.from(room.players.values()),
          reason: 'all_guessed'
        });
      }
    } else {
      // Mensaje normal de chat
      io.to(socket.roomId).emit('chat_message', {
        playerId: socket.playerId,
        playerName: player.name,
        message: message,
        timestamp: Date.now()
      });
    }
  });

  // Siguiente ronda
  socket.on('next_round', () => {
    console.log(`➡️ next_round recibido de ${socket.playerId}`);
    
    const room = rooms.get(socket.roomId);
    if (!room) return;
    
    room.startNewRound();
    console.log(`🎨 Nueva ronda en ${socket.roomId}, dibujante: ${room.currentDrawer}, palabra: ${room.currentWord}`);
    
    // Enviar palabra al nuevo dibujante
    const drawerSocket = Array.from(io.sockets.sockets.values())
      .find(s => s.playerId === room.currentDrawer && s.roomId === socket.roomId);
    
    if (drawerSocket) {
      drawerSocket.emit('your_turn', { word: room.currentWord });
    }
    
    // Notificar a todos
    io.to(socket.roomId).emit('round_started', {
      drawer: room.currentDrawer,
      drawerName: room.players.get(room.currentDrawer)?.name,
      hiddenWord: room.getHiddenWord(),
      roundNumber: room.roundNumber,
      timeLimit: ROUND_TIME
    });
    
    // Timer automático
    setTimeout(() => {
      const currentRoom = rooms.get(socket.roomId);
      if (currentRoom && currentRoom.roundActive) {
        console.log(`⏰ Tiempo agotado en sala ${socket.roomId}`);
        currentRoom.endRound();
        io.to(socket.roomId).emit('round_ended', {
          word: currentRoom.currentWord || 'N/A',
          scores: Array.from(currentRoom.players.values())
        });
      }
    }, ROUND_TIME * 1000);
  });

  // Salir de sala
  socket.on('leave_room', () => {
    console.log(`👋 leave_room recibido de ${socket.playerId}`);
    handleDisconnect(socket);
  });

  // Desconexión
  socket.on('disconnect', () => {
    console.log('⚠️ Cliente desconectado:', socket.id);
    handleDisconnect(socket);
  });
});

function handleDisconnect(socket) {
  if (!socket.roomId) return;
  
  const room = rooms.get(socket.roomId);
  if (!room) return;
  
  console.log(`👋 ${socket.playerName} salió de sala ${socket.roomId}`);
  room.removePlayer(socket.playerId);
  
  // Si la sala está vacía, eliminarla
  if (room.players.size === 0) {
    rooms.delete(socket.roomId);
    console.log(`🗑️ Sala eliminada: ${socket.roomId}`);
    return;
  }
  
  // Si queda solo 1 jugador y hay ronda activa, terminarla
  if (room.players.size === 1 && room.roundActive) {
    console.log(`⚠️ Solo queda 1 jugador, terminando ronda en ${socket.roomId}`);
    room.endRound();
    io.to(socket.roomId).emit('round_ended', {
      word: room.currentWord || 'N/A',
      scores: Array.from(room.players.values()),
      reason: 'player_left'
    });
  }
  
  // Notificar a los demás
  io.to(socket.roomId).emit('player_left', {
    playerId: socket.playerId,
    remainingPlayers: room.players.size
  });
  
  io.to(socket.roomId).emit('room_state', room.getRoomState());
}

// Limpieza periódica de salas vacías
setInterval(() => {
  for (const [roomId, room] of rooms.entries()) {
    if (room.players.size === 0) {
      rooms.delete(roomId);
      console.log(`🧹 Sala limpiada: ${roomId}`);
    }
  }
}, 300000); // Cada 5 minutos

server.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en puerto ${PORT}`);
  console.log(`📝 URL: http://localhost:${PORT}`);
});
