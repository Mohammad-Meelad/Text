const express = require('express');
const http = require('http');
const https = require('https');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Keep Render free instance awake with self-ping
setInterval(() => {
  https.get('https://text-p3e7.onrender.com/', (res) => {
    console.log('Self-ping sent to keep server alive.');
  }).on('error', (err) => {
    console.error('Self-ping failed:', err.message);
  });
}, 10 * 60 * 1000);

// Registered users: { username: password }
const users = {};

// Group rooms: { roomName: { password: "...", owner: "username" } }
const rooms = {
  "International Talk": { password: null, owner: "System" }
};

// In-memory message history store: { roomName: [ { username, text, senderId, system, timestamp } ] }
const messageHistory = {
  "International Talk": []
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

    // Initialize history array for the new room
    messageHistory[roomName] = [];

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

    if (room.password && room.password !== roomPassword) {
      return callback({ success: false, message: 'Incorrect group password.' });
    }

    // Leave Current Room
    if (socket.data.currentRoom) {
      const oldRoom = socket.data.currentRoom;
      socket.leave(oldRoom);

      const leaveMsg = {
        username: 'System',
        text: `${username} has left ${oldRoom}.`,
        system: true
      };
      
      saveMessage(oldRoom, leaveMsg);
      io.to(oldRoom).emit('chat message', leaveMsg);
    }

    // Join New Room
    socket.join(roomName);
    socket.data.currentRoom = roomName;

    // Send saved chat history to the joining user only
    const history = messageHistory[roomName] || [];
    callback({ success: true, history: history });

    // Broadcast join notification to room
    const joinMsg = {
      username: 'System',
      text: `${username} joined ${roomName}.`,
      system: true
    };

    saveMessage(roomName, joinMsg);
    io.to(roomName).emit('chat message', joinMsg);
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
    delete messageHistory[roomName];

    io.to(roomName).emit('room deleted', roomName);
    broadcastRoomList();
    callback({ success: true });
  });

  // Chat Message Handling
  socket.on('chat message', (msgText) => {
    const room = socket.data.currentRoom;
    const username = socket.data.username;

    if (!room || !username) return;

    const msgData = {
      username: username,
      text: msgText,
      senderId: socket.id,
      system: false
    };

    saveMessage(room, msgData);
    io.to(room).emit('chat message', msgData);
  });

  socket.on('disconnect', () => {
    const room = socket.data.currentRoom;
    const username = socket.data.username;

    if (room && username) {
      const disconnectMsg = {
        username: 'System',
        text: `${username} has left ${room}.`,
        system: true
      };

      saveMessage(room, disconnectMsg);
      io.to(room).emit('chat message', disconnectMsg);
    }
  });

  function saveMessage(roomName, msgData) {
    if (!messageHistory[roomName]) {
      messageHistory[roomName] = [];
    }
    // Limit stored messages per room to last 200 messages to manage memory
    messageHistory[roomName].push(msgData);
    if (messageHistory[roomName].length > 200) {
      messageHistory[roomName].shift();
    }
  }

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
