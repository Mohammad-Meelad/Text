const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Store room passwords in memory: { roomName: password }
const roomPasswords = {};

app.get('/', (req, res) => {
  res.send('Socket.IO WhatsApp-Style Backend is Running');
});

io.on('connection', (socket) => {
  console.log('A user connected:', socket.id);

  // Handle joining/creating a room
  socket.on('join room', ({ username, room, password }, callback) => {
    // If room exists and has a password, verify it
    if (roomPasswords[room]) {
      if (roomPasswords[room] !== password) {
        return callback({ success: false, message: 'Incorrect password for this room.' });
      }
    } else if (password) {
      // If room does not exist, set the password for this new room
      roomPasswords[room] = password;
    }

    // Leave any previous rooms except socket's own room
    Array.from(socket.rooms).forEach((r) => {
      if (r !== socket.id) socket.leave(r);
    });

    socket.join(room);
    socket.data.username = username;
    socket.data.room = room;

    callback({ success: true });

    // System notification when a user joins
    io.to(room).emit('chat message', {
      username: 'System',
      text: `${username} joined the group.`,
      system: true
    });
  });

  // Handle incoming chat messages
  socket.on('chat message', (msgText) => {
    const room = socket.data.room;
    const username = socket.data.username;

    if (!room || !username) return;

    // Broadcast message to everyone in the room
    io.to(room).emit('chat message', {
      username: username,
      text: msgText,
      senderId: socket.id,
      system: false
    });
  });

  socket.on('disconnect', () => {
    const room = socket.data.room;
    const username = socket.data.username;

    if (room && username) {
      io.to(room).emit('chat message', {
        username: 'System',
        text: `${username} left the group.`,
        system: true
      });
    }
    console.log('User disconnected:', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
