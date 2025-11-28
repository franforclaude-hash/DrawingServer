// server.js - Servidor para Render.com
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

// Palabras en español para el juego
const palabras = [
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
    this.maxRounds = 3;
    this.roundTime = 60;
    this.timeLeft = this.roundTime;
    this.timer = null;
    this.wordRevealed = false;
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
    this.nextRound();
    return true;
  }

  nextRound() {
    this.round++;
    if (this.round > this.maxRounds) {
      this.endGame();
      io.to(this.roomId).emit('game-ended', this.getState());
      return;
    }

    // Reset
    this.canvas = [];
    this.wordRevealed = false;
    this.players.forEach(p => p.guessed = false);

    // Seleccionar dibujante
    const playerIds = Array.from(this.players.keys());
    const drawerIndex = (this.round - 1) % playerIds.length;
    this.currentDrawer = playerIds[drawerIndex];

    // Seleccionar palabra
    this.currentWord = palabras[Math.floor(Math.random() * palabras.length)];

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
      
      // Emitir actualización de timer a todos en la sala
      io.to(this.roomId).emit('timer-tick', { timeLeft: this.timeLeft });
      
      if (this.timeLeft <= 0) {
        this.revealWord();
        clearInterval(this.timer);
        setTimeout(() => this.nextRound(), 3000);
      }
    }, 1000);
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
      
      // Calcular puntos basados en tiempo restante
      const basePoints = 100;
      const timeBonus = Math.floor((this.timeLeft / this.roundTime) * 50);
      player.score += basePoints + timeBonus;

      // Dar puntos al dibujante
      const drawer = this.players.get(this.currentDrawer);
      if (drawer) {
        drawer.score += 25;
      }

      // Si todos adivinaron, siguiente ronda
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
      revealedWord: this.wordRevealed ? this.currentWord : null
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
      
      // Enviar palabra al dibujante
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

  // Timer se maneja automáticamente en el servidor, no desde cliente

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

// Health check endpoint
app.get('/', (req, res) => {
  res.send('Draw & Guess Server Running');
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', rooms: rooms.size });
});

server.listen(PORT, () => {
  console.log(`Servidor corriendo en puerto ${PORT}`);
});
