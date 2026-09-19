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

// Keep Render free tier alive with self-ping
setInterval(() => {
  https.get('https://text-p3e7.onrender.com/', (res) => {
    console.log('Self-ping sent to maintain Render instance.');
  }).on('error', (err) => {
    console.error('Self-ping error:', err.message);
  });
}, 10 * 60 * 1000);

// Admin account credentials
const ADMIN_USERNAME = "admin";
const ADMIN_DISPLAY = "Meelad Mohammad";
const ADMIN_PASS = "@Meelad@786@786";

// Persistent users database in-memory: { [username]: { password, email, displayName } }
const users = {
  [ADMIN_USERNAME]: { 
    password: ADMIN_PASS, 
    email: "admin@easychat.com", 
    displayName: ADMIN_DISPLAY 
  }
};

// Persistent store for verification requests: { [email]: { code, username, displayName, password, lastSent } }
const pendingVerifications = {};

// Banned usernames set
const bannedUsers = new Set();

// Map of active connected sockets: { [username]: socketId }
const activeSockets = {};

// Default and dynamic group rooms
const rooms = {
  "International Talk": { password: null, owner: "System" }
};

// Message history store per group room (up to 200 per room)
const messageHistory = {
  "International Talk": []
};

// Persistent store for user feedback & issue submissions
// Format: [ { id, senderUsername, senderDisplayName, text, timestamp, reply: null | { text, timestamp } } ]
const feedbackStore = [];

app.get('/', (req, res) => {
  res.send('Easy Chat Socket.IO Backend is Running');
});

