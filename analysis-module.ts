// src/modules/analysis/analysis.module.ts
import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bull';
import { AnalysisService } from './analysis.service';
import { AnalysisController } from './analysis.controller';
import { AnalysisProcessor } from './analysis.processor';
import { StockfishService } from './stockfish.service';
import { GamesModule } from '../games/games.module';

@Module({
  imports: [
    BullModule.registerQueue({
      name: 'analysis',
      defaultJobOptions: {
        removeOnComplete: true,
        removeOnFail: false,
      },
    }),
    GamesModule,
  ],
  providers: [AnalysisService, AnalysisProcessor, StockfishService],
  controllers: [AnalysisController],
  exports: [AnalysisService],
})
export class AnalysisModule {}

// src/modules/analysis/stockfish.service.ts
import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';

// This service manages Stockfish engine instances efficiently
@Injectable()
export class StockfishService extends EventEmitter implements OnModuleInit, OnModuleDestroy {
  private engines: ChildProcess[] = [];
  private enginePool: ChildProcess[] = [];
  private readonly POOL_SIZE = 4; // Number of Stockfish instances
  private readonly ANALYSIS_DEPTH = 20; // How deep to analyze (20 is quite thorough)
  private readonly MOVE_TIME = 1000; // Milliseconds per move analysis

  async onModuleInit() {
    // Initialize engine pool for better performance
    for (let i = 0; i < this.POOL_SIZE; i++) {
      await this.createEngine();
    }
  }

  async onModuleDestroy() {
    // Clean up all engines
    for (const engine of this.engines) {
      engine.kill();
    }
  }

