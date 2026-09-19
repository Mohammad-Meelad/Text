const express = require('express');
const http = require('http');
const https = require('https');
const { Server } = require('socket.io');
const mongoose = require('mongoose');

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
  https.get('https://text-p3e7.onrender.com/', () => {
    console.log('Self-ping sent.');
  }).on('error', (err) => {
    console.error('Self-ping failed:', err.message);
  });
}, 10 * 60 * 1000);

// Connect to MongoDB Atlas
const MONGODB_URI = process.env.MONGODB_URI;

if (MONGODB_URI) {
  mongoose.connect(MONGODB_URI)
    .then(() => console.log('Successfully connected to MongoDB Atlas!'))
    .catch((err) => console.error('MongoDB connection error:', err));
} else {
  console.warn('WARNING: MONGODB_URI variable missing. Server operating in memory.');
}

// Database Schemas
const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true, lowercase: true },
  displayName: { type: String, required: true },
  password: { type: String, required: true },
  email: { type: String, required: true },
  verified: { type: Boolean, default: false }
});

const feedbackSchema = new mongoose.Schema({
  senderUsername: { type: String, required: true },
  senderDisplayName: { type: String, required: true },
  text: { type: String, required: true },
  timestamp: { type: String, required: true },
  reply: {
    text: String,
    timestamp: String
  }
});

const messageSchema = new mongoose.Schema({
  roomName: { type: String, required: true },
  username: String,
  displayName: String,
  text: String,
  senderId: String,
  system: Boolean,
  timestamp: { type: Date, default: Date.now }
});

const User = mongoose.model('User', userSchema);
const Feedback = mongoose.model('Feedback', feedbackSchema);
const Message = mongoose.model('Message', messageSchema);

// Admin Credentials
const ADMIN_USERNAME = "admin";
const ADMIN_DISPLAY = "Meelad Mohammad";
const ADMIN_PASS = "@Meelad@786@786";
const ADMIN_EMAIL = "mohammad.milad.stu@almustafaacademy.ca";

// Auto-create Admin Account in Database
async function initAdmin() {
  if (mongoose.connection.readyState === 1) {
    const adminExists = await User.findOne({ username: ADMIN_USERNAME });
    if (!adminExists) {
      await User.create({
        username: ADMIN_USERNAME,
        displayName: ADMIN_DISPLAY,
        password: ADMIN_PASS,
        email: ADMIN_EMAIL,
        verified: true
      });
      console.log('Admin account created in MongoDB.');
    }
  }
}
mongoose.connection.once('open', initAdmin);

const pendingVerifications = {};
const bannedUsers = new Set();
const activeSockets = {};

const rooms = {
  "International Talk": { password: null, owner: "System" }
};

app.get('/', (req, res) => {
  res.send('Easy Chat Backend Running');
});

