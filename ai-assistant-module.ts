// src/modules/ai-assistant/ai-assistant.module.ts
import { Module } from '@nestjs/common';
import { AIAssistantService } from './ai-assistant.service';
import { PatternRecognitionService } from './pattern-recognition.service';
import { ExerciseGeneratorService } from './exercise-generator.service';
import { AnalysisModule } from '../analysis/analysis.module';
import { GamesModule } from '../games/games.module';

@Module({
  imports: [AnalysisModule, GamesModule],
  providers: [
    AIAssistantService,
    PatternRecognitionService,
    ExerciseGeneratorService,
  ],
  exports: [AIAssistantService],
})
export class AIAssistantModule {}

// src/modules/ai-assistant/pattern-recognition.service.ts
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import * as tf from '@tensorflow/tfjs-node';

// This service identifies patterns in a student's play to find weaknesses
@Injectable()
export class PatternRecognitionService {
  private model: tf.LayersModel;
  
  constructor(private prisma: PrismaService) {
    this.initializeModel();
  }

  private async initializeModel() {
    // Create a simple neural network for pattern classification
    // Input: board features (64 squares + additional features)
    // Output: pattern categories (opening, middlegame, endgame, tactics, etc.)
    
    this.model = tf.sequential({
      layers: [
        // Input layer: 64 squares + 10 additional features (material count, etc.)
        tf.layers.dense({
          inputShape: [74],
          units: 128,
          activation: 'relu',
          kernelInitializer: 'heNormal', // Better for deep networks
        }),
        
        // Hidden layers with dropout for regularization
        tf.layers.dropout({ rate: 0.3 }),
        tf.layers.dense({
          units: 64,
          activation: 'relu',
          kernelInitializer: 'heNormal',
        }),
        
        tf.layers.dropout({ rate: 0.3 }),
        tf.layers.dense({
          units: 32,
          activation: 'relu',
          kernelInitializer: 'heNormal',
        }),
        
        // Output layer: pattern categories
        tf.layers.dense({
          units: 8, // 8 different pattern categories
          activation: 'softmax',
        }),
      ],
    });

    this.model.compile({
      optimizer: tf.train.adam(0.001),
      loss: 'categoricalCrossentropy',
      metrics: ['accuracy'],
    });
  }

  async analyzeUserPatterns(userId: string): Promise<PatternAnalysis> {
    // Fetch user's recent games with analysis
    const games = await this.prisma.game.findMany({
      where: {
        studentId: userId,
        status: 'COMPLETED',
        analysis: { isNot: null },
      },
      include: {
        moves: true,
        analysis: true,
      },
      orderBy: { endedAt: 'desc' },
      take: 50, // Analyze last 50 games
    });

    if (games.length === 0) {
      return this.getDefaultPatternAnalysis();
    }

    // Extract patterns from games
    const patternCounts = {
      openingErrors: 0,
      tacticalMisses: 0,
      endgameWeakness: 0,
      timeManagement: 0,
      positionalMistakes: 0,
      calculationErrors: 0,
      strategicBlunders: 0,
      psychologicalPressure: 0,
    };

    // Analyze each game for patterns
    for (const game of games) {
      const analysis = game.analysis;
      
      // Opening errors (mistakes in first 10 moves)
      const openingMistakes = analysis.mistakes.filter(
        (m: any) => m.moveNumber <= 10
      );
      if (openingMistakes.length > 0) {
        patternCounts.openingErrors += openingMistakes.length;
      }

      // Tactical misses (blunders involving hanging pieces)
      const tacticalBlunders = analysis.blunders.filter((b: any) => {
        // Simple heuristic: large evaluation swings indicate tactical errors
        return b.centipawnLoss > 300;
      });
      patternCounts.tacticalMisses += tacticalBlunders.length;

      // Endgame weakness (errors after move 40)
      const endgameMistakes = analysis.mistakes.filter(
        (m: any) => m.moveNumber > 40
      );
      if (endgameMistakes.length > 0) {
        patternCounts.endgameWeakness += endgameMistakes.length;
      }

      // Time management issues (if we had time data)
      // This would analyze if mistakes correlate with time pressure
      
      // Positional mistakes (gradual evaluation decline)
      const positionDecline = this.analyzePositionalPlay(game.moves);
      if (positionDecline > 50) { // Lost 0.5 pawns gradually
        patternCounts.positionalMistakes++;
      }
    }

    // Convert counts to weakness scores (0-100)
    const totalGames = games.length;
    const weaknesses: WeaknessProfile = {
      opening: this.normalizeScore(patternCounts.openingErrors / totalGames, 2),
      tactics: this.normalizeScore(patternCounts.tacticalMisses / totalGames, 3),
      endgame: this.normalizeScore(patternCounts.endgameWeakness / totalGames, 2),
      timeManagement: this.normalizeScore(patternCounts.timeManagement / totalGames, 1),
      positional: this.normalizeScore(patternCounts.positionalMistakes / totalGames, 1.5),
      calculation: this.normalizeScore(patternCounts.calculationErrors / totalGames, 2),
      strategic: this.normalizeScore(patternCounts.strategicBlunders / totalGames, 1),
      psychological: this.normalizeScore(patternCounts.psychologicalPressure / totalGames, 0.5),
    };

    // Identify top 3 weaknesses
    const weaknessEntries = Object.entries(weaknesses)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 3);