  private async createEngine(): Promise<ChildProcess> {
    // Using Stockfish 16 for best analysis quality
    const engine = spawn('stockfish', [], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Configure engine for optimal analysis
    engine.stdin.write('uci\n');
    engine.stdin.write('setoption name Threads value 2\n'); // Use 2 threads per engine
    engine.stdin.write('setoption name Hash value 256\n'); // 256MB hash table
    engine.stdin.write('setoption name MultiPV value 3\n'); // Get top 3 moves
    engine.stdin.write('isready\n');

    // Wait for engine to be ready
    await new Promise<void>((resolve) => {
      engine.stdout.on('data', (data) => {
        if (data.toString().includes('readyok')) {
          resolve();
        }
      });
    });

    this.engines.push(engine);
    this.enginePool.push(engine);
    return engine;
  }

  private async getEngine(): Promise<ChildProcess> {
    // Get an available engine from the pool
    if (this.enginePool.length === 0) {
      // Wait for an engine to become available
      await new Promise(resolve => setTimeout(resolve, 100));
      return this.getEngine();
    }
    return this.enginePool.pop()!;
  }

  private releaseEngine(engine: ChildProcess) {
    // Return engine to pool
    this.enginePool.push(engine);
  }

  async analyzePosition(fen: string): Promise<PositionAnalysis> {
    const engine = await this.getEngine();
    const analysis: PositionAnalysis = {
      evaluation: 0,
      bestMoves: [],
      depth: 0,
    };

    try {
      // Set up position
      engine.stdin.write(`position fen ${fen}\n`);
      engine.stdin.write(`go depth ${this.ANALYSIS_DEPTH}\n`);

      // Collect analysis data
      await new Promise<void>((resolve) => {
        const lines: string[] = [];
        
        const dataHandler = (data: Buffer) => {
          const output = data.toString();
          lines.push(...output.split('\n').filter(line => line.trim()));
          
          // Look for the best move
          if (output.includes('bestmove')) {
            engine.stdout.removeListener('data', dataHandler);
            
            // Parse the analysis results
            for (const line of lines) {
              // Extract evaluation score (in centipawns)
              if (line.includes('score cp')) {
                const match = line.match(/score cp (-?\d+)/);
                if (match) {
                  analysis.evaluation = parseInt(match[1]) / 100; // Convert to pawns
                }
              }
              
              // Extract best moves from MultiPV lines
              if (line.includes('multipv')) {
                const pvMatch = line.match(/pv (.+)/);
                const scoreMatch = line.match(/score cp (-?\d+)/);
                if (pvMatch && scoreMatch) {
                  const moves = pvMatch[1].split(' ');
                  analysis.bestMoves.push({
                    move: moves[0],
                    evaluation: parseInt(scoreMatch[1]) / 100,
                    continuation: moves.slice(0, 5).join(' '), // First 5 moves
                  });
                }
              }
              
              // Extract depth
              if (line.includes('depth')) {
                const depthMatch = line.match(/depth (\d+)/);
                if (depthMatch) {
                  analysis.depth = Math.max(analysis.depth, parseInt(depthMatch[1]));
                }
              }
            }
            
            resolve();
          }
        };
        
        engine.stdout.on('data', dataHandler);
      });

    } finally {
      this.releaseEngine(engine);
    }

    return analysis;
  }

  async analyzeGame(pgn: string): Promise<GameAnalysis> {
    const engine = await this.getEngine();
    const moves = this.parsePGN(pgn);
    const analysis: GameAnalysis = {
      moves: [],
      blunders: [],
      mistakes: [],
      inaccuracies: [],
      averageCentipawnLoss: 0,
      gameQuality: 0,
    };

    try {
      let position = 'startpos';
      let previousEval = 0;
      let totalCentipawnLoss = 0;
      let moveCount = 0;

      // Analyze each move
      for (let i = 0; i < moves.length; i++) {
        const move = moves[i];
        
        // Set up position before the move
        engine.stdin.write(`position ${position}\n`);
        engine.stdin.write(`go movetime ${this.MOVE_TIME}\n`);

        // Get best move analysis
        const bestMoveAnalysis = await this.waitForAnalysis(engine);
        
        // Make the actual move
        if (position === 'startpos') {
          position = `startpos moves ${move}`;
        } else {
          position += ` ${move}`;
        }

        // Analyze position after the move
        engine.stdin.write(`position ${position}\n`);
        engine.stdin.write(`go movetime ${this.MOVE_TIME}\n`);
        
        const afterMoveAnalysis = await this.waitForAnalysis(engine);

        // Calculate centipawn loss
        const expectedEval = bestMoveAnalysis.evaluation;
        const actualEval = afterMoveAnalysis.evaluation * (i % 2 === 0 ? 1 : -1); // Flip for black moves
        const centipawnLoss = Math.max(0, expectedEval - actualEval);

        // Categorize the move based on centipawn loss
        const moveAnalysis: MoveAnalysis = {
          moveNumber: Math.floor(i / 2) + 1,
          move,
          evaluation: actualEval,
          bestMove: bestMoveAnalysis.bestMove,
          centipawnLoss,
          category: this.categorizeMove(centipawnLoss),
        };

        analysis.moves.push(moveAnalysis);

        // Track errors
        if (moveAnalysis.category === 'blunder') {
          analysis.blunders.push(moveAnalysis);
        } else if (moveAnalysis.category === 'mistake') {
          analysis.mistakes.push(moveAnalysis);
        } else if (moveAnalysis.category === 'inaccuracy') {
          analysis.inaccuracies.push(moveAnalysis);
        }

        totalCentipawnLoss += centipawnLoss;
        moveCount++;
        previousEval = actualEval;
      }

      // Calculate overall metrics
      analysis.averageCentipawnLoss = moveCount > 0 ? totalCentipawnLoss / moveCount : 0;
      
      // Game quality score (0-100)
      // Based on average centipawn loss: 0 CPL = 100, 100 CPL = 0
      analysis.gameQuality = Math.max(0, Math.min(100, 100 - analysis.averageCentipawnLoss));

    } finally {
      this.releaseEngine(engine);
    }

    return analysis;
  }

  private categorizeMove(centipawnLoss: number): MoveCategory {
    // These thresholds define what constitutes each type of error
    if (centipawnLoss >= 300) return 'blunder';      // Loss of 3+ pawns
    if (centipawnLoss >= 100) return 'mistake';      // Loss of 1-3 pawns
    if (centipawnLoss >= 50) return 'inaccuracy';    // Loss of 0.5-1 pawn
    if (centipawnLoss <= 10) return 'best';          // Nearly perfect move
    return 'good';                                    // Reasonable move
  }

  private async waitForAnalysis(engine: ChildProcess): Promise<any> {
    return new Promise((resolve) => {
      let evaluation = 0;
      let bestMove = '';
      
      const dataHandler = (data: Buffer) => {
        const output = data.toString();
        
        if (output.includes('score cp')) {
          const match = output.match(/score cp (-?\d+)/);
          if (match) {
            evaluation = parseInt(match[1]);
          }
        }
        
        if (output.includes('bestmove')) {
          const match = output.match(/bestmove (\S+)/);
          if (match) {
            bestMove = match[1];
          }
          engine.stdout.removeListener('data', dataHandler);
          resolve({ evaluation, bestMove });
        }
      };
      
      engine.stdout.on('data', dataHandler);
    });
  }

  private parsePGN(pgn: string): string[] {
    // Simple PGN parser - in production, use a library like chess.js
    const moves = pgn
      .replace(/\{[^}]*\}/g, '') // Remove comments
      .replace(/\d+\./g, '')     // Remove move numbers
      .replace(/\s+/g, ' ')      // Normalize whitespace
      .trim()
      .split(' ')
      .filter(move => move && !move.includes('-')); // Remove empty and result
    
    return moves;
  }
}

