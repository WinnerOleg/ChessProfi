// frontend/src/App.js
// Главный компонент приложения ChessProfi
import React, { useState, useEffect } from 'react';
import { BrowserRouter as Router, Route, Routes, Navigate } from 'react-router-dom';
import './styles/App.css';

// Импортируем страницы
import Home from './pages/Home';
import Login from './pages/Login';
import Game from './pages/Game';
import Dashboard from './pages/Dashboard';
import Navigation from './components/Navigation';

function App() {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  // Проверяем, есть ли сохраненный токен при загрузке
  useEffect(() => {
    const token = localStorage.getItem('token');
    const userData = localStorage.getItem('user');
    
    if (token && userData) {
      setUser(JSON.parse(userData));
    }
    setLoading(false);
  }, []);

  // Функция для входа
  const handleLogin = (userData, token) => {
    localStorage.setItem('token', token);
    localStorage.setItem('user', JSON.stringify(userData));
    setUser(userData);
  };

  // Функция для выхода
  const handleLogout = () => {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    setUser(null);
  };

  if (loading) {
    return <div className="loading">Загрузка ChessProfi...</div>;
  }

  return (
    <Router>
      <div className="App">
        <Navigation user={user} onLogout={handleLogout} />
        
        <main className="main-content">
          <Routes>
            <Route path="/" element={<Home />} />
            <Route 
              path="/login" 
              element={user ? <Navigate to="/dashboard" /> : <Login onLogin={handleLogin} />} 
            />
            <Route 
              path="/dashboard" 
              element={user ? <Dashboard user={user} /> : <Navigate to="/login" />} 
            />
            <Route 
              path="/game/:gameId" 
              element={user ? <Game user={user} /> : <Navigate to="/login" />} 
            />
          </Routes>
        </main>
        
        <footer className="footer">
          <p>© 2024 ChessProfi - Платформа для обучения шахматам</p>
        </footer>
      </div>
    </Router>
  );
}

export default App;

// frontend/src/index.js
// Точка входа React приложения
import React from 'react';
import ReactDOM from 'react-dom/client';
import './styles/App.css';
import App from './App';

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

// frontend/src/pages/Home.js
// Главная страница
import React from 'react';
import { Link } from 'react-router-dom';

function Home() {
  return (
    <div className="home-page">
      <div className="hero-section">
        <h1>Добро пожаловать в ChessProfi</h1>
        <p className="subtitle">
          Современная платформа для обучения шахматам с персональными тренерами
        </p>
        
        <div className="features">
          <div className="feature-card">
            <h3>🎯 Персональные уроки</h3>
            <p>Занимайтесь с опытными тренерами в реальном времени</p>
          </div>
          
          <div className="feature-card">
            <h3>📊 Анализ партий</h3>
            <p>Получайте детальный разбор ваших игр с рекомендациями</p>
          </div>
          
          <div className="feature-card">
            <h3>🏆 Отслеживание прогресса</h3>
            <p>Следите за своим развитием и достигайте новых высот</p>
          </div>
        </div>
        
        <div className="cta-buttons">
          <Link to="/login" className="btn btn-primary">
            Начать обучение
          </Link>
          <Link to="/login" className="btn btn-secondary">
            Войти в систему
          </Link>
        </div>
      </div>
    </div>
  );
}

export default Home;

// frontend/src/pages/Login.js
// Страница входа и регистрации
import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../services/api';

