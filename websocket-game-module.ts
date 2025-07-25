// src/modules/games/games.gateway.ts
import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
  OnGatewayConnection,
  OnGatewayDisconnect,
  WsException,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { UseGuards } from '@nestjs/common';
import { GamesService } from './games.service';
import { WsJwtGuard } from '../auth/guards/ws-jwt.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Chess } from 'chess.js';
import { RedisService } from '../../database/redis.service';

interface GameRoom {
  gameId: string;
  studentId: string;
  coachId: string;
  chess: Chess;
  lastActivity: Date;
}

@WebSocketGateway({
  namespace: 'games',
  cors: {
    origin: process.env.ALLOWED_ORIGINS?.split(',') || ['http://localhost:3000'],
    credentials: true,
  },
})
@UseGuards(WsJwtGuard)
export class GamesGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  // In-memory game state for active sessions
  private activeGames = new Map<string, GameRoom>();
  
  constructor(
    private gamesService: GamesService,
    private redisService: RedisService,
  ) {
    // Sync game state across instances every 5 seconds
    setInterval(() => this.syncGameState(), 5000);
  }

  async handleConnection(client: Socket) {
    console.log(`Client connected: ${client.id}`);
    // Authentication is handled by the guard
  }

  async handleDisconnect(client: Socket) {
    console.log(`Client disconnected: ${client.id}`);
    // Remove client from all rooms
    const rooms = Array.from(client.rooms);
    rooms.forEach(room => {
      if (room !== client.id) {
        this.handleLeaveGame(client, room);
      }
    });
  }

  @SubscribeMessage('joinGame')
  async handleJoinGame(
    @MessageBody() data: { gameId: string },
    @ConnectedSocket() client: Socket,
    @CurrentUser() user: any,
  ) {
    try {
      // Verify user has access to this game
      const game = await this.gamesService.findOne(data.gameId);
      if (!game || (game.studentId !== user.userId && game.coachId !== user.userId)) {
        throw new WsException('Unauthorized access to game');
      }

      // Join the room
      await client.join(data.gameId);

      // Initialize or retrieve game state
      let gameRoom = this.activeGames.get(data.gameId);
      if (!gameRoom) {
        const chess = new Chess();
        if (game.fen) {
          chess.load(game.fen);
        }
        
        gameRoom = {
          gameId: data.gameId,
          studentId: game.studentId,
          coachId: game.coachId,
          chess,
          lastActivity: new Date(),
        };
        
        this.activeGames.set(data.gameId, gameRoom);
      }

      // Send current game state
      client.emit('gameState', {
        fen: gameRoom.chess.fen(),
        pgn: gameRoom.chess.pgn(),
        turn: gameRoom.chess.turn(),
        isCheck: gameRoom.chess.isCheck(),
        isCheckmate: gameRoom.chess.isCheckmate(),
        isDraw: gameRoom.chess.isDraw(),
        moveHistory: gameRoom.chess.history({ verbose: true }),
      });

      // Notify other participants
      client.to(data.gameId).emit('userJoined', {
        userId: user.userId,
        role: user.role,
      });

      return { success: true, message: 'Joined game successfully' };
    } catch (error) {
      console.error('Error joining game:', error);
      throw new WsException(error.message || 'Failed to join game');
    }
  }

  @SubscribeMessage('makeMove')
  async handleMakeMove(
    @MessageBody() data: { gameId: string; move: string; annotation?: string },
    @ConnectedSocket() client: Socket,
    @CurrentUser() user: any,
  ) {
    const startTime = Date.now();
    
    try {
      const gameRoom = this.activeGames.get(data.gameId);
      if (!gameRoom) {
        throw new WsException('Game not found');
      }

      // Validate it's the player's turn
      const isStudent = user.userId === gameRoom.studentId;
      const currentTurn = gameRoom.chess.turn();
      
      // For learning purposes, both student and coach can make moves
      // but we track who made each move
      
      // Attempt the move
      const move = gameRoom.chess.move(data.move);
      if (!move) {
        throw new WsException('Invalid move');
      }

      // Update last activity
      gameRoom.lastActivity = new Date();

      // Save move to database asynchronously
      const moveNumber = Math.ceil(gameRoom.chess.moveNumber() / 2);
      this.gamesService.saveMove({
        gameId: data.gameId,
        moveNumber,
        notation: move.san,
        fen: gameRoom.chess.fen(),
        annotation: data.annotation,
      }).catch(error => console.error('Error saving move:', error));

      // Broadcast move to all participants
      const moveData = {
        move: move.san,
        fen: gameRoom.chess.fen(),
        pgn: gameRoom.chess.pgn(),
        turn: gameRoom.chess.turn(),
        isCheck: gameRoom.chess.isCheck(),
        isCheckmate: gameRoom.chess.isCheckmate(),
        isDraw: gameRoom.chess.isDraw(),
        madeBy: user.userId,
        annotation: data.annotation,
        latency: Date.now() - startTime, // Track move latency
      };

      this.server.to(data.gameId).emit('moveMade', moveData);

      // Check for game end conditions
      if (gameRoom.chess.isGameOver()) {
        await this.handleGameEnd(data.gameId, gameRoom);
      }

      return { success: true, latency: moveData.latency };
    } catch (error) {
      console.error('Error making move:', error);
      throw new WsException(error.message || 'Failed to make move');
    }
  }

  @SubscribeMessage('undoMove')
  async handleUndoMove(
    @MessageBody() data: { gameId: string },
    @ConnectedSocket() client: Socket,
    @CurrentUser() user: any,
  ) {
    try {
      const gameRoom = this.activeGames.get(data.gameId);
      if (!gameRoom) {
        throw new WsException('Game not found');
      }

      // Only coaches can undo moves (for teaching purposes)
      if (user.role !== 'COACH' && user.userId !== gameRoom.coachId) {
        throw new WsException('Only coaches can undo moves');
      }

      const undone = gameRoom.chess.undo();
      if (!undone) {
        throw new WsException('No moves to undo');
      }

      // Update game state
      gameRoom.lastActivity = new Date();

      // Notify all participants
      this.server.to(data.gameId).emit('moveUndone', {
        fen: gameRoom.chess.fen(),
        pgn: gameRoom.chess.pgn(),
        turn: gameRoom.chess.turn(),
      });

      return { success: true };
    } catch (error) {
      console.error('Error undoing move:', error);
      throw new WsException(error.message || 'Failed to undo move');
    }
  }

  @SubscribeMessage('requestHint')
  async handleRequestHint(
    @MessageBody() data: { gameId: string },
    @ConnectedSocket() client: Socket,
    @CurrentUser() user: any,
  ) {
    try {
      const gameRoom = this.activeGames.get(data.gameId);
      if (!gameRoom) {
        throw new WsException('Game not found');
      }

      // Use the analysis service to get best moves
      const analysis = await this.gamesService.getPositionAnalysis(gameRoom.chess.fen());
      
      // Send hint only to the requesting user
      client.emit('hint', {
        bestMoves: analysis.bestMoves.slice(0, 3), // Top 3 moves
        evaluation: analysis.evaluation,
      });

      return { success: true };
    } catch (error) {
      console.error('Error getting hint:', error);
      throw new WsException(error.message || 'Failed to get hint');
    }
  }

  @SubscribeMessage('addAnnotation')
  async handleAddAnnotation(
    @MessageBody() data: { gameId: string; moveNumber: number; annotation: string },
    @ConnectedSocket() client: Socket,
    @CurrentUser() user: any,
  ) {
    try {
      // Only coaches can add annotations
      if (user.role !== 'COACH') {
        throw new WsException('Only coaches can add annotations');
      }

      await this.gamesService.updateMoveAnnotation(
        data.gameId,
        data.moveNumber,
        data.annotation,
      );

      // Broadcast annotation to all participants
      this.server.to(data.gameId).emit('annotationAdded', {
        moveNumber: data.moveNumber,
        annotation: data.annotation,
        author: user.userId,
      });

      return { success: true };
    } catch (error) {
      console.error('Error adding annotation:', error);
      throw new WsException(error.message || 'Failed to add annotation');
    }
  }

  @SubscribeMessage('leaveGame')
  handleLeaveGame(
    @ConnectedSocket() client: Socket,
    @MessageBody() gameId: string,
  ) {
    client.leave(gameId);
    client.to(gameId).emit('userLeft', { userId: client.data.userId });
    
    // Clean up game room if empty
    const room = this.server.sockets.adapter.rooms.get(gameId);
    if (!room || room.size === 0) {
      this.activeGames.delete(gameId);
    }
  }

  private async handleGameEnd(gameId: string, gameRoom: GameRoom) {
    try {
      // Update game status in database
      await this.gamesService.endGame(gameId, {
        pgn: gameRoom.chess.pgn(),
        fen: gameRoom.chess.fen(),
        result: this.getGameResult(gameRoom.chess),
      });

      // Request analysis for completed game
      await this.gamesService.requestAnalysis(gameId);

      // Clean up active game
      this.activeGames.delete(gameId);
    } catch (error) {
      console.error('Error handling game end:', error);
    }
  }

  private getGameResult(chess: Chess): string {
    if (chess.isCheckmate()) {
      return chess.turn() === 'w' ? '0-1' : '1-0';
    } else if (chess.isDraw()) {
      return '1/2-1/2';
    }
    return '*';
  }

  private async syncGameState() {
    // Sync active games to Redis for multi-instance support
    for (const [gameId, gameRoom] of this.activeGames) {
      // Clean up inactive games (no activity for 30 minutes)
      if (Date.now() - gameRoom.lastActivity.getTime() > 30 * 60 * 1000) {
        this.activeGames.delete(gameId);
        continue;
      }

      // Store game state in Redis
      await this.redisService.setex(
        `game:${gameId}`,
        3600, // 1 hour TTL
        JSON.stringify({
          fen: gameRoom.chess.fen(),
          pgn: gameRoom.chess.pgn(),
          lastActivity: gameRoom.lastActivity,
        }),
      );
    }
  }
}

