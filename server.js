const express = require('express');
const http = require('http');
const https = require('https');
const { Server } = require('socket.io');
const nodemailer = require('nodemailer');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Self-ping every 10 minutes to keep Render instance awake
setInterval(() => {
  https.get('https://text-p3e7.onrender.com/', (res) => {
    console.log('Self-ping sent to keep server alive.');
  }).on('error', (err) => {
    console.error('Self-ping failed:', err.message);
  });
}, 10 * 60 * 1000);

// Transporter setup for sending emails using Nodemailer
// Set EMAIL_USER and EMAIL_PASS environment variables on Render, or put testing SMTP credentials here
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER || 'your-gmail@gmail.com',
    pass: process.env.EMAIL_PASS || 'your-app-password'
  }
});

// Admin credentials
const ADMIN_USER = "Meelad Mohammad";
const ADMIN_PASS = "@Meelad@786@786";

// Users database: { username: { password: "...", email: "...", verified: true/false } }
const users = {
  [ADMIN_USER]: { password: ADMIN_PASS, email: "admin@globalchat.com", verified: true }
};

// Pending email verifications: { email: { code: "123456", username, password } }
const pendingVerifications = {};

// Banned usernames set
const bannedUsers = new Set();

// Active sockets map: { username: socketId }
const activeSockets = {};

// Group rooms
const rooms = {
  "International Talk": { password: null, owner: "System" }
};

// Message history
const messageHistory = {
  "International Talk": []
};

app.get('/', (req, res) => {
  res.send('Socket.IO Chat Backend Running');
});