io.on('connection', (socket) => {

  // Verification Code Request
  socket.on('request code', async ({ username, displayName, email, password }, callback) => {
    if (!username || !displayName || !email || !password) {
      return callback({ success: false, message: 'All fields are required.' });
    }

    const usernameRegex = /^[a-z0-9]+$/;
    if (!usernameRegex.test(username)) {
      return callback({ 
        success: false, 
        message: 'Username must contain only lowercase letters and numbers.' 
      });
    }

    if (bannedUsers.has(username)) {
      return callback({ success: false, message: 'This username is banned.' });
    }

    const existingUser = mongoose.connection.readyState === 1 
      ? await User.findOne({ username })
      : null;

    if (existingUser) {
      return callback({ success: false, message: 'Username already taken.' });
    }

    const now = Date.now();
    if (pendingVerifications[email] && (now - pendingVerifications[email].lastSent < 30000)) {
      const remaining = Math.ceil((30000 - (now - pendingVerifications[email].lastSent)) / 1000);
      return callback({ success: false, message: `Please wait ${remaining} seconds before requesting a new code.` });
    }

    const code = Math.floor(100000 + Math.random() * 900000).toString();
    pendingVerifications[email] = { code, username, displayName, password, lastSent: now };

    const resendApiKey = process.env.RESEND_API_KEY;

    if (!resendApiKey) {
      console.log(`\n--- Verification code for ${email}: ${code} ---\n`);
      return callback({ success: true, message: '[TEST MODE] Verification code generated (check Render logs).' });
    }

    try {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${resendApiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          from: 'Easy Chat <onboarding@resend.dev>',
          to: [email],
          subject: 'Your Easy Chat Verification Code',
          html: `
            <div style="font-family: Arial, sans-serif; padding: 20px;">
              <h2 style="color: #075e54;">Easy Chat Verification</h2>
              <p>Hello <b>${displayName}</b> (@${username}),</p>
              <p>Your verification code is:</p>
              <h1 style="color: #25d366; letter-spacing: 4px;">${code}</h1>
            </div>
          `
        })
      });

      if (response.ok) {
        callback({ success: true, message: 'Verification code sent to your email!' });
      } else {
        callback({ success: false, message: 'Failed to send verification email.' });
      }
    } catch (error) {
      callback({ success: false, message: 'Email service connection error.' });
    }
  });

  // Verify Code
  socket.on('verify code', async ({ email, code }, callback) => {
    const pending = pendingVerifications[email];

    if (!pending) return callback({ success: false, message: 'No verification request found for this email.' });
    if (pending.code !== code) return callback({ success: false, message: 'Invalid verification code.' });

    if (mongoose.connection.readyState === 1) {
      await User.create({
        username: pending.username,
        displayName: pending.displayName,
        password: pending.password,
        email: email,
        verified: true
      });
    }

    delete pendingVerifications[email];
    callback({ success: true, message: 'Account verified successfully!' });
  });

  // User Login
  socket.on('login', async ({ username, password }, callback) => {
    if (!username || !password) {
      return callback({ success: false, message: 'Username and Password required.' });
    }

    const cleanUsername = username.toLowerCase().trim();

    if (bannedUsers.has(cleanUsername)) {
      return callback({ success: false, message: 'Your account is banned.' });
    }

    let user = null;
    if (mongoose.connection.readyState === 1) {
      user = await User.findOne({ username: cleanUsername });
    }

    if (cleanUsername === ADMIN_USERNAME) {
      if (password !== ADMIN_PASS) return callback({ success: false, message: 'Incorrect Admin password.' });
    } else if (!user) {
      return callback({ success: false, message: 'User not found. Please register first.' });
    } else if (user.password !== password) {
      return callback({ success: false, message: 'Incorrect password.' });
    }

    socket.data.username = cleanUsername;
    socket.data.displayName = user ? user.displayName : ADMIN_DISPLAY;
    socket.data.isAdmin = (cleanUsername === ADMIN_USERNAME);
    activeSockets[cleanUsername] = socket.id;

    let userFeedbackHistory = [];
    if (mongoose.connection.readyState === 1) {
      userFeedbackHistory = await Feedback.find({ senderUsername: cleanUsername });
    }

    callback({ 
      success: true, 
      rooms: Object.keys(rooms).map(name => ({ name, hasPassword: !!rooms[name].password, owner: rooms[name].owner })), 
      isAdmin: socket.data.isAdmin,
      displayName: socket.data.displayName,
      userFeedbackHistory
    });
  });

  // Feedback System
  socket.on('send admin message', async (msgText, callback) => {
    const username = socket.data.username;
    const displayName = socket.data.displayName;

    if (!username) return callback({ success: false, message: 'Must be logged in.' });
    if (socket.data.isAdmin) return callback({ success: false, message: 'Admins cannot send feedback.' });

    let msgData = {
      senderUsername: username,
      senderDisplayName: displayName,
      text: msgText,
      timestamp: new Date().toLocaleTimeString(),
      reply: null
    };

    if (mongoose.connection.readyState === 1) {
      const created = await Feedback.create(msgData);
      msgData.id = created._id;
    }

    const adminSocketId = activeSockets[ADMIN_USERNAME];
    if (adminSocketId) {
      io.to(adminSocketId).emit('new feedback message', msgData);
    }

    callback({ success: true, message: 'Feedback sent directly to Admin!', msgData });
  });

  socket.on('admin reply feedback', async ({ messageId, replyText }, callback) => {
    if (!socket.data.isAdmin) return callback({ success: false, message: 'Unauthorized' });

    let feedbackObj = null;
    if (mongoose.connection.readyState === 1) {
      feedbackObj = await Feedback.findByIdAndUpdate(
        messageId, 
        { reply: { text: replyText, timestamp: new Date().toLocaleTimeString() } },
        { new: true }
      );
    }

    if (feedbackObj) {
      const userSocketId = activeSockets[feedbackObj.senderUsername];
      if (userSocketId) {
        io.to(userSocketId).emit('feedback reply received', feedbackObj);
      }
    }

    callback({ success: true, feedbackObj });
  });

  // Room Join & Chat Messages
  socket.on('join room', async ({ roomName, roomPassword }, callback) => {
    const username = socket.data.username;
    const displayName = socket.data.displayName;

    if (!username) return callback({ success: false, message: 'Must be logged in.' });

    const room = rooms[roomName];
    if (!room) return callback({ success: false, message: 'Group does not exist.' });

    if (socket.data.currentRoom) {
      const oldRoom = socket.data.currentRoom;
      socket.leave(oldRoom);
      const leaveMsg = { roomName: oldRoom, username: 'System', displayName: 'System', text: `${displayName} has left ${oldRoom}.`, system: true };
      if (mongoose.connection.readyState === 1) await Message.create(leaveMsg);
      io.to(oldRoom).emit('chat message', leaveMsg);
    }

    socket.join(roomName);
    socket.data.currentRoom = roomName;

    let history = [];
    if (mongoose.connection.readyState === 1) {
      history = await Message.find({ roomName }).sort({ timestamp: -1 }).limit(200);
      history.reverse();
    }

    callback({ success: true, history });

    const joinMsg = { roomName, username: 'System', displayName: 'System', text: `${displayName} joined ${roomName}.`, system: true };
    if (mongoose.connection.readyState === 1) await Message.create(joinMsg);
    io.to(roomName).emit('chat message', joinMsg);
  });

  socket.on('chat message', async (msgText) => {
    const room = socket.data.currentRoom;
    const username = socket.data.username;
    const displayName = socket.data.displayName;

    if (!room || !username || bannedUsers.has(username)) return;

    const msgData = { roomName: room, username, displayName, text: msgText, senderId: socket.id, system: false };
    if (mongoose.connection.readyState === 1) await Message.create(msgData);
    io.to(room).emit('chat message', msgData);
  });

  // Admin Data Panel
  socket.on('admin get data', async (callback) => {
    if (!socket.data.isAdmin) return callback({ success: false });

    let registeredUsers = [];
    let feedbackMessages = [];

    if (mongoose.connection.readyState === 1) {
      registeredUsers = await User.find({}, 'username displayName email verified');
      feedbackMessages = await Feedback.find({});
    }

    callback({
      success: true,
      activeUsers: Object.keys(activeSockets),
      registeredUsers,
      bannedUsers: Array.from(bannedUsers),
      rooms: Object.keys(rooms),
      feedbackMessages
    });
  });

  socket.on('disconnect', () => {
    const room = socket.data.currentRoom;
    const username = socket.data.username;
    const displayName = socket.data.displayName;

    if (username) delete activeSockets[username];
    if (room && username) {
      const disconnectMsg = { roomName: room, username: 'System', displayName: 'System', text: `${displayName} has left ${room}.`, system: true };
      if (mongoose.connection.readyState === 1) Message.create(disconnectMsg);
      io.to(room).emit('chat message', disconnectMsg);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