function Login({ onLogin }) {
  const [isLogin, setIsLogin] = useState(true);
  const [formData, setFormData] = useState({
    email: '',
    password: '',
    name: '',
    role: 'student'
  });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  const handleChange = (e) => {
    setFormData({
      ...formData,
      [e.target.name]: e.target.value
    });
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const endpoint = isLogin ? '/auth/login' : '/auth/register';
      const response = await api.post(endpoint, formData);
      
      onLogin(response.data.user, response.data.token);
      navigate('/dashboard');
    } catch (err) {
      setError(err.response?.data?.error || 'Произошла ошибка');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-page">
      <div className="login-container">
        <h2>{isLogin ? 'Вход в ChessProfi' : 'Регистрация в ChessProfi'}</h2>
        
        {error && <div className="error-message">{error}</div>}
        
        <form onSubmit={handleSubmit}>
          {!isLogin && (
            <div className="form-group">
              <label>Имя</label>
              <input
                type="text"
                name="name"
                value={formData.name}
                onChange={handleChange}
                required={!isLogin}
                placeholder="Ваше имя"
              />
            </div>
          )}
          
          <div className="form-group">
            <label>Email</label>
            <input
              type="email"
              name="email"
              value={formData.email}
              onChange={handleChange}
              required
              placeholder="email@example.com"
            />
          </div>
          
          <div className="form-group">
            <label>Пароль</label>
            <input
              type="password"
              name="password"
              value={formData.password}
              onChange={handleChange}
              required
              placeholder="Минимум 6 символов"
            />
          </div>
          
          {!isLogin && (
            <div className="form-group">
              <label>Роль</label>
              <select name="role" value={formData.role} onChange={handleChange}>
                <option value="student">Ученик</option>
                <option value="coach">Тренер</option>
              </select>
            </div>
          )}
          
          <button type="submit" className="btn btn-primary" disabled={loading}>
            {loading ? 'Загрузка...' : (isLogin ? 'Войти' : 'Зарегистрироваться')}
          </button>
        </form>
        
        <p className="toggle-form">
          {isLogin ? 'Нет аккаунта?' : 'Уже есть аккаунт?'}
          <button onClick={() => setIsLogin(!isLogin)} className="link-button">
            {isLogin ? 'Зарегистрироваться' : 'Войти'}
          </button>
        </p>
      </div>
    </div>
  );
}

export default Login;

// frontend/src/pages/Dashboard.js
// Личный кабинет пользователя
import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import api from '../services/api';
import GameList from '../components/GameList';

function Dashboard({ user }) {
  const [games, setGames] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchGames();
  }, []);

  const fetchGames = async () => {
    try {
      const response = await api.get('/games/my-games');
      setGames(response.data);
    } catch (error) {
      console.error('Ошибка загрузки игр:', error);
    } finally {
      setLoading(false);
    }
  };

  const createNewGame = async () => {
    try {
      // В реальном приложении здесь был бы выбор противника
      const response = await api.post('/games/create', {
        opponentId: '507f1f77bcf86cd799439011' // Временный ID для демо
      });
      
      // Переходим к новой игре
      window.location.href = `/game/${response.data._id}`;
    } catch (error) {
      console.error('Ошибка создания игры:', error);
    }
  };

  return (
    <div className="dashboard-page">
      <div className="dashboard-header">
        <h1>Личный кабинет</h1>
        <div className="user-info">
          <h2>Привет, {user.name}!</h2>
          <p>Роль: {user.role === 'student' ? 'Ученик' : 'Тренер'}</p>
          <p>Рейтинг: {user.rating}</p>
        </div>
      </div>

      <div className="dashboard-content">
        <div className="actions-section">
          <button onClick={createNewGame} className="btn btn-primary">
            Начать новую игру
          </button>
        </div>

        <div className="games-section">
          <h3>Мои партии</h3>
          {loading ? (
            <p>Загрузка партий...</p>
          ) : games.length > 0 ? (
            <GameList games={games} currentUserId={user.id} />
          ) : (
            <p>У вас пока нет сыгранных партий</p>
          )}
        </div>
      </div>
    </div>
  );
}

export default Dashboard;

// frontend/src/services/api.js
// Сервис для работы с API
import axios from 'axios';

const API_URL = process.env.REACT_APP_API_URL || 'http://localhost:5000/api';

// Создаем экземпляр axios с базовыми настройками
const api = axios.create({
  baseURL: API_URL,
  headers: {
    'Content-Type': 'application/json'
  }
});

// Добавляем токен к каждому запросу, если он есть
api.interceptors.request.use(
  (config) => {
    const token = localStorage.getItem('token');
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
  },
  (error) => {
    return Promise.reject(error);
  }
);

// Обработка ошибок ответа
api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      // Токен истек или невалидный - выходим
      localStorage.removeItem('token');
      localStorage.removeItem('user');
      window.location.href = '/login';
    }
    return Promise.reject(error);
  }
);

export default api;