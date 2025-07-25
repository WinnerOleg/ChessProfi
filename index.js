// backend/src/index.js
// Главный файл сервера ChessProfi
const express = require('express');
const cors = require('cors');
const http = require('http');
const socketIo = require('socket.io');
const mongoose = require('mongoose');
const dotenv = require('dotenv');

// Загружаем переменные окружения
dotenv.config();

// Импортируем маршруты
const authRoutes = require('./routes/auth');
const gamesRoutes = require('./routes/games');
const analysisRoutes = require('./routes/analysis');

// Создаем Express приложение
const app = express();
const server = http.createServer(app);

// Настраиваем Socket.IO для реал-тайм функционала
const io = socketIo(server, {
  cors: {
    origin: process.env.FRONTEND_URL || 'http://localhost:3000',
    credentials: true
  }
});

// Middleware
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  credentials: true
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Подключение к MongoDB
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/chessprofi', {
  useNewUrlParser: true,
  useUnifiedTopology: true
})
.then(() => console.log('✅ MongoDB подключена'))
.catch(err => console.error('❌ Ошибка подключения к MongoDB:', err));

// API маршруты
app.use('/api/auth', authRoutes);
app.use('/api/games', gamesRoutes);
app.use('/api/analysis', analysisRoutes);

// Базовый маршрут для проверки работы сервера
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    message: 'ChessProfi сервер работает',
    timestamp: new Date().toISOString()
  });
});

// Socket.IO для реал-тайм игр
const activeGames = new Map(); // Хранение активных игр в памяти

io.on('connection', (socket) => {
  console.log('🔌 Новое подключение:', socket.id);

  // Присоединение к игре
  socket.on('join-game', (gameId) => {
    socket.join(gameId);
    console.log(`Игрок ${socket.id} присоединился к игре ${gameId}`);
    
    // Отправляем текущее состояние игры
    const game = activeGames.get(gameId);
    if (game) {
      socket.emit('game-state', game);
    }
  });

  // Обработка хода
  socket.on('make-move', ({ gameId, move, fen }) => {
    console.log(`Ход в игре ${gameId}:`, move);
    
    // Обновляем состояние игры
    let game = activeGames.get(gameId);
    if (!game) {
      game = { moves: [], fen };
      activeGames.set(gameId, game);
    }
    
    game.moves.push(move);
    game.fen = fen;
    
    // Отправляем ход всем участникам игры
    io.to(gameId).emit('move-made', { move, fen });
  });

  // Отключение
  socket.on('disconnect', () => {
    console.log('👋 Отключение:', socket.id);
  });
});

// Обработка ошибок
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ 
    error: 'Что-то пошло не так!',
    message: err.message 
  });
});

// Запуск сервера
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`🚀 ChessProfi сервер запущен на порту ${PORT}`);
  console.log(`📡 WebSocket сервер готов к подключениям`);
});

// backend/src/routes/auth.js
// Маршруты аутентификации
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const User = require('../models/User');

const router = express.Router();

// Регистрация
router.post('/register', async (req, res) => {
  try {
    const { email, password, name, role } = req.body;

    // Проверяем, существует ли пользователь
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({ error: 'Пользователь уже существует' });
    }

    // Хешируем пароль
    const hashedPassword = await bcrypt.hash(password, 10);

    // Создаем пользователя
    const user = new User({
      email,
      password: hashedPassword,
      name,
      role: role || 'student'
    });

    await user.save();

    // Создаем JWT токен
    const token = jwt.sign(
      { userId: user._id, email: user.email, role: user.role },
      process.env.JWT_SECRET || 'secret',
      { expiresIn: '7d' }
    );

    res.status(201).json({
      message: 'Регистрация успешна',
      token,
      user: {
        id: user._id,
        email: user.email,
        name: user.name,
        role: user.role
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Вход
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    // Находим пользователя
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(401).json({ error: 'Неверные учетные данные' });
    }

    // Проверяем пароль
    const isValidPassword = await bcrypt.compare(password, user.password);
    if (!isValidPassword) {
      return res.status(401).json({ error: 'Неверные учетные данные' });
    }

    // Создаем токен
    const token = jwt.sign(
      { userId: user._id, email: user.email, role: user.role },
      process.env.JWT_SECRET || 'secret',
      { expiresIn: '7d' }
    );

    res.json({
      message: 'Вход выполнен успешно',
      token,
      user: {
        id: user._id,
        email: user.email,
        name: user.name,
        role: user.role,
        rating: user.rating
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;

// backend/src/models/User.js
// Модель пользователя
const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  email: {
    type: String,
    required: true,
    unique: true,
    lowercase: true
  },
  password: {
    type: String,
    required: true
  },
  name: {
    type: String,
    required: true
  },
  role: {
    type: String,
    enum: ['student', 'coach', 'admin'],
    default: 'student'
  },
  rating: {
    type: Number,
    default: 1200
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

module.exports = mongoose.model('User', userSchema);

// backend/src/models/Game.js
// Модель игры
const mongoose = require('mongoose');

const gameSchema = new mongoose.Schema({
  white: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  black: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  pgn: {
    type: String,
    default: ''
  },
  fen: {
    type: String,
    default: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'
  },
  status: {
    type: String,
    enum: ['active', 'completed', 'abandoned'],
    default: 'active'
  },
  result: {
    type: String,
    enum: ['1-0', '0-1', '1/2-1/2', '*'],
    default: '*'
  },
  moves: [{
    notation: String,
    fen: String,
    timestamp: Date
  }],
  startedAt: {
    type: Date,
    default: Date.now
  },
  endedAt: Date
});

module.exports = mongoose.model('Game', gameSchema);