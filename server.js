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

setInterval(() => {
  https.get('https://text-p3e7.onrender.com/', (res) => {
    console.log('Self-ping sent to maintain Render instance.');
  }).on('error', (err) => {
    console.error('Self-ping error:', err.message);
  });
}, 10 * 60 * 1000);

const ADMIN_USERNAME = "admin";
const ADMIN_DISPLAY = "Meelad Mohammad";
const ADMIN_PASS = "@Meelad@786@786";
const ADMIN_EMAIL = "mohammad.milad.stu@almustafaacademy.ca";

// Users database
const users = {
  [ADMIN_USERNAME]: { 
    password: ADMIN_PASS, 
    email: ADMIN_EMAIL, 
    displayName: ADMIN_DISPLAY 
  }
};

const pendingVerifications = {};
const bannedUsers = new Set();
const activeSockets = {}; // { username: socketId }

const rooms = {
  "International Talk": { password: null, owner: "System" }
};

const messageHistory = {
  "International Talk": []
};

// Saved feedback store across admin offline/online sessions
const feedbackStore = [];

app.get('/', (req, res) => {
  res.send('Easy Chat Backend is Running');
});

io.on('connection', (socket) => {

  // Step 1: Request Verification Code
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
      return callback({ success: false, message: 'This username is currently banned.' });
    }

    if (users[cleanUsername]) {
      return callback({ success: false, message: 'Username is already taken.' });
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
        message: `[TEST MODE] Code generated! (Check Render logs if RESEND_API_KEY is missing).` 
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
              <h2 style="color: #075e54;">Easy Chat Verification</h2>
              <p>Hello <b>${displayName}</b> (@${cleanUsername}),</p>
              <p>Your verification code is:</p>
              <h1 style="color: #25d366; letter-spacing: 5px;">${code}</h1>
            </div>
          `
        })
      });

      if (response.ok) {
        callback({ success: true, message: 'Verification code sent to your email!' });
      } else {
        const errData = await response.json();
        console.error('Resend error:', errData);
        callback({ success: false, message: 'Failed to send verification email.' });
      }
    } catch (error) {
      console.error('Fetch error:', error);
      callback({ success: false, message: 'Email service connection error.' });
    }
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
      displayName: pending.displayName
    };

    delete pendingVerifications[email];
    callback({ success: true, message: 'Account verified successfully! You can now log into Easy Chat.' });
  });

  // Login Event
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

  // User Feedback Event
  socket.on('send admin message', (msgText, callback) => {
    const username = socket.data.username;
    const displayName = socket.data.displayName;

    if (!username) return callback({ success: false, message: 'Must be logged in.' });
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

    callback({ success: true, message: 'Feedback sent directly to Admin!', msgData });
  });

  // Admin Reply to Feedback Event
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

  socket.on('join room', ({ roomName, roomPassword }, callback) => {
    const username = socket.data.username;
    const displayName = socket.data.displayName;

    if (!username) return callback({ success: false, message: 'Must be logged in.' });

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

  socket.on('chat message', (msgText) => {
    const room = socket.data.currentRoom;
    const username = socket.data.username;
    const displayName = socket.data.displayName;

    if (!room || !username || bannedUsers.has(username)) return;

    const msgData = { username, displayName, text: msgText, senderId: socket.id, system: false };
    saveMessage(room, msgData);
    io.to(room).emit('chat message', msgData);
  });

  // Get Admin Data Overview
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

  // Admin Account Management
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

  socket.on('admin unban user', (targetUser, callback) => {
    if (!socket.data.isAdmin) return callback({ success: false, message: 'Unauthorized' });
    const cleanUsername = targetUser.toLowerCase().trim();
    bannedUsers.delete(cleanUsername);
    callback({ success: true });
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