    return {
      weaknesses,
      topWeaknesses: weaknessEntries.map(([area, score]) => ({ area, score })),
      improvement: this.calculateImprovement(userId, games),
      recommendedFocus: this.getRecommendedFocus(weaknesses),
    };
  }

  private analyzePositionalPlay(moves: any[]): number {
    // Calculate gradual evaluation changes (not sharp tactics)
    let totalDrift = 0;
    
    for (let i = 1; i < moves.length; i++) {
      const evalChange = Math.abs(moves[i].evaluation - moves[i-1].evaluation);
      if (evalChange < 50 && evalChange > 10) { // Small changes
        totalDrift += evalChange;
      }
    }
    
    return totalDrift;
  }

  private normalizeScore(rawScore: number, weight: number): number {
    // Convert raw error rate to 0-100 weakness score
    // Higher score = bigger weakness
    return Math.min(100, Math.round(rawScore * weight * 100));
  }

  private calculateImprovement(userId: string, recentGames: any[]): number {
    // Compare recent performance to historical average
    // Positive = improving, negative = declining
    if (recentGames.length < 10) return 0;
    
    const recentAvg = recentGames
      .slice(0, 10)
      .reduce((sum, game) => sum + game.analysis.evaluation, 0) / 10;
    
    const olderAvg = recentGames
      .slice(-10)
      .reduce((sum, game) => sum + game.analysis.evaluation, 0) / 10;
    
    return Math.round(recentAvg - olderAvg);
  }

  private getRecommendedFocus(weaknesses: WeaknessProfile): string[] {
    // Recommend focus areas based on weakness profile
    const recommendations: string[] = [];
    
    if (weaknesses.opening > 70) {
      recommendations.push('opening_repertoire');
      recommendations.push('opening_principles');
    }
    
    if (weaknesses.tactics > 70) {
      recommendations.push('tactical_puzzles');
      recommendations.push('pattern_recognition');
    }
    
    if (weaknesses.endgame > 70) {
      recommendations.push('endgame_theory');
      recommendations.push('endgame_practice');
    }
    
    if (weaknesses.positional > 60) {
      recommendations.push('positional_understanding');
      recommendations.push('pawn_structures');
    }
    
    // Always include at least 2 recommendations
    if (recommendations.length < 2) {
      recommendations.push('general_principles', 'game_analysis');
    }
    
    return recommendations.slice(0, 3); // Top 3 recommendations
  }

  private getDefaultPatternAnalysis(): PatternAnalysis {
    return {
      weaknesses: {
        opening: 50,
        tactics: 50,
        endgame: 50,
        timeManagement: 50,
        positional: 50,
        calculation: 50,
        strategic: 50,
        psychological: 50,
      },
      topWeaknesses: [
        { area: 'tactics', score: 50 },
        { area: 'opening', score: 50 },
        { area: 'endgame', score: 50 },
      ],
      improvement: 0,
      recommendedFocus: ['tactical_puzzles', 'opening_principles', 'endgame_theory'],
    };
  }
}

// src/modules/ai-assistant/exercise-generator.service.ts
import { Injectable } from '@nestjs/common';
import { Chess } from 'chess.js';

