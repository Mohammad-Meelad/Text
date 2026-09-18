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

// Self-ping to keep Render free tier awake
setInterval(() => {
  https.get('https://text-p3e7.onrender.com/', (res) => {
    console.log('Self-ping sent.');
  }).on('error', (err) => {
    console.error('Self-ping failed:', err.message);
  });
}, 10 * 60 * 1000);

// Configure Email Transporter (Gmail App Password)
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

// Admin credentials
const ADMIN_USER = "Meelad Mohammad";
const ADMIN_PASS = "@Meelad@786@786";

// Users database
const users = {
  [ADMIN_USER]: { password: ADMIN_PASS, email: "admin@globalchat.com", verified: true }
};

// Pending verifications store: { email: { code, username, password, lastSent } }
const pendingVerifications = {};
const bannedUsers = new Set();
const activeSockets = {};

const rooms = {
  "International Talk": { password: null, owner: "System" }
};

const messageHistory = {
  "International Talk": []
};

app.get('/', (req, res) => {
  res.send('Socket.IO Chat Backend Running');
});

io.on('connection', (socket) => {

  // Step 1: Request Email Verification Code
  socket.on('request code', ({ username, email, password }, callback) => {
    if (!username || !email || !password) {
      return callback({ success: false, message: 'All fields are required.' });
    }

    if (bannedUsers.has(username)) {
      return callback({ success: false, message: 'This username is banned.' });
    }

    if (users[username]) {
      return callback({ success: false, message: 'Username already registered.' });
    }

    // Rate Limiting: 30 Seconds Cooldown per email
    const now = Date.now();
    if (pendingVerifications[email] && (now - pendingVerifications[email].lastSent < 30000)) {
      const remainingSeconds = Math.ceil((30000 - (now - pendingVerifications[email].lastSent)) / 1000);
      return callback({ 
        success: false, 
        message: `Please wait ${remainingSeconds} seconds before requesting a new code.` 
      });
    }

    const code = Math.floor(100000 + Math.random() * 900000).toString();
    pendingVerifications[email] = { code, username, password, lastSent: now };

    // Check if email environment variables are missing
    if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
      console.log(`\n--- [TEST MODE CODE] Verification code for ${email} is: ${code} ---\n`);
      return callback({ 
        success: true, 
        message: `[TEST MODE] Code generated! (Check Render logs if EMAIL_USER environment variable isn't set).` 
      });
    }

    const mailOptions = {
      from: `"Global Chat" <${process.env.EMAIL_USER}>`,
      to: email,
      subject: 'Your Verification Code',
      html: `
        <div style="font-family: Arial, sans-serif; padding: 20px;">
          <h2 style="color: #075e54;">Global Chat Sign-Up</h2>
          <p>Hello <b>${username}</b>,</p>
          <p>Your verification code is:</p>
          <h1 style="color: #25d366; letter-spacing: 4px;">${code}</h1>
        </div>
      `
    };

    transporter.sendMail(mailOptions, (error) => {
      if (error) {
        console.error('Email error:', error);
        return callback({ success: false, message: 'Failed to send verification email. Check SMTP setup.' });
      }
      callback({ success: true, message: 'Verification code sent to your email!' });
    });
  });

  // Step 2: Verify Code
  socket.on('verify code', ({ email, code }, callback) => {
    const pending = pendingVerifications[email];

    if (!pending) {
      return callback({ success: false, message: 'No verification request found for this email.' });
    }

    if (pending.code !== code) {
      return callback({ success: false, message: 'Invalid verification code.' });
    }

    users[pending.username] = {
      password: pending.password,
      email: email,
      verified: true
    };

    delete pendingVerifications[email];
    callback({ success: true, message: 'Account verified successfully!' });
  });

  // Sign In
  socket.on('login', ({ username, password }, callback) => {
    if (!username || !password) {
      return callback({ success: false, message: 'Name and Password are required.' });
    }

    if (bannedUsers.has(username)) {
      return callback({ success: false, message: 'Your account is banned.' });
    }

    const user = users[username];

    if (username === ADMIN_USER) {
      if (password !== ADMIN_PASS) return callback({ success: false, message: 'Incorrect Admin password.' });
    } else if (!user) {
      return callback({ success: false, message: 'User not found. Please register first.' });
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
    if (!roomName) return callback({ success: false, message: 'Group Name required.' });
    if (rooms[roomName]) return callback({ success: false, message: 'Group already exists.' });

    rooms[roomName] = { password: roomPassword || null, owner: username };
    messageHistory[roomName] = [];
    broadcastRoomList();
    callback({ success: true });
  });

  // Join Room
  socket.on('join room', ({ roomName, roomPassword }, callback) => {
    const username = socket.data.username;
    if (!username) return callback({ success: false, message: 'Must be logged in.' });

    const room = rooms[roomName];
    if (!room) return callback({ success: false, message: 'Group does not exist.' });

    if (!socket.data.isAdmin && room.password && room.password !== roomPassword) {
      return callback({ success: false, message: 'Incorrect room password.' });
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
    callback({ success: true, history });

    const joinMsg = { username: 'System', text: `${username} joined ${roomName}.`, system: true };
    saveMessage(roomName, joinMsg);
    io.to(roomName).emit('chat message', joinMsg);
  });

  // Delete Room
  socket.on('delete room', (roomName, callback) => {
    const username = socket.data.username;
    const room = rooms[roomName];

    if (!room) return callback({ success: false, message: 'Group does not exist.' });
    if (roomName === "International Talk") return callback({ success: false, message: 'Cannot delete International Talk.' });
    if (room.owner !== username && !socket.data.isAdmin) {
      return callback({ success: false, message: 'Unauthorized.' });
    }

    delete rooms[roomName];
    delete messageHistory[roomName];
    io.to(roomName).emit('room deleted', roomName);
    broadcastRoomList();
    callback({ success: true });
  });

  // Message Handler
  socket.on('chat message', (msgText) => {
    const room = socket.data.currentRoom;
    const username = socket.data.username;

    if (!room || !username || bannedUsers.has(username)) return;

    const msgData = { username, text: msgText, senderId: socket.id, system: false };
    saveMessage(room, msgData);
    io.to(room).emit('chat message', msgData);
  });

  // Admin Data
  socket.on('admin get data', (callback) => {
    if (!socket.data.isAdmin) return callback({ success: false });
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
        targetSocket.emit('kicked', 'Kicked by Admin.');
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
        targetSocket.emit('kicked', 'Banned by Admin.');
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
