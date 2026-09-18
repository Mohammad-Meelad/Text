const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

// Allow cross-origin requests for WebSockets from any frontend domain
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

app.get('/', (req, res) => {
  res.send('Socket.IO Chat Backend is Running');
});

io.on('connection', (socket) => {
  console.log('A user connected:', socket.id);

  // Listen for incoming chat messages from any client
  socket.on('chat message', (msg) => {
    // Broadcast the received message to all connected clients
    io.emit('chat message', msg);
  });

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