// This service generates personalized exercises based on identified weaknesses
@Injectable()
export class ExerciseGeneratorService {
  // Database of position patterns for different exercise types
  private readonly exerciseTemplates = {
    tactical_puzzles: [
      {
        fen: 'r1bqkb1r/pppp1ppp/2n2n2/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4',
        solution: ['Bxc6', 'dxc6', 'Nxe5'],
        theme: 'pin_and_win',
        difficulty: 1200,
      },
      {
        fen: '3rr1k1/pp3pbp/2bp2p1/q4n2/2P5/1P1B1N2/P2QRPPP/3R2K1 b - - 0 1',
        solution: ['Bxf3', 'gxf3', 'Nh4'],
        theme: 'sacrifice_for_attack',
        difficulty: 1500,
      },
      // Many more puzzles would be stored in a database
    ],
    
    opening_repertoire: [
      {
        name: 'Italian Game',
        moves: ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4'],
        keyIdeas: [
          'Control the center with pawns',
          'Develop knights before bishops',
          'Castle early for king safety',
        ],
        traps: ['Fried Liver Attack', 'Legal Trap'],
      },
      {
        name: 'Queens Gambit',
        moves: ['d4', 'd5', 'c4'],
        keyIdeas: [
          'Fight for central control',
          'Create pawn majority on queenside',
          'Develop pieces harmoniously',
        ],
        traps: ['Elephant Trap', 'Cambridge Springs Trap'],
      },
    ],
    
    endgame_practice: [
      {
        fen: '8/8/8/8/4K3/8/4P3/4k3 w - - 0 1',
        objective: 'Promote the pawn',
        keyTechnique: 'opposition',
        difficulty: 1000,
      },
      {
        fen: '8/8/8/8/4K3/8/4PP2/4k3 w - - 0 1',
        objective: 'Win with two pawns',
        keyTechnique: 'breakthrough',
        difficulty: 1200,
      },
    ],
  };

  generateExercises(
    weaknessProfile: WeaknessProfile,
    userRating: number,
    count: number = 5,
  ): Exercise[] {
    const exercises: Exercise[] = [];
    
    // Sort weaknesses by severity
    const sortedWeaknesses = Object.entries(weaknessProfile)
      .sort(([, a], [, b]) => b - a);
    
    // Generate exercises targeting top weaknesses
    for (const [weakness, score] of sortedWeaknesses) {
      if (exercises.length >= count) break;
      if (score < 40) continue; // Skip minor weaknesses
      
      const exerciseType = this.mapWeaknessToExerciseType(weakness);
      const targetDifficulty = this.calculateTargetDifficulty(userRating, score);
      
      // Generate appropriate exercises
      const newExercises = this.selectExercises(
        exerciseType,
        targetDifficulty,
        Math.ceil(count / 3), // Distribute exercises across weaknesses
      );
      
      exercises.push(...newExercises);
    }
    
    // Fill remaining slots with balanced exercises
    while (exercises.length < count) {
      const randomExercise = this.generateBalancedExercise(userRating);
      exercises.push(randomExercise);
    }
    
    return exercises.slice(0, count);
  }

  private mapWeaknessToExerciseType(weakness: string): string {
    const mapping: Record<string, string> = {
      tactics: 'tactical_puzzles',
      opening: 'opening_repertoire',
      endgame: 'endgame_practice',
      positional: 'positional_understanding',
      calculation: 'tactical_puzzles',
      strategic: 'strategic_planning',
    };
    
    return mapping[weakness] || 'general_practice';
  }

  private calculateTargetDifficulty(userRating: number, weaknessScore: number): number {
    // Adjust difficulty based on weakness severity
    // Higher weakness = slightly easier exercises to build confidence
    const adjustment = (weaknessScore - 50) * -2; // -100 to +100 rating adjustment
    return userRating + adjustment;
  }

  private selectExercises(
    type: string,
    targetDifficulty: number,
    count: number,
  ): Exercise[] {
    const exercises: Exercise[] = [];
    const templates = this.exerciseTemplates[type] || [];
    
    // Filter exercises by difficulty range
    const suitable = templates.filter(template => {
      const difficultyDiff = Math.abs(template.difficulty - targetDifficulty);
      return difficultyDiff < 200; // Within 200 rating points
    });
    
    // Select exercises with appropriate spacing
    for (let i = 0; i < Math.min(count, suitable.length); i++) {
      const template = suitable[i];
      exercises.push(this.createExerciseFromTemplate(template, type));
    }
    
    return exercises;
  }