io.on('connection', (socket) => {

  // Step 1: Request Email Verification Code
  socket.on('request code', async ({ username, displayName, email, password }, callback) => {
    if (!username || !displayName || !email || !password) {
      return callback({ success: false, message: 'All fields are required.' });
    }

    const cleanUsername = username.toLowerCase().trim();
    const usernameRegex = /^[a-z0-9]+$/;
    if (!usernameRegex.test(cleanUsername)) {
      return callback({ 
        success: false, 
        message: 'Username must contain only lowercase letters and numbers.' 
      });
    }

    if (bannedUsers.has(cleanUsername)) {
      return callback({ success: false, message: 'This account username is currently banned.' });
    }

    if (users[cleanUsername]) {
      return callback({ success: false, message: 'Username is already registered.' });
    }

    const now = Date.now();
    if (pendingVerifications[email] && (now - pendingVerifications[email].lastSent < 30000)) {
      const remaining = Math.ceil((30000 - (now - pendingVerifications[email].lastSent)) / 1000);
      return callback({ 
        success: false, 
        message: `Please wait ${remaining} seconds before requesting a new code.` 
      });
    }

    const code = Math.floor(100000 + Math.random() * 900000).toString();
    pendingVerifications[email] = { code, username: cleanUsername, displayName, password, lastSent: now };

    const resendApiKey = process.env.RESEND_API_KEY;

    if (!resendApiKey) {
      console.log(`\n--- [TEST MODE CODE] Easy Chat code for ${email}: ${code} ---\n`);
      return callback({ 
        success: true, 
        message: `[TEST MODE] Code generated! Check server logs if RESEND_API_KEY is not set.` 
      });
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
            <div style="font-family: Arial, sans-serif; padding: 20px; background-color: #f9f9f9; border-radius: 8px;">
              <h2 style="color: #075e54;">Easy Chat Account Verification</h2>
              <p>Hello <b>${displayName}</b> (@${cleanUsername}),</p>
              <p>Your 6-digit code to complete registration is:</p>
              <h1 style="color: #25d366; letter-spacing: 5px;">${code}</h1>
              <p style="font-size: 12px; color: #777;">If you did not request this code, please ignore this email.</p>
            </div>
          `
        })
      });

      if (response.ok) {
        callback({ success: true, message: 'Verification code sent to your email!' });
      } else {
        const errData = await response.json();
        console.error('Resend error:', errData);
        callback({ success: false, message: 'Failed to send verification email. Check API key settings.' });
      }
    } catch (error) {
      console.error('Fetch error:', error);
      callback({ success: false, message: 'Email service connection failed.' });
    }
  });

  // Step 2: Verify Code and Activate Account
  socket.on('verify code', ({ email, code }, callback) => {
    const pending = pendingVerifications[email];

    if (!pending) {
      return callback({ success: false, message: 'No verification request found for this email address.' });
    }

    if (pending.code !== code) {
      return callback({ success: false, message: 'Invalid verification code.' });
    }

    users[pending.username] = {
      password: pending.password,
      email: email,
      displayName: pending.displayName
    };

    delete pendingVerifications[email];
    callback({ success: true, message: 'Account verified successfully! You may now sign in.' });
  });

  // Login Handler
  socket.on('login', ({ username, password }, callback) => {
    if (!username || !password) {
      return callback({ success: false, message: 'Username and password are required.' });
    }

    const cleanUsername = username.toLowerCase().trim();

    if (bannedUsers.has(cleanUsername)) {
      return callback({ success: false, message: 'Your account has been banned by the Administrator.' });
    }

    const user = users[cleanUsername];

    if (cleanUsername === ADMIN_USERNAME) {
      if (password !== ADMIN_PASS) return callback({ success: false, message: 'Incorrect Admin password.' });
    } else if (!user) {
      return callback({ success: false, message: 'User account not found. Please register first.' });
    } else if (user.password !== password) {
      return callback({ success: false, message: 'Incorrect password.' });
    }

    socket.data.username = cleanUsername;
    socket.data.displayName = user ? user.displayName : ADMIN_DISPLAY;
    socket.data.isAdmin = (cleanUsername === ADMIN_USERNAME);
    activeSockets[cleanUsername] = socket.id;

    const userFeedbackHistory = feedbackStore.filter(msg => msg.senderUsername === cleanUsername);

    callback({ 
      success: true, 
      rooms: getRoomList(), 
      isAdmin: socket.data.isAdmin,
      displayName: socket.data.displayName,
      userFeedbackHistory: userFeedbackHistory
    });
  });

  // User Feedback Submission
  socket.on('send admin message', (msgText, callback) => {
    const username = socket.data.username;
    const displayName = socket.data.displayName;

    if (!username) return callback({ success: false, message: 'You must be logged in to send feedback.' });
    if (socket.data.isAdmin) return callback({ success: false, message: 'Admins cannot send feedback to themselves.' });

    const msgData = {
      id: Date.now().toString(),
      senderUsername: username,
      senderDisplayName: displayName,
      text: msgText,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      reply: null
    };

    feedbackStore.push(msgData);

    const adminSocketId = activeSockets[ADMIN_USERNAME];
    if (adminSocketId) {
      io.to(adminSocketId).emit('new feedback message', msgData);
    }

    callback({ success: true, message: 'Your feedback has been sent directly to the Admin.', msgData });
  });

  // Admin Reply to Feedback
  socket.on('admin reply feedback', ({ messageId, replyText }, callback) => {
    if (!socket.data.isAdmin) return callback({ success: false, message: 'Unauthorized' });

    const feedbackObj = feedbackStore.find(msg => msg.id === messageId);
    if (!feedbackObj) return callback({ success: false, message: 'Feedback entry not found.' });

    feedbackObj.reply = {
      text: replyText,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    };

    const userSocketId = activeSockets[feedbackObj.senderUsername];
    if (userSocketId) {
      io.to(userSocketId).emit('feedback reply received', feedbackObj);
    }

    callback({ success: true, feedbackObj });
  });

  // Create Room
  socket.on('create room', ({ roomName, roomPassword }, callback) => {
    const username = socket.data.username;
    if (!username) return callback({ success: false, message: 'Must be logged in.' });
    if (!roomName) return callback({ success: false, message: 'Group Name is required.' });
    if (rooms[roomName]) return callback({ success: false, message: 'Group already exists.' });

    rooms[roomName] = { password: roomPassword || null, owner: username };
    messageHistory[roomName] = [];
    broadcastRoomList();
    callback({ success: true });
  });

  // Join Room with refined system notifications
  socket.on('join room', ({ roomName, roomPassword }, callback) => {
    const username = socket.data.username;
    const displayName = socket.data.displayName;

    if (!username) return callback({ success: false, message: 'You must be signed in.' });

    const room = rooms[roomName];
    if (!room) return callback({ success: false, message: 'Group does not exist.' });

    if (!socket.data.isAdmin && room.password && room.password !== roomPassword) {
      return callback({ success: false, message: 'Incorrect group password.' });
    }

    if (socket.data.currentRoom) {
      const oldRoom = socket.data.currentRoom;
      socket.leave(oldRoom);
      const leaveMsg = { 
        username: 'System', 
        displayName: 'System', 
        text: `${displayName} has left ${oldRoom}.`, 
        system: true 
      };
      saveMessage(oldRoom, leaveMsg);
      io.to(oldRoom).emit('chat message', leaveMsg);
    }

    socket.join(roomName);
    socket.data.currentRoom = roomName;

    const history = messageHistory[roomName] || [];
    callback({ success: true, history });

    const joinMsg = { 
      username: 'System', 
      displayName: 'System', 
      text: `${displayName} joined ${roomName}.`, 
      system: true 
    };
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
      return callback({ success: false, message: 'Unauthorized to delete this group.' });
    }

    delete rooms[roomName];
    delete messageHistory[roomName];
    io.to(roomName).emit('room deleted', roomName);
    broadcastRoomList();
    callback({ success: true });
  });

  // Chat Message Broadcast
  socket.on('chat message', (msgText) => {
    const room = socket.data.currentRoom;
    const username = socket.data.username;
    const displayName = socket.data.displayName;

    if (!room || !username || bannedUsers.has(username)) return;

    const msgData = { username, displayName, text: msgText, senderId: socket.id, system: false };
    saveMessage(room, msgData);
    io.to(room).emit('chat message', msgData);
  });

  // Get Admin Dashboard Overview
  socket.on('admin get data', (callback) => {
    if (!socket.data.isAdmin) return callback({ success: false, message: 'Unauthorized' });

    const userDetails = Object.keys(users).map(u => ({
      username: u,
      displayName: users[u].displayName,
      email: users[u].email,
      isBanned: bannedUsers.has(u),
      isOnline: !!activeSockets[u]
    }));

    callback({
      success: true,
      users: userDetails,
      bannedUsers: Array.from(bannedUsers),
      rooms: Object.keys(rooms),
      feedbackMessages: feedbackStore
    });
  });

  // Admin Create New Account
  socket.on('admin create user', ({ username, displayName, email, password }, callback) => {
    if (!socket.data.isAdmin) return callback({ success: false, message: 'Unauthorized' });

    const cleanUsername = username.toLowerCase().trim();
    if (!cleanUsername || !displayName || !email || !password) {
      return callback({ success: false, message: 'All fields are required.' });
    }

    if (users[cleanUsername]) {
      return callback({ success: false, message: 'Username already exists.' });
    }

    users[cleanUsername] = { password, email, displayName };
    callback({ success: true, message: `Account @${cleanUsername} created successfully!` });
  });

  // Admin Edit Existing Account
  socket.on('admin edit user', ({ targetUsername, displayName, email, password }, callback) => {
    if (!socket.data.isAdmin) return callback({ success: false, message: 'Unauthorized' });

    const cleanUsername = targetUsername.toLowerCase().trim();
    if (!users[cleanUsername]) {
      return callback({ success: false, message: 'User account not found.' });
    }

    if (displayName) users[cleanUsername].displayName = displayName;
    if (email) users[cleanUsername].email = email;
    if (password) users[cleanUsername].password = password;

    callback({ success: true, message: `Updated details for @${cleanUsername}.` });
  });

  // Admin Delete Account
  socket.on('admin delete user', (targetUser, callback) => {
    if (!socket.data.isAdmin) return callback({ success: false, message: 'Unauthorized' });
    const cleanUsername = targetUser.toLowerCase().trim();

    if (cleanUsername === ADMIN_USERNAME) {
      return callback({ success: false, message: 'Cannot delete the primary Admin account.' });
    }

    if (!users[cleanUsername]) {
      return callback({ success: false, message: 'User account not found.' });
    }

    delete users[cleanUsername];

    // Disconnect active socket if online
    const targetSocketId = activeSockets[cleanUsername];
    if (targetSocketId) {
      const targetSocket = io.sockets.sockets.get(targetSocketId);
      if (targetSocket) {
        targetSocket.emit('kicked', 'Your account was removed by the Admin.');
        targetSocket.disconnect();
      }
      delete activeSockets[cleanUsername];
    }

    callback({ success: true, message: `Account @${cleanUsername} has been permanently deleted.` });
  });

  // Admin Kick User
  socket.on('admin kick user', (targetUser, callback) => {
    if (!socket.data.isAdmin) return callback({ success: false, message: 'Unauthorized' });
    const cleanUsername = targetUser.toLowerCase().trim();

    if (cleanUsername === ADMIN_USERNAME) return callback({ success: false, message: 'Cannot kick Admin.' });

    const targetSocketId = activeSockets[cleanUsername];
    if (targetSocketId) {
      const targetSocket = io.sockets.sockets.get(targetSocketId);
      if (targetSocket) {
        targetSocket.emit('kicked', 'You have been kicked by the Admin.');
        targetSocket.disconnect();
      }
      delete activeSockets[cleanUsername];
      return callback({ success: true });
    }
    callback({ success: false, message: 'User is not currently online.' });
  });

  // Admin Ban User
  socket.on('admin ban user', (targetUser, callback) => {
    if (!socket.data.isAdmin) return callback({ success: false, message: 'Unauthorized' });
    const cleanUsername = targetUser.toLowerCase().trim();

    if (cleanUsername === ADMIN_USERNAME) return callback({ success: false, message: 'Cannot ban Admin.' });

    bannedUsers.add(cleanUsername);

    const targetSocketId = activeSockets[cleanUsername];
    if (targetSocketId) {
      const targetSocket = io.sockets.sockets.get(targetSocketId);
      if (targetSocket) {
        targetSocket.emit('kicked', 'Your account has been banned by the Admin.');
        targetSocket.disconnect();
      }
      delete activeSockets[cleanUsername];
    }
    callback({ success: true });
  });

  // Admin Unban User
  socket.on('admin unban user', (targetUser, callback) => {
    if (!socket.data.isAdmin) return callback({ success: false, message: 'Unauthorized' });
    const cleanUsername = targetUser.toLowerCase().trim();
    bannedUsers.delete(cleanUsername);
    callback({ success: true });
  });

  // Admin Clear Room Message History
  socket.on('admin clear messages', (roomName, callback) => {
    if (!socket.data.isAdmin) return callback({ success: false, message: 'Unauthorized' });
    if (messageHistory[roomName]) {
      messageHistory[roomName] = [];
      io.to(roomName).emit('chat cleared');
      callback({ success: true });
    } else {
      callback({ success: false, message: 'Group room not found.' });
    }
  });

  socket.on('disconnect', () => {
    const room = socket.data.currentRoom;
    const username = socket.data.username;
    const displayName = socket.data.displayName;

    if (username) delete activeSockets[username];

    if (room && username) {
      const disconnectMsg = { 
        username: 'System', 
        displayName: 'System', 
        text: `${displayName} has left ${room}.`, 
        system: true 
      };
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