io.on('connection', (socket) => {

  // Step 1: Request Registration Verification Code
  socket.on('request code', ({ username, email, password }, callback) => {
    if (!username || !email || !password) {
      return callback({ success: false, message: 'All fields are required.' });
    }

    if (bannedUsers.has(username)) {
      return callback({ success: false, message: 'This username is banned.' });
    }

    if (users[username]) {
      return callback({ success: false, message: 'Username already registered. Please sign in.' });
    }

    // Generate 6-digit verification code
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    pendingVerifications[email] = { code, username, password };

    // Send verification email
    const mailOptions = {
      from: '"Global Chat App" <no-reply@globalchat.com>',
      to: email,
      subject: 'Your Global Chat Verification Code',
      html: `
        <div style="font-family: Arial, sans-serif; padding: 20px; background-color: #f4f4f9;">
          <h2 style="color: #075e54;">Global Chat Email Verification</h2>
          <p>Hello <b>${username}</b>,</p>
          <p>Your 6-digit verification code to complete sign-up is:</p>
          <h1 style="color: #25d366; letter-spacing: 5px;">${code}</h1>
          <p>This code will expire shortly.</p>
        </div>
      `
    };

    transporter.sendMail(mailOptions, (error, info) => {
      if (error) {
        console.error('Email error:', error);
        // Fallback for development if SMTP fails: displays code in server console/callback
        return callback({ 
          success: false, 
          message: 'Failed to send email. Check SMTP settings or check server logs.' 
        });
      }
      callback({ success: true, message: 'Verification code sent to your email!' });
    });
  });

  // Step 2: Verify Code and Complete Registration
  socket.on('verify code', ({ email, code }, callback) => {
    const pending = pendingVerifications[email];

    if (!pending) {
      return callback({ success: false, message: 'No verification request found for this email.' });
    }

    if (pending.code !== code) {
      return callback({ success: false, message: 'Invalid verification code.' });
    }

    // Register user
    users[pending.username] = {
      password: pending.password,
      email: email,
      verified: true
    };

    delete pendingVerifications[email];
    callback({ success: true, message: 'Email verified! You can now sign in.' });
  });

  // Login Handler
  socket.on('login', ({ username, password }, callback) => {
    if (!username || !password) {
      return callback({ success: false, message: 'Name and Password are required.' });
    }

    if (bannedUsers.has(username)) {
      return callback({ success: false, message: 'Your account has been banned by the Admin.' });
    }

    const user = users[username];

    if (username === ADMIN_USER) {
      if (password !== ADMIN_PASS) {
        return callback({ success: false, message: 'Incorrect Admin password.' });
      }
    } else if (!user) {
      return callback({ success: false, message: 'User not found. Please create an account.' });
    } else if (user.password !== password) {
      return callback({ success: false, message: 'Incorrect password.' });
    }

    socket.data.username = username;
    socket.data.isAdmin = (username === ADMIN_USER);
    activeSockets[username] = socket.id;

    callback({ 
      success: true, 
      rooms: getRoomList(), 
      isAdmin: socket.data.isAdmin 
    });
  });

  // Create Room
  socket.on('create room', ({ roomName, roomPassword }, callback) => {
    const username = socket.data.username;
    if (!username) return callback({ success: false, message: 'Must be logged in.' });
    if (!roomName) return callback({ success: false, message: 'Group Name is required.' });
    if (rooms[roomName]) return callback({ success: false, message: 'Group name already exists.' });

    rooms[roomName] = { password: roomPassword || null, owner: username };
    messageHistory[roomName] = [];
    broadcastRoomList();
    callback({ success: true });
  });

  // Join Room
  socket.on('join room', ({ roomName, roomPassword }, callback) => {
    const username = socket.data.username;
    if (!username) return callback({ success: false, message: 'You must be signed in.' });

    const room = rooms[roomName];
    if (!room) return callback({ success: false, message: 'Group does not exist.' });

    if (!socket.data.isAdmin && room.password && room.password !== roomPassword) {
      return callback({ success: false, message: 'Incorrect group password.' });
    }

    if (socket.data.currentRoom) {
      const oldRoom = socket.data.currentRoom;
      socket.leave(oldRoom);

      const leaveMsg = { username: 'System', text: `${username} has left ${oldRoom}.`, system: true };
      saveMessage(oldRoom, leaveMsg);
      io.to(oldRoom).emit('chat message', leaveMsg);
    }

    socket.join(roomName);
    socket.data.currentRoom = roomName;

    const history = messageHistory[roomName] || [];
    callback({ success: true, history: history });

    const joinMsg = { username: 'System', text: `${username} joined ${roomName}.`, system: true };
    saveMessage(roomName, joinMsg);
    io.to(roomName).emit('chat message', joinMsg);
  });

  // Delete Room
  socket.on('delete room', (roomName, callback) => {
    const username = socket.data.username;
    const room = rooms[roomName];

    if (!room) return callback({ success: false, message: 'Group does not exist.' });
    if (roomName === "International Talk") return callback({ success: false, message: 'International Talk cannot be deleted.' });
    if (room.owner !== username && !socket.data.isAdmin) {
      return callback({ success: false, message: 'Only the group owner or Admin can delete this group.' });
    }

    delete rooms[roomName];
    delete messageHistory[roomName];
    io.to(roomName).emit('room deleted', roomName);
    broadcastRoomList();
    callback({ success: true });
  });

  // Chat Message
  socket.on('chat message', (msgText) => {
    const room = socket.data.currentRoom;
    const username = socket.data.username;

    if (!room || !username || bannedUsers.has(username)) return;

    const msgData = { username: username, text: msgText, senderId: socket.id, system: false };
    saveMessage(room, msgData);
    io.to(room).emit('chat message', msgData);
  });

  // Admin Data Request
  socket.on('admin get data', (callback) => {
    if (!socket.data.isAdmin) return callback({ success: false, message: 'Unauthorized' });
    callback({
      success: true,
      activeUsers: Object.keys(activeSockets),
      registeredUsers: Object.keys(users),
      bannedUsers: Array.from(bannedUsers),
      rooms: Object.keys(rooms)
    });
  });

  socket.on('admin kick user', (targetUser, callback) => {
    if (!socket.data.isAdmin || targetUser === ADMIN_USER) return callback({ success: false });
    const targetSocketId = activeSockets[targetUser];
    if (targetSocketId) {
      const targetSocket = io.sockets.sockets.get(targetSocketId);
      if (targetSocket) {
        targetSocket.emit('kicked', 'You have been kicked by the Admin.');
        targetSocket.disconnect();
      }
      delete activeSockets[targetUser];
    }
    callback({ success: true });
  });

  socket.on('admin ban user', (targetUser, callback) => {
    if (!socket.data.isAdmin || targetUser === ADMIN_USER) return callback({ success: false });
    bannedUsers.add(targetUser);
    const targetSocketId = activeSockets[targetUser];
    if (targetSocketId) {
      const targetSocket = io.sockets.sockets.get(targetSocketId);
      if (targetSocket) {
        targetSocket.emit('kicked', 'You have been banned by the Admin.');
        targetSocket.disconnect();
      }
      delete activeSockets[targetUser];
    }
    callback({ success: true });
  });

  socket.on('admin unban user', (targetUser, callback) => {
    if (!socket.data.isAdmin) return callback({ success: false });
    bannedUsers.delete(targetUser);
    callback({ success: true });
  });

  socket.on('admin clear messages', (roomName, callback) => {
    if (!socket.data.isAdmin) return callback({ success: false });
    if (messageHistory[roomName]) {
      messageHistory[roomName] = [];
      io.to(roomName).emit('chat cleared');
      callback({ success: true });
    }
  });

  socket.on('disconnect', () => {
    const room = socket.data.currentRoom;
    const username = socket.data.username;
    if (username) delete activeSockets[username];
    if (room && username) {
      const disconnectMsg = { username: 'System', text: `${username} has left ${room}.`, system: true };
      saveMessage(room, disconnectMsg);
      io.to(room).emit('chat message', disconnectMsg);
    }
  });

  function saveMessage(roomName, msgData) {
    if (!messageHistory[roomName]) messageHistory[roomName] = [];
    messageHistory[roomName].push(msgData);
    if (messageHistory[roomName].length > 200) messageHistory[roomName].shift();
  }

  function getRoomList() {
    return Object.keys(rooms).map(name => ({
      name: name,
      hasPassword: !!rooms[name].password,
      owner: rooms[name].owner
    }));
  }

  function broadcastRoomList() {
    io.emit('room list update', getRoomList());
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