  private createExerciseFromTemplate(template: any, type: string): Exercise {
    return {
      id: `${type}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      type,
      title: this.generateExerciseTitle(type, template),
      description: this.generateExerciseDescription(type, template),
      position: template.fen || 'startpos',
      targetMoves: template.solution || [],
      hints: this.generateHints(template),
      difficulty: template.difficulty || 1200,
      estimatedTime: this.estimateCompletionTime(type),
      rewards: {
        xp: Math.round(template.difficulty / 10),
        badges: this.generateBadges(type, template.difficulty),
      },
    };
  }

  private generateExerciseTitle(type: string, template: any): string {
    const titles = {
      tactical_puzzles: `Tactical Pattern: ${template.theme || 'Mixed'}`,
      opening_repertoire: `Opening Study: ${template.name || 'General'}`,
      endgame_practice: `Endgame Technique: ${template.keyTechnique || 'Practice'}`,
    };
    
    return titles[type] || 'Chess Exercise';
  }

  private generateExerciseDescription(type: string, template: any): string {
    const descriptions = {
      tactical_puzzles: 'Find the best move that gives you a decisive advantage.',
      opening_repertoire: 'Study this opening variation and understand the key ideas.',
      endgame_practice: `Master this endgame position. Objective: ${template.objective}`,
    };
    
    return descriptions[type] || 'Complete this chess exercise.';
  }

  private generateHints(template: any): string[] {
    const hints: string[] = [];
    
    if (template.theme) {
      hints.push(`Look for ${template.theme.replace(/_/g, ' ')} patterns`);
    }
    
    if (template.keyIdeas) {
      hints.push(...template.keyIdeas.slice(0, 2));
    }
    
    if (template.solution && template.solution.length > 0) {
      hints.push(`The solution involves ${template.solution.length} moves`);
    }
    
    return hints;
  }

  private estimateCompletionTime(type: string): number {
    const times = {
      tactical_puzzles: 300, // 5 minutes
      opening_repertoire: 600, // 10 minutes
      endgame_practice: 450, // 7.5 minutes
      positional_understanding: 480, // 8 minutes
    };
    
    return times[type] || 300;
  }

  private generateBadges(type: string, difficulty: number): string[] {
    const badges: string[] = [];
    
    if (difficulty > 1800) {
      badges.push('master_solver');
    } else if (difficulty > 1500) {
      badges.push('advanced_solver');
    }
    
    if (type === 'tactical_puzzles') {
      badges.push('tactician');
    } else if (type === 'endgame_practice') {
      badges.push('endgame_specialist');
    }
    
    return badges;
  }

  private generateBalancedExercise(userRating: number): Exercise {
    // Generate a random exercise appropriate for the user's level
    const types = Object.keys(this.exerciseTemplates);
    const randomType = types[Math.floor(Math.random() * types.length)];
    
    return this.selectExercises(randomType, userRating, 1)[0];
  }
}

// Type definitions
interface WeaknessProfile {
  opening: number;
  tactics: number;
  endgame: number;
  timeManagement: number;
  positional: number;
  calculation: number;
  strategic: number;
  psychological: number;
}

interface PatternAnalysis {
  weaknesses: WeaknessProfile;
  topWeaknesses: Array<{ area: string; score: number }>;
  improvement: number;
  recommendedFocus: string[];
}

interface Exercise {
  id: string;
  type: string;
  title: string;
  description: string;
  position: string;
  targetMoves: string[];
  hints: string[];
  difficulty: number;
  estimatedTime: number; // seconds
  rewards: {
    xp: number;
    badges: string[];
  };
}

// src/modules/ai-assistant/ai-assistant.service.ts
import { Injectable } from '@nestjs/common';
import { PatternRecognitionService } from './pattern-recognition.service';
import { ExerciseGeneratorService } from './exercise-generator.service';
import { PrismaService } from '../../database/prisma.service';

@Injectable()
export class AIAssistantService {
  constructor(
    private patternRecognition: PatternRecognitionService,
    private exerciseGenerator: ExerciseGeneratorService,
    private prisma: PrismaService,
  ) {}

  async getPersonalizedRecommendations(userId: string) {
    // Get user details
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        progress: {
          orderBy: { lastActivityAt: 'desc' },
          take: 5,
        },
      },
    });

    if (!user) {
      throw new Error('User not found');
    }

    // Analyze patterns and weaknesses
    const patternAnalysis = await this.patternRecognition.analyzeUserPatterns(userId);

    // Generate personalized exercises
    const exercises = this.exerciseGenerator.generateExercises(
      patternAnalysis.weaknesses,
      user.rating,
      5, // Generate 5 exercises
    );

    // Create a learning plan
    const learningPlan = this.createLearningPlan(patternAnalysis, exercises);

    return {
      user: {
        id: user.id,
        name: user.name,
        rating: user.rating,
        role: user.role,
      },
      analysis: patternAnalysis,
      exercises,
      learningPlan,
      insights: this.generateInsights(patternAnalysis, user),
    };
  }

  private createLearningPlan(
    analysis: PatternAnalysis,
    exercises: Exercise[],
  ): LearningPlan {
    const dailyGoals = {
      exercises: 3,
      studyTime: 30, // minutes
      games: 2,
    };

    // Adjust goals based on improvement rate
    if (analysis.improvement > 20) {
      // Doing well, increase intensity
      dailyGoals.exercises = 5;
      dailyGoals.studyTime = 45;
    } else if (analysis.improvement < -10) {
      // Struggling, reduce load but focus on quality
      dailyGoals.exercises = 2;
      dailyGoals.studyTime = 20;
      dailyGoals.games = 1;
    }

    return {
      dailyGoals,
      weeklyMilestones: [
        `Complete ${dailyGoals.exercises * 7} exercises`,
        `Focus on ${analysis.topWeaknesses[0].area} improvement`,
        `Play ${dailyGoals.games * 7} practice games`,
        'Review all game analyses',
      ],
      focusAreas: analysis.recommendedFocus,
      estimatedImprovement: this.estimateRatingGain(analysis),
    };
  }

  private generateInsights(analysis: PatternAnalysis, user: any): string[] {
    const insights: string[] = [];

    // Improvement trend
    if (analysis.improvement > 20) {
      insights.push(`Excellent progress! Your game quality improved by ${analysis.improvement}% recently.`);
    } else if (analysis.improvement < -10) {
      insights.push(`Your recent games show a ${Math.abs(analysis.improvement)}% decline. Let's focus on fundamentals.`);
    }

    // Top weakness
    const topWeakness = analysis.topWeaknesses[0];
    insights.push(
      `Your biggest area for improvement is ${topWeakness.area} (weakness score: ${topWeakness.score}/100).`
    );

    // Specific recommendations
    if (topWeakness.area === 'tactics' && topWeakness.score > 70) {
      insights.push('Consider spending 15 minutes daily on tactical puzzles.');
    } else if (topWeakness.area === 'opening' && topWeakness.score > 70) {
      insights.push('Building a solid opening repertoire will significantly improve your results.');
    }

    // Rating prediction
    const ratingGain = this.estimateRatingGain(analysis);
    if (ratingGain > 0) {
      insights.push(
        `With focused practice, you could gain approximately ${ratingGain} rating points in the next month.`
      );
    }

    return insights;
  }

  private estimateRatingGain(analysis: PatternAnalysis): number {
    // Estimate potential rating gain based on addressing weaknesses
    let potentialGain = 0;

    // Each major weakness addressed can yield rating points
    for (const weakness of analysis.topWeaknesses) {
      if (weakness.score > 70) {
        potentialGain += 30; // Major weakness
      } else if (weakness.score > 50) {
        potentialGain += 15; // Moderate weakness
      }
    }

    // Adjust based on current improvement trend
    if (analysis.improvement > 0) {
      potentialGain *= 1.2; // Positive momentum
    } else if (analysis.improvement < 0) {
      potentialGain *= 0.8; // Need to reverse negative trend first
    }

    return Math.round(potentialGain);
  }
}

interface LearningPlan {
  dailyGoals: {
    exercises: number;
    studyTime: number;
    games: number;
  };
  weeklyMilestones: string[];
  focusAreas: string[];
  estimatedImprovement: number;
}