// src/modules/games/games.service.ts
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { GameStatus } from '@prisma/client';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';

@Injectable()
export class GamesService {
  constructor(
    private prisma: PrismaService,
    @InjectQueue('analysis') private analysisQueue: Queue,
  ) {}

  async create(studentId: string, coachId: string, lessonId?: string) {
    return this.prisma.game.create({
      data: {
        studentId,
        coachId,
        lessonId,
        pgn: '',
        fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
      },
      include: {
        student: true,
        coach: true,
      },
    });
  }

  async findOne(id: string) {
    return this.prisma.game.findUnique({
      where: { id },
      include: {
        student: true,
        coach: true,
        moves: {
          orderBy: { moveNumber: 'asc' },
        },
      },
    });
  }

  async saveMove(data: {
    gameId: string;
    moveNumber: number;
    notation: string;
    fen: string;
    annotation?: string;
  }) {
    // Update game FEN
    await this.prisma.game.update({
      where: { id: data.gameId },
      data: { fen: data.fen },
    });

    // Create or update move
    return this.prisma.move.upsert({
      where: {
        gameId_moveNumber: {
          gameId: data.gameId,
          moveNumber: data.moveNumber,
        },
      },
      update: {
        notation: data.notation,
        fen: data.fen,
        annotation: data.annotation,
      },
      create: data,
    });
  }

  async updateMoveAnnotation(gameId: string, moveNumber: number, annotation: string) {
    return this.prisma.move.update({
      where: {
        gameId_moveNumber: { gameId, moveNumber },
      },
      data: { annotation },
    });
  }

  async endGame(id: string, data: { pgn: string; fen: string; result: string }) {
    return this.prisma.game.update({
      where: { id },
      data: {
        pgn: data.pgn,
        fen: data.fen,
        status: GameStatus.COMPLETED,
        endedAt: new Date(),
      },
    });
  }

  async requestAnalysis(gameId: string) {
    // Add to analysis queue with priority based on game length
    const game = await this.findOne(gameId);
    const priority = game.moves.length > 40 ? 1 : 2; // Longer games get higher priority
    
    await this.analysisQueue.add('analyze-game', { gameId }, {
      priority,
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 2000,
      },
    });
  }

  async getPositionAnalysis(fen: string) {
    // Quick position analysis for hints
    const job = await this.analysisQueue.add('analyze-position', { fen }, {
      priority: 3, // Highest priority for real-time hints
      attempts: 1,
    });
    
    return job.finished();
  }
}