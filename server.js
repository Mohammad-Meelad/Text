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

// Store rooms data: { roomName: { password: "...", owner: "username" } }
const rooms = {
  "International Talk": { password: null, owner: "System" }
};

app.get('/', (req, res) => {
  res.send('Socket.IO Chat Backend Running');
});

io.on('connection', (socket) => {

  // Sign In / Register
  socket.on('login', ({ username, password }, callback) => {
    if (!username || !password) {
      return callback({ success: false, message: 'Name and Password are required.' });
    }

    if (users[username]) {
      if (users[username] !== password) {
        return callback({ success: false, message: 'Incorrect user password.' });
      }
    } else {
      users[username] = password;
    }

    socket.data.username = username;
    
    // Send back current rooms and public properties (excluding passwords)
    const roomList = Object.keys(rooms).map(name => ({
      name: name,
      hasPassword: !!rooms[name].password,
      owner: rooms[name].owner
    }));

    callback({ success: true, rooms: roomList });
  });

  // Create New Group
  socket.on('create room', ({ roomName, roomPassword }, callback) => {
    const username = socket.data.username;
    if (!username) {
      return callback({ success: false, message: 'Must be logged in.' });
    }
    if (!roomName) {
      return callback({ success: false, message: 'Group Name is required.' });
    }
    if (rooms[roomName]) {
      return callback({ success: false, message: 'Group name already exists.' });
    }

    rooms[roomName] = {
      password: roomPassword || null,
      owner: username
    };

    broadcastRoomList();
    callback({ success: true });
  });

  // Join Selected Group
  socket.on('join room', ({ roomName, roomPassword }, callback) => {
    const username = socket.data.username;
    if (!username) {
      return callback({ success: false, message: 'You must be signed in.' });
    }

    const room = rooms[roomName];
    if (!room) {
      return callback({ success: false, message: 'Group does not exist.' });
    }

    // Password Check
    if (room.password && room.password !== roomPassword) {
      return callback({ success: false, message: 'Incorrect group password.' });
    }

    // Leave Current Room
    if (socket.data.currentRoom) {
      socket.leave(socket.data.currentRoom);
      io.to(socket.data.currentRoom).emit('chat message', {
        username: 'System',
        text: `${username} left the group.`,
        system: true
      });
    }

    // Join New Room
    socket.join(roomName);
    socket.data.currentRoom = roomName;

    callback({ success: true });

    io.to(roomName).emit('chat message', {
      username: 'System',
      text: `${username} joined ${roomName}.`,
      system: true
    });
  });

  // Delete Group
  socket.on('delete room', (roomName, callback) => {
    const username = socket.data.username;
    const room = rooms[roomName];

    if (!room) {
      return callback({ success: false, message: 'Group does not exist.' });
    }

    if (roomName === "International Talk") {
      return callback({ success: false, message: 'International Talk cannot be deleted.' });
    }

    if (room.owner !== username) {
      return callback({ success: false, message: 'Only the group owner can delete this group.' });
    }

    delete rooms[roomName];

    // Notify clients inside the room that it was deleted
    io.to(roomName).emit('room deleted', roomName);

    broadcastRoomList();
    callback({ success: true });
  });

  // Chat Message Handling
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
  });

  function broadcastRoomList() {
    const roomList = Object.keys(rooms).map(name => ({
      name: name,
      hasPassword: !!rooms[name].password,
      owner: rooms[name].owner
    }));
    io.emit('room list update', roomList);
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
