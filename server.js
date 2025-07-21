const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const mongoose = require('mongoose');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid'); 
require('dotenv').config(); 

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Middleware
app.use(cors());
app.use(express.json());

// MongoDB connection
const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/chatapp';

mongoose.connect(MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
})
.then(() => {
  console.log(`✅ Connected to MongoDB: ${MONGO_URI.includes('mongodb+srv') ? 'Atlas' : 'Local'}`);
})
.catch((err) => {
  console.error('❌ MongoDB connection error:', err);
});

// MongoDB Models
const UserSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  socketId: String,
  isOnline: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now }
});

const RoomSchema = new mongoose.Schema({
  name: { type: String, required: true, unique: true },
  roomId: { type: String, required: true, unique: true }, // 👈 Added roomId field
  createdAt: { type: Date, default: Date.now }
});

const MessageSchema = new mongoose.Schema({
  room: { type: String, required: true },
  username: { type: String, required: true },
  message: { type: String, required: true },
  timestamp: { type: Date, default: Date.now }
});

const User = mongoose.model('User', UserSchema);
const Room = mongoose.model('Room', RoomSchema);
const Message = mongoose.model('Message', MessageSchema);

// Store active users
let activeUsers = {};

// REST API Routes
app.get('/api/rooms', async (req, res) => {
  try {
    const rooms = await Room.find().sort({ createdAt: -1 });
    res.json(rooms);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/rooms', async (req, res) => {
  try {
    const { name } = req.body;
    const existingRoom = await Room.findOne({ name });
    if (existingRoom) {
      return res.status(400).json({ error: 'Room already exists' });
    }

    const room = new Room({
      name,
      roomId: uuidv4() // 👈 Generate unique roomId
    });

    await room.save();
    res.json(room);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/messages/:room', async (req, res) => {
  try {
    const { room } = req.params;
    const messages = await Message.find({ room }).sort({ timestamp: 1 });
    res.json(messages);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Socket.io connection handling
io.on('connection', (socket) => {
  console.log('New client connected:', socket.id);

  // Join room
  socket.on('joinRoom', async (data) => {
    const { username, room } = data;

    try {
      await User.findOneAndUpdate(
        { username },
        { socketId: socket.id, isOnline: true },
        { upsert: true, new: true }
      );

      socket.join(room);
      socket.username = username;
      socket.currentRoom = room;

      if (!activeUsers[room]) {
        activeUsers[room] = {};
      }
      activeUsers[room][username] = socket.id;

      const messages = await Message.find({ room }).sort({ timestamp: 1 });
      socket.emit('chatHistory', messages);

      const onlineUsers = Object.keys(activeUsers[room] || {});
      io.to(room).emit('onlineUsers', onlineUsers);

      socket.to(room).emit('userJoined', `${username} joined the room`);
      console.log(`${username} joined room: ${room}`);
    } catch (error) {
      console.error('Error joining room:', error);
      socket.emit('error', 'Failed to join room');
    }
  });

  // Handle chat messages
  socket.on('chatMessage', async (data) => {
    const { room, username, message } = data;

    if (!message.trim()) return;

    try {
      const newMessage = new Message({
        room,
        username,
        message,
        timestamp: new Date()
      });
      await newMessage.save();

      io.to(room).emit('message', {
        username,
        message,
        timestamp: newMessage.timestamp
      });

      console.log(`Message from ${username} in ${room}: ${message}`);
    } catch (error) {
      console.error('Error saving message:', error);
      socket.emit('error', 'Failed to send message');
    }
  });

  // Handle typing indicator
  socket.on('typing', (data) => {
    const { room, username, isTyping } = data;
    socket.to(room).emit('userTyping', { username, isTyping });
  });

  // Handle disconnect
  socket.on('disconnect', async () => {
    console.log('Client disconnected:', socket.id);

    if (socket.username && socket.currentRoom) {
      try {
        await User.findOneAndUpdate(
          { username: socket.username },
          { isOnline: false, socketId: null }
        );

        if (activeUsers[socket.currentRoom] && activeUsers[socket.currentRoom][socket.username]) {
          delete activeUsers[socket.currentRoom][socket.username];

          if (Object.keys(activeUsers[socket.currentRoom]).length === 0) {
            delete activeUsers[socket.currentRoom];
          }
        }

        const onlineUsers = Object.keys(activeUsers[socket.currentRoom] || {});
        io.to(socket.currentRoom).emit('onlineUsers', onlineUsers);

        socket.to(socket.currentRoom).emit('userLeft', `${socket.username} left the room`);
      } catch (error) {
        console.error('Error handling disconnect:', error);
      }
    }
  });

  // Handle leave room
  socket.on('leaveRoom', async (data) => {
    const { username, room } = data;

    socket.leave(room);

    if (activeUsers[room] && activeUsers[room][username]) {
      delete activeUsers[room][username];

      if (Object.keys(activeUsers[room]).length === 0) {
        delete activeUsers[room];
      }
    }

    const onlineUsers = Object.keys(activeUsers[room] || {});
    io.to(room).emit('onlineUsers', onlineUsers);

    socket.to(room).emit('userLeft', `${username} left the room`);
  });
});

const PORT = process.env.PORT || 5000;

server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
