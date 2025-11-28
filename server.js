// server.js - Servidor con palabras persistentes y dibujos guardados
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
  }
});

const PORT = process.env.PORT || 3000;

// Almacenamiento de salas
const rooms = new Map();

// Palabras en español por defecto
const palabrasDefault = [
  'gato', 'perro', 'casa', 'sol', 'luna', 'árbol', 'flor', 'corazón',
  'estrella', 'montaña', 'playa', 'avión', 'coche', 'bicicleta', 'libro',
  'teléfono', 'computadora', 'guitarra', 'piano', 'cámara', 'reloj',
  'zapato', 'sombrero', 'paraguas', 'llave', 'puerta', 'ventana',
  'mesa', 'silla', 'cama', 'taza', 'plato', 'tenedor', 'cuchillo',
  'manzana', 'banana', 'naranja', 'uva', 'fresa', 'sandía', 'piña'
];

class Room {
  constructor(roomId) {
    this.roomId = roomId;
    this.players = new Map();
    this.currentDrawer = null;
    this.currentWord = null;
    this.gameStarted = false;
    this.canvas = [];
    this.round = 0;
    this.maxRounds = 5;
    this.roundTime = 60;
    this.timeLeft = this.roundTime;
    this.timer = null;
    this.wordRevealed = false;
    this.customWords = [];
    this.hintGiven30 = false;
    this.hintGiven15 = false;
    this.revealedIndices = [];
    this.roundDrawings = []; // Almacenar dibujos de cada ronda
    this.allGameDrawings = []; // Todos los dibujos de la partida
  }

  addPlayer(socketId, playerName) {
    this.players.set(socketId, {
      id: socketId,
      name: playerName,
      score: 0,
      guessed: false
    });
  }

  removePlayer(socketId) {
    this.players.delete(socketId);
    if (this.currentDrawer === socketId) {
      this.nextRound();
    }
  }

  startGame() {
    if (this.players.size < 2) return false;
    this.gameStarted = true;
    this.round = 0;
    this.allGameDrawings = [];
    this.nextRound();
    return true;
  }

  nextRound() {
    // Guardar el dibujo de la ronda anterior si existe
    if (this.canvas.length > 0 && this.currentWord) {
      const roundDrawing = {
        roundNumber: this.round,
        word: this.currentWord,
        drawing: [...this.canvas],
        drawer: this.players.get(this.currentDrawer)?.name || 'Desconocido',
        wasGuessed: Array.from(this.players.values())
          .filter(p => p.id !== this.currentDrawer)
          .some(p => p.guessed)
      };
      this.allGameDrawings.push(roundDrawing);
    }

    this.round++;
    if (this.round > this.maxRounds) {
      this.endGame();
      return;
    }

    // Reset
    this.canvas = [];
    this.wordRevealed = false;
    this.hintGiven30 = false;
    this.hintGiven15 = false;
    this.revealedIndices = [];
    this.players.forEach(p => p.guessed = false);

    // Seleccionar dibujante
    const playerIds = Array.from(this.players.keys());
    const drawerIndex = (this.round - 1) % playerIds.length;
    this.currentDrawer = playerIds[drawerIndex];

    // Seleccionar palabra
    const availableWords = this.customWords.length > 0 
      ? this.customWords 
      : palabrasDefault;
    this.currentWord = availableWords[Math.floor(Math.random() * availableWords.length)];

    // Iniciar timer
    this.timeLeft = this.roundTime;
    this.startTimer();
    
    // Notificar nueva ronda
    io.to(this.roomId).emit('new-round', this.getState());
    io.to(this.currentDrawer).emit('your-word', { word: this.currentWord });
  }

  startTimer() {
    if (this.timer) clearInterval(this.timer);
    
    this.timer = setInterval(() => {
      this.timeLeft--;
      
      io.to(this.roomId).emit('timer-tick', { timeLeft: this.timeLeft });
      
      if (this.timeLeft === 30 && !this.hintGiven30) {
        this.giveHint();
        this.hintGiven30 = true;
      }
      
      if (this.timeLeft === 15 && !this.hintGiven15) {
        this.giveHint();
        this.hintGiven15 = true;
      }
      
      if (this.timeLeft <= 0) {
        this.revealWord();
        clearInterval(this.timer);
        setTimeout(() => this.nextRound(), 3000);
      }
    }, 1000);
  }

  giveHint() {
    if (!this.currentWord || this.revealedIndices.length >= this.currentWord.length) {
      return;
    }

    const availableIndices = [];
    for (let i = 0; i < this.currentWord.length; i++) {
      if (!this.revealedIndices.includes(i)) {
        availableIndices.push(i);
      }
    }

    if (availableIndices.length === 0) return;

    const randomIndex = availableIndices[Math.floor(Math.random() * availableIndices.length)];
    this.revealedIndices.push(randomIndex);

    // Emitir pista a todos los que NO son dibujantes
    this.players.forEach((player, socketId) => {
      if (socketId !== this.currentDrawer) {
        io.to(socketId).emit('letter-hint', {
          index: randomIndex,
          letter: this.currentWord[randomIndex]
        });
      }
    });
  }