// Type definitions
interface PositionAnalysis {
  evaluation: number; // In pawns (positive = white advantage)
  bestMoves: {
    move: string;
    evaluation: number;
    continuation: string;
  }[];
  depth: number;
}

interface MoveAnalysis {
  moveNumber: number;
  move: string;
  evaluation: number;
  bestMove: string;
  centipawnLoss: number;
  category: MoveCategory;
}

type MoveCategory = 'best' | 'good' | 'inaccuracy' | 'mistake' | 'blunder';

interface GameAnalysis {
  moves: MoveAnalysis[];
  blunders: MoveAnalysis[];
  mistakes: MoveAnalysis[];
  inaccuracies: MoveAnalysis[];
  averageCentipawnLoss: number;
  gameQuality: number; // 0-100 score
}

// src/modules/analysis/analysis.processor.ts
import { Process, Processor } from '@nestjs/bull';
import { Job } from 'bull';
import { StockfishService } from './stockfish.service';
import { PrismaService } from '../../database/prisma.service';

@Processor('analysis')
export class AnalysisProcessor {
  constructor(
    private stockfishService: StockfishService,
    private prisma: PrismaService,
  ) {}

  @Process('analyze-game')
  async handleGameAnalysis(job: Job<{ gameId: string }>) {
    const { gameId } = job.data;
    
    try {
      // Fetch the game
      const game = await this.prisma.game.findUnique({
        where: { id: gameId },
        include: { moves: true },
      });

      if (!game) {
        throw new Error('Game not found');
      }

      // Perform analysis
      const analysis = await this.stockfishService.analyzeGame(game.pgn);

      // Store analysis results
      await this.prisma.analysis.create({
        data: {
          gameId,
          blunders: analysis.blunders,
          mistakes: analysis.mistakes,
          inaccuracies: analysis.inaccuracies,
          bestMoves: analysis.moves
            .filter(m => m.category === 'best')
            .map(m => ({ move: m.move, moveNumber: m.moveNumber })),
          evaluation: analysis.gameQuality,
        },
      });

      // Update move evaluations
      for (const moveAnalysis of analysis.moves) {
        await this.prisma.move.update({
          where: {
            gameId_moveNumber: {
              gameId,
              moveNumber: moveAnalysis.moveNumber,
            },
          },
          data: {
            evaluation: moveAnalysis.evaluation,
          },
        });
      }

      return { success: true, quality: analysis.gameQuality };
    } catch (error) {
      console.error('Error analyzing game:', error);
      throw error;
    }
  }

  @Process('analyze-position')
  async handlePositionAnalysis(job: Job<{ fen: string }>) {
    const { fen } = job.data;
    return this.stockfishService.analyzePosition(fen);
  }
}