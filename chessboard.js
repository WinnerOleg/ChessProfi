// frontend/src/components/ChessBoard.js
// Компонент шахматной доски - сердце нашего приложения
import React, { useState, useEffect } from 'react';
import { Chess } from 'chess.js';

// Начальная позиция фигур
const initialBoard = [
  ['r', 'n', 'b', 'q', 'k', 'b', 'n', 'r'],
  ['p', 'p', 'p', 'p', 'p', 'p', 'p', 'p'],
  [null, null, null, null, null, null, null, null],
  [null, null, null, null, null, null, null, null],
  [null, null, null, null, null, null, null, null],
  [null, null, null, null, null, null, null, null],
  ['P', 'P', 'P', 'P', 'P', 'P', 'P', 'P'],
  ['R', 'N', 'B', 'Q', 'K', 'B', 'N', 'R']
];

// Символы фигур для отображения
const pieceSymbols = {
  'K': '♔', 'Q': '♕', 'R': '♖', 'B': '♗', 'N': '♘', 'P': '♙',
  'k': '♚', 'q': '♛', 'r': '♜', 'b': '♝', 'n': '♞', 'p': '♟'
};

function ChessBoard({ gameId, onMove, currentFen, isMyTurn }) {
  const [chess] = useState(new Chess());
  const [board, setBoard] = useState(initialBoard);
  const [selectedSquare, setSelectedSquare] = useState(null);
  const [possibleMoves, setPossibleMoves] = useState([]);
  const [lastMove, setLastMove] = useState(null);

  // Обновляем доску при изменении FEN
  useEffect(() => {
    if (currentFen) {
      chess.load(currentFen);
      updateBoardFromChess();
    }
  }, [currentFen]);

  // Преобразуем состояние chess.js в наш формат доски
  const updateBoardFromChess = () => {
    const newBoard = Array(8).fill(null).map(() => Array(8).fill(null));
    
    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 8; col++) {
        const square = String.fromCharCode(97 + col) + (8 - row);
        const piece = chess.get(square);
        if (piece) {
          newBoard[row][col] = piece.color === 'w' ? piece.type.toUpperCase() : piece.type;
        }
      }
    }
    
    setBoard(newBoard);
  };

  // Обработка клика по клетке
  const handleSquareClick = (row, col) => {
    if (!isMyTurn) return;

    const square = String.fromCharCode(97 + col) + (8 - row);
    
    // Если клетка уже выбрана
    if (selectedSquare) {
      // Пытаемся сделать ход
      const move = tryMove(selectedSquare, square);
      if (move) {
        // Ход успешен
        setLastMove({ from: selectedSquare, to: square });
        onMove(move, chess.fen());
      }
      
      // Сбрасываем выбор
      setSelectedSquare(null);
      setPossibleMoves([]);
    } else {
      // Выбираем новую клетку
      const piece = chess.get(square);
      if (piece && piece.color === chess.turn()) {
        setSelectedSquare(square);
        
        // Показываем возможные ходы
        const moves = chess.moves({ square, verbose: true });
        setPossibleMoves(moves.map(m => m.to));
      }
    }
  };

  // Попытка сделать ход
  const tryMove = (from, to) => {
    try {
      const move = chess.move({ from, to, promotion: 'q' }); // Автопревращение в ферзя
      if (move) {
        updateBoardFromChess();
        return move;
      }
    } catch (e) {
      // Невозможный ход
    }
    return null;
  };

  // Определяем цвет клетки
  const getSquareColor = (row, col) => {
    return (row + col) % 2 === 0 ? 'light' : 'dark';
  };

  // Определяем класс клетки
  const getSquareClass = (row, col) => {
    const square = String.fromCharCode(97 + col) + (8 - row);
    let classes = ['square', getSquareColor(row, col)];
    
    if (selectedSquare === square) {
      classes.push('selected');
    }
    
    if (possibleMoves.includes(square)) {
      classes.push('possible-move');
    }
    
    if (lastMove && (lastMove.from === square || lastMove.to === square)) {
      classes.push('last-move');
    }
    
    return classes.join(' ');
  };

  return (
    <div className="chessboard-container">
      <div className="chessboard">
        {board.map((row, rowIndex) => (
          <div key={rowIndex} className="board-row">
            {row.map((piece, colIndex) => (
              <div
                key={`${rowIndex}-${colIndex}`}
                className={getSquareClass(rowIndex, colIndex)}
                onClick={() => handleSquareClick(rowIndex, colIndex)}
              >
                {piece && (
                  <span className="piece">
                    {pieceSymbols[piece]}
                  </span>
                )}
              </div>
            ))}
          </div>
        ))}
      </div>
      
      <div className="board-info">
        <p>Ход: {chess.turn() === 'w' ? 'Белые' : 'Черные'}</p>
        {chess.isCheck() && <p className="check">Шах!</p>}
        {chess.isCheckmate() && <p className="checkmate">Мат!</p>}
        {chess.isDraw() && <p className="draw">Ничья!</p>}
      </div>
    </div>
  );
}

export default ChessBoard;

