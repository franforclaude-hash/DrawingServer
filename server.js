const express = require('express');
const http = require('http');
const socketIO = require('socket.io');

const app = express();
const server = http.createServer(app);

// Configurar Socket.IO con CORS
const io = socketIO(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
    credentials: true
  },
  pingTimeout: 60000,
  pingInterval: 25000,
});

// Almacenar información de juegos activos
const activeGames = new Map();

// Estadísticas
let totalConnections = 0;
let activeConnections = 0;

// Ruta de health check
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    activeConnections,
    totalConnections,
    activeGames: activeGames.size,
    uptime: process.uptime(),
  });
});

io.on('connection', (socket) => {
  totalConnections++;
  activeConnections++;
  
  console.log(`✅ Usuario conectado: ${socket.id} (Total: ${activeConnections})`);

  // Unirse a una sala de juego
  socket.on('join-game', (gameId) => {
    socket.join(gameId);
    console.log(`🎮 ${socket.id} se unió al juego: ${gameId}`);

    // Inicializar el juego si no existe
    if (!activeGames.has(gameId)) {
      activeGames.set(gameId, {
        players: new Set(),
        pointsCount: 0,
        createdAt: Date.now(),
      });
    }

    const game = activeGames.get(gameId);
    game.players.add(socket.id);

    // Notificar a todos en la sala
    io.to(gameId).emit('player-joined', {
      socketId: socket.id,
      playersCount: game.players.size,
    });
  });

  // Recibir punto de dibujo
  socket.on('draw-point', (data) => {
    const { gameId, point } = data;
    
    if (activeGames.has(gameId)) {
      activeGames.get(gameId).pointsCount++;
    }

    // ⚡ CLAVE: Broadcast inmediato a todos excepto el emisor
    socket.to(gameId).emit('draw-point', point);
  });

  // Recibir batch de puntos (para optimizar aún más)
  socket.on('draw-batch', (data) => {
    const { gameId, points } = data;
    
    if (activeGames.has(gameId)) {
      activeGames.get(gameId).pointsCount += points.length;
    }

    // Broadcast del batch completo
    socket.to(gameId).emit('draw-batch', points);
  });

  // Limpiar canvas
  socket.on('clear-canvas', (gameId) => {
    console.log(`🧹 Limpiando canvas en juego: ${gameId}`);
    
    if (activeGames.has(gameId)) {
      activeGames.get(gameId).pointsCount = 0;
    }

    socket.to(gameId).emit('clear-canvas');
  });

  // Deshacer último trazo
  socket.on('undo-stroke', (gameId) => {
    socket.to(gameId).emit('undo-stroke');
  });

  // Cambiar color
  socket.on('change-color', (data) => {
    const { gameId, color } = data;
    socket.to(gameId).emit('drawer-changed-color', color);
  });

  // Cambiar grosor
  socket.on('change-stroke-width', (data) => {
    const { gameId, width } = data;
    socket.to(gameId).emit('drawer-changed-width', width);
  });

  // Salir de un juego
  socket.on('leave-game', (gameId) => {
    socket.leave(gameId);
    
    if (activeGames.has(gameId)) {
      const game = activeGames.get(gameId);
      game.players.delete(socket.id);
      
      // Si no quedan jugadores, eliminar el juego
      if (game.players.size === 0) {
        activeGames.delete(gameId);
        console.log(`🗑️  Juego ${gameId} eliminado (sin jugadores)`);
      } else {
        io.to(gameId).emit('player-left', {
          socketId: socket.id,
          playersCount: game.players.size,
        });
      }
    }
  });

  // Desconexión
  socket.on('disconnect', () => {
    activeConnections--;
    console.log(`❌ Usuario desconectado: ${socket.id} (Activos: ${activeConnections})`);

    // Limpiar de todos los juegos
    activeGames.forEach((game, gameId) => {
      if (game.players.has(socket.id)) {
        game.players.delete(socket.id);
        
        if (game.players.size === 0) {
          activeGames.delete(gameId);
        } else {
          io.to(gameId).emit('player-left', {
            socketId: socket.id,
            playersCount: game.players.size,
          });
        }
      }
    });
  });

  // Ping/Pong para mantener conexión
  socket.on('ping', () => {
    socket.emit('pong');
  });
});

// Limpiar juegos viejos cada 5 minutos
setInterval(() => {
  const now = Date.now();
  const maxAge = 30 * 60 * 1000; // 30 minutos

  activeGames.forEach((game, gameId) => {
    if (now - game.createdAt > maxAge && game.players.size === 0) {
      activeGames.delete(gameId);
      console.log(`🧹 Juego antiguo eliminado: ${gameId}`);
    }
  });
}, 5 * 60 * 1000);

// Puerto del servidor
const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`
🚀 Servidor Socket.IO corriendo en puerto ${PORT}
📊 Dashboard: http://localhost:${PORT}
🎮 Listo para recibir conexiones
  `);
});

// Manejo de errores
process.on('uncaughtException', (error) => {
  console.error('❌ Error no capturado:', error);
});

process.on('unhandledRejection', (error) => {
  console.error('❌ Promesa rechazada:', error);
});