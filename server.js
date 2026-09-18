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

// Store registered users: { username: password }
const users = {};

// Store rooms and passwords: { roomName: password }
// Pre-populate global "International Talk" room (no password required)
const rooms = {
  "International Talk": null
};

app.get('/', (req, res) => {
  res.send('Socket.IO Multigroup Backend is Running');
});

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  // 1. Sign In / Register User
  socket.on('login', ({ username, password }, callback) => {
    if (!username || !password) {
      return callback({ success: false, message: 'Name and Password are required.' });
    }

    if (users[username]) {
      if (users[username] !== password) {
        return callback({ success: false, message: 'Incorrect password for this user.' });
      }
    } else {
      // Register new user on first sign-in
      users[username] = password;
    }

    socket.data.username = username;
    
    // Return success and current list of available groups
    callback({ 
      success: true, 
      rooms: Object.keys(rooms) 
    });
  });

  // 2. Create New Group Room
  socket.on('create room', ({ roomName, roomPassword }, callback) => {
    if (!roomName) {
      return callback({ success: false, message: 'Group Name is required.' });
    }

    if (rooms[roomName] !== undefined) {
      return callback({ success: false, message: 'Group already exists.' });
    }

    rooms[roomName] = roomPassword || null;

    // Notify all online clients that a new group was created
    io.emit('room list update', Object.keys(rooms));

    callback({ success: true });
  });

  // 3. Switch / Join Selected Group
  socket.on('join room', ({ roomName, roomPassword }, callback) => {
    const username = socket.data.username;
    if (!username) {
      return callback({ success: false, message: 'You must be signed in.' });
    }

    // Verify room password if room requires one
    if (rooms[roomName] && rooms[roomName] !== roomPassword) {
      return callback({ success: false, message: 'Incorrect room password.' });
    }

    // Leave any current room
    if (socket.data.currentRoom) {
      socket.leave(socket.data.currentRoom);
      io.to(socket.data.currentRoom).emit('chat message', {
        username: 'System',
        text: `${username} left the group.`,
        system: true
      });
    }

    // Join new room
    socket.join(roomName);
    socket.data.currentRoom = roomName;

    callback({ success: true });

    // Announce user joined room
    io.to(roomName).emit('chat message', {
      username: 'System',
      text: `${username} joined ${roomName}.`,
      system: true
    });
  });

  // 4. Handle Chat Messages
  socket.on('chat message', (msgText) => {
    const room = socket.data.currentRoom;
    const username = socket.data.username;

    if (!room || !username) return;

    io.to(room).emit('chat message', {
      username: username,
      text: msgText,
      senderId: socket.id,
      system: false
    });
  });

  socket.on('disconnect', () => {
    const room = socket.data.currentRoom;
    const username = socket.data.username;

    if (room && username) {
      io.to(room).emit('chat message', {
        username: 'System',
        text: `${username} disconnected.`,
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