// frontend/src/pages/Game.js
// Страница игры с WebSocket подключением
import React, { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import io from 'socket.io-client';
import ChessBoard from '../components/ChessBoard';
import api from '../services/api';

function Game({ user }) {
  const { gameId } = useParams();
  const [game, setGame] = useState(null);
  const [socket, setSocket] = useState(null);
  const [currentFen, setCurrentFen] = useState(null);
  const [isMyTurn, setIsMyTurn] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Загружаем данные игры
    loadGame();
    
    // Подключаемся к WebSocket
    const newSocket = io(process.env.REACT_APP_WS_URL || 'http://localhost:5000');
    setSocket(newSocket);

    // Присоединяемся к комнате игры
    newSocket.emit('join-game', gameId);

    // Слушаем события игры
    newSocket.on('game-state', (gameState) => {
      setCurrentFen(gameState.fen);
    });

    newSocket.on('move-made', ({ move, fen }) => {
      setCurrentFen(fen);
      updateTurn(fen);
    });

    // Очистка при размонтировании
    return () => {
      newSocket.disconnect();
    };
  }, [gameId]);

  const loadGame = async () => {
    try {
      const response = await api.get(`/games/${gameId}`);
      setGame(response.data);
      setCurrentFen(response.data.fen);
      updateTurn(response.data.fen);
      setLoading(false);
    } catch (error) {
      console.error('Ошибка загрузки игры:', error);
      setLoading(false);
    }
  };

  const updateTurn = (fen) => {
    // Определяем, чей сейчас ход
    const fenParts = fen.split(' ');
    const currentTurn = fenParts[1]; // 'w' или 'b'
    
    if (game) {
      const isWhite = game.white._id === user.id;
      setIsMyTurn((currentTurn === 'w' && isWhite) || (currentTurn === 'b' && !isWhite));
    }
  };

  const handleMove = (move, fen) => {
    // Отправляем ход через WebSocket
    if (socket) {
      socket.emit('make-move', { gameId, move, fen });
    }
  };

  if (loading) {
    return <div className="loading">Загрузка игры...</div>;
  }

  if (!game) {
    return <div className="error">Игра не найдена</div>;
  }

  return (
    <div className="game-page">
      <div className="game-header">
        <h2>Партия #{gameId.slice(-6)}</h2>
        <div className="players">
          <div className="player white">
            <span className="player-name">{game.white.name}</span>
            <span className="player-rating">({game.white.rating})</span>
          </div>
          <span className="vs">VS</span>
          <div className="player black">
            <span className="player-name">{game.black.name}</span>
            <span className="player-rating">({game.black.rating})</span>
          </div>
        </div>
      </div>

      <div className="game-content">
        <ChessBoard
          gameId={gameId}
          onMove={handleMove}
          currentFen={currentFen}
          isMyTurn={isMyTurn}
        />
        
        <div className="game-sidebar">
          <div className="move-history">
            <h3>История ходов</h3>
            {game.moves && game.moves.length > 0 ? (
              <ol>
                {game.moves.map((move, index) => (
                  <li key={index}>{move.notation}</li>
                ))}
              </ol>
            ) : (
              <p>Ходов пока нет</p>
            )}
          </div>
          
          <div className="game-controls">
            <button className="btn btn-secondary">Предложить ничью</button>
            <button className="btn btn-danger">Сдаться</button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default Game;

// frontend/src/components/Navigation.js
// Компонент навигации
import React from 'react';
import { Link } from 'react-router-dom';

function Navigation({ user, onLogout }) {
  return (
    <nav className="navigation">
      <div className="nav-container">
        <Link to="/" className="logo">
          ♔ ChessProfi
        </Link>
        
        <div className="nav-links">
          <Link to="/">Главная</Link>
          {user ? (
            <>
              <Link to="/dashboard">Личный кабинет</Link>
              <span className="user-name">Привет, {user.name}!</span>
              <button onClick={onLogout} className="btn-logout">
                Выйти
              </button>
            </>
          ) : (
            <Link to="/login" className="btn btn-primary">
              Войти
            </Link>
          )}
        </div>
      </div>
    </nav>
  );
}

export default Navigation;

// frontend/src/components/GameList.js
// Компонент списка игр
import React from 'react';
import { Link } from 'react-router-dom';

function GameList({ games, currentUserId }) {
  const formatDate = (date) => {
    return new Date(date).toLocaleDateString('ru-RU', {
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit'
    });
  };

  const getOpponent = (game) => {
    return game.white._id === currentUserId ? game.black : game.white;
  };

  const getResult = (game) => {
    if (game.status !== 'completed') return 'В процессе';
    
    if (game.result === '1-0') {
      return game.white._id === currentUserId ? 'Победа' : 'Поражение';
    } else if (game.result === '0-1') {
      return game.black._id === currentUserId ? 'Победа' : 'Поражение';
    } else if (game.result === '1/2-1/2') {
      return 'Ничья';
    }
    
    return 'Не завершена';
  };

  return (
    <div className="game-list">
      {games.map((game) => {
        const opponent = getOpponent(game);
        const result = getResult(game);
        
        return (
          <Link to={`/game/${game._id}`} key={game._id} className="game-item">
            <div className="game-info">
              <span className="opponent">{opponent.name} ({opponent.rating})</span>
              <span className="date">{formatDate(game.startedAt)}</span>
            </div>
            <div className={`game-result ${result.toLowerCase()}`}>
              {result}
            </div>
          </Link>
        );
      })}
    </div>
  );
}

export default GameList;