  revealWord() {
    this.wordRevealed = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  checkGuess(socketId, guess) {
    const player = this.players.get(socketId);
    if (!player || player.guessed || socketId === this.currentDrawer) {
      return false;
    }

    const normalizedGuess = guess.toLowerCase().trim();
    const normalizedWord = this.currentWord.toLowerCase().trim();

    if (normalizedGuess === normalizedWord) {
      player.guessed = true;
      
      const basePoints = 100;
      const timeBonus = Math.floor((this.timeLeft / this.roundTime) * 50);
      player.score += basePoints + timeBonus;

      const drawer = this.players.get(this.currentDrawer);
      if (drawer) {
        drawer.score += 25;
      }

      const allGuessed = Array.from(this.players.values())
        .filter(p => p.id !== this.currentDrawer)
        .every(p => p.guessed);

      if (allGuessed) {
        this.revealWord();
        setTimeout(() => this.nextRound(), 3000);
      }

      return true;
    }

    return false;
  }

  endGame() {
    this.gameStarted = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    
    // Incluir dibujos en el estado final
    io.to(this.roomId).emit('game-ended', {
      ...this.getState(),
      drawings: this.allGameDrawings
    });
  }

  updateWords(newWords) {
    this.customWords = newWords;
    console.log(`Palabras actualizadas en sala ${this.roomId}:`, newWords);
  }

  getWords() {
    return this.customWords.length > 0 ? this.customWords : [];
  }

  resetForNewGame() {
    this.round = 0;
    this.gameStarted = false;
    this.currentDrawer = null;
    this.currentWord = null;
    this.canvas = [];
    this.wordRevealed = false;
    this.hintGiven30 = false;
    this.hintGiven15 = false;
    this.revealedIndices = [];
    this.allGameDrawings = [];
    
    this.players.forEach(player => {
      player.score = 0;
      player.guessed = false;
    });
  }

  getState() {
    return {
      players: Array.from(this.players.values()),
      currentDrawer: this.currentDrawer,
      gameStarted: this.gameStarted,
      round: this.round,
      maxRounds: this.maxRounds,
      timeLeft: this.timeLeft,
      canvas: this.canvas,
      wordLength: this.currentWord ? this.currentWord.length : 0,
      wordRevealed: this.wordRevealed,
      revealedWord: this.wordRevealed ? this.currentWord : null,
      customWords: this.customWords
    };
  }
}

// Socket.IO eventos
io.on('connection', (socket) => {
  console.log('Cliente conectado:', socket.id);

  socket.on('join-room', ({ roomId, playerName }) => {
    socket.join(roomId);

    if (!rooms.has(roomId)) {
      rooms.set(roomId, new Room(roomId));
    }

    const room = rooms.get(roomId);
    room.addPlayer(socket.id, playerName);

    socket.emit('joined-room', { roomId, playerId: socket.id });
    io.to(roomId).emit('room-state', room.getState());

    console.log(`${playerName} se unió a ${roomId}`);
  });

  socket.on('start-game', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (room && room.startGame()) {
      io.to(roomId).emit('game-started');
      io.to(roomId).emit('room-state', room.getState());
      
      io.to(room.currentDrawer).emit('your-word', { word: room.currentWord });
    }
  });

  socket.on('draw', ({ roomId, drawData }) => {
    const room = rooms.get(roomId);
    if (room && socket.id === room.currentDrawer) {
      room.canvas.push(drawData);
      socket.to(roomId).emit('draw-update', drawData);
    }
  });

  socket.on('clear-canvas', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (room && socket.id === room.currentDrawer) {
      room.canvas = [];
      io.to(roomId).emit('canvas-cleared');
    }
  });

  socket.on('guess', ({ roomId, guess }) => {
    const room = rooms.get(roomId);
    if (room && room.gameStarted) {
      const correct = room.checkGuess(socket.id, guess);
      
      if (correct) {
        const player = room.players.get(socket.id);
        io.to(roomId).emit('correct-guess', { 
          playerId: socket.id, 
          playerName: player.name,
          score: player.score
        });
        
        // Notificar al jugador que adivinó
        io.to(socket.id).emit('you-guessed-correctly', {
          message: '¡Adivinaste correctamente!',
          points: player.score
        });
        
        io.to(roomId).emit('room-state', room.getState());
      } else {
        io.to(roomId).emit('chat-message', {
          playerId: socket.id,
          playerName: room.players.get(socket.id).name,
          message: guess
        });
      }
    }
  });

  socket.on('update-words', ({ roomId, words }) => {
    const room = rooms.get(roomId);
    if (room) {
      room.updateWords(words);
      // Enviar las palabras actualizadas a TODOS en la sala
      io.to(roomId).emit('words-updated', { words: words });
      console.log(`Palabras actualizadas y enviadas a sala ${roomId}:`, words);
    }
  });

  socket.on('get-words', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (room) {
      socket.emit('words-list', { words: room.getWords() });
    }
  });

  socket.on('play-again', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (room) {
      room.resetForNewGame();
      io.to(roomId).emit('room-state', room.getState());
      console.log(`Sala ${roomId} reiniciada para nuevo juego`);
    }
  });

  socket.on('disconnect', () => {
    console.log('Cliente desconectado:', socket.id);

    rooms.forEach((room, roomId) => {
      if (room.players.has(socket.id)) {
        room.removePlayer(socket.id);
        
        if (room.players.size === 0) {
          rooms.delete(roomId);
        } else {
          io.to(roomId).emit('room-state', room.getState());
        }
      }
    });
  });
});

app.get('/', (req, res) => {
  res.send('Draw & Guess Server Running - v2.1');
});

app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    rooms: rooms.size,
    version: '2.1'
  });
});

server.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en puerto ${PORT}`);
  console.log(`📝 Funciones: Palabras persistentes, dibujos guardados, pistas`);
});
