// src/common/cache/cache.service.ts
// Multi-layer caching strategy for optimal performance
import { Injectable, Logger } from '@nestjs/common';
import { Redis } from 'ioredis';
import { InjectRedis } from '@liaoliaots/nestjs-redis';
import * as LRU from 'lru-cache';

interface CacheOptions {
  ttl?: number; // Time to live in seconds
  tags?: string[]; // For invalidation groups
  priority?: 'low' | 'medium' | 'high'; // Cache priority
}

@Injectable()
export class CacheService {
  private readonly logger = new Logger(CacheService.name);
  
  // In-memory L1 cache for ultra-fast access (sub-millisecond)
  private readonly l1Cache = new LRU<string, any>({
    max: 10000, // Maximum 10k items
    ttl: 1000 * 60 * 5, // 5 minutes default TTL
    updateAgeOnGet: true,
    updateAgeOnHas: true,
  });

  // Cache hit/miss statistics
  private stats = {
    l1Hits: 0,
    l1Misses: 0,
    l2Hits: 0,
    l2Misses: 0,
  };

  constructor(@InjectRedis() private readonly redis: Redis) {
    // Report stats every minute
    setInterval(() => this.reportStats(), 60000);
  }

  /**
   * Get value with multi-level caching
   * L1 (Memory) -> L2 (Redis) -> Source
   */
  async get<T>(
    key: string,
    fetchFn?: () => Promise<T>,
    options: CacheOptions = {},
  ): Promise<T | null> {
    const startTime = Date.now();

    // Try L1 cache first (fastest)
    const l1Value = this.l1Cache.get(key);
    if (l1Value !== undefined) {
      this.stats.l1Hits++;
      this.logger.debug(`L1 cache hit for ${key} (${Date.now() - startTime}ms)`);
      return l1Value;
    }
    this.stats.l1Misses++;

    // Try L2 cache (Redis)
    try {
      const l2Value = await this.redis.get(key);
      if (l2Value) {
        this.stats.l2Hits++;
        const parsed = JSON.parse(l2Value);
        
        // Populate L1 cache
        this.l1Cache.set(key, parsed);
        
        this.logger.debug(`L2 cache hit for ${key} (${Date.now() - startTime}ms)`);
        return parsed;
      }
    } catch (error) {
      this.logger.error(`Redis error for key ${key}:`, error);
    }
    this.stats.l2Misses++;

    // Cache miss - fetch from source
    if (!fetchFn) {
      return null;
    }

    try {
      const value = await fetchFn();
      if (value !== null && value !== undefined) {
        await this.set(key, value, options);
      }
      return value;
    } catch (error) {
      this.logger.error(`Error fetching value for key ${key}:`, error);
      throw error;
    }
  }

  /**
   * Set value in both cache layers
   */
  async set(key: string, value: any, options: CacheOptions = {}): Promise<void> {
    const ttl = options.ttl || 300; // Default 5 minutes

    // Set in L1 cache
    this.l1Cache.set(key, value, { ttl: ttl * 1000 });

    // Set in L2 cache (Redis)
    try {
      const serialized = JSON.stringify(value);
      await this.redis.setex(key, ttl, serialized);

      // Handle tags for group invalidation
      if (options.tags) {
        for (const tag of options.tags) {
          await this.redis.sadd(`tag:${tag}`, key);
          await this.redis.expire(`tag:${tag}`, ttl);
        }
      }
    } catch (error) {
      this.logger.error(`Error setting cache for key ${key}:`, error);
    }
  }

  /**
   * Invalidate cache by key or tag
   */
  async invalidate(keyOrTag: string, isTag: boolean = false): Promise<void> {
    if (isTag) {
      // Get all keys with this tag
      const keys = await this.redis.smembers(`tag:${keyOrTag}`);
      
      // Invalidate all keys
      for (const key of keys) {
        this.l1Cache.delete(key);
        await this.redis.del(key);
      }
      
      // Clean up the tag set
      await this.redis.del(`tag:${keyOrTag}`);
      
      this.logger.debug(`Invalidated ${keys.length} keys for tag ${keyOrTag}`);
    } else {
      // Invalidate single key
      this.l1Cache.delete(keyOrTag);
      await this.redis.del(keyOrTag);
    }
  }

  /**
   * Warm up cache with frequently accessed data
   */
  async warmUp(items: Array<{ key: string; value: any; options?: CacheOptions }>) {
    const promises = items.map(item => 
      this.set(item.key, item.value, item.options)
    );
    
    await Promise.all(promises);
    this.logger.log(`Warmed up cache with ${items.length} items`);
  }

  private reportStats() {
    const total = this.stats.l1Hits + this.stats.l1Misses;
    const l1HitRate = total > 0 ? (this.stats.l1Hits / total * 100).toFixed(2) : 0;
    
    this.logger.log(`Cache stats - L1 hit rate: ${l1HitRate}%, L1 size: ${this.l1Cache.size}`);
    
    // Reset stats
    this.stats = {
      l1Hits: 0,
      l1Misses: 0,
      l2Hits: 0,
      l2Misses: 0,
    };
  }
}

// src/modules/games/games.service.optimized.ts
// Optimized game service with caching and query optimization
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { CacheService } from '../../common/cache/cache.service';
import { Prisma } from '@prisma/client';

@Injectable()
export class OptimizedGamesService {
  constructor(
    private prisma: PrismaService,
    private cache: CacheService,
  ) {}

  /**
   * Get game with optimized queries and caching
   */
  async findOneOptimized(id: string) {
    const cacheKey = `game:${id}`;
    
    return this.cache.get(
      cacheKey,
      async () => {
        // Use Prisma's query optimization features
        const game = await this.prisma.game.findUnique({
          where: { id },
          select: {
            id: true,
            studentId: true,
            coachId: true,
            pgn: true,
            fen: true,
            status: true,
            startedAt: true,
            endedAt: true,
            // Selective loading of relations
            student: {
              select: {
                id: true,
                name: true,
                rating: true,
              },
            },
            coach: {
              select: {
                id: true,
                name: true,
                rating: true,
              },
            },
            // Aggregate move count instead of loading all moves
            _count: {
              select: { moves: true },
            },
          },
        });

        return game;
      },
      { ttl: 300, tags: ['games'] }, // 5 minute cache
    );
  }

  /**
   * Get user's recent games with pagination and caching
   */
  async getUserGamesOptimized(
    userId: string,
    page: number = 1,
    limit: number = 20,
  ) {
    const cacheKey = `user-games:${userId}:${page}:${limit}`;
    
    return this.cache.get(
      cacheKey,
      async () => {
        // Use cursor-based pagination for better performance
        const games = await this.prisma.game.findMany({
          where: {
            OR: [
              { studentId: userId },
              { coachId: userId },
            ],
          },
          orderBy: { startedAt: 'desc' },
          skip: (page - 1) * limit,
          take: limit,
          select: {
            id: true,
            status: true,
            startedAt: true,
            endedAt: true,
            // Only load opponent info
            student: {
              select: {
                id: true,
                name: true,
                rating: true,
              },
            },
            coach: {
              select: {
                id: true,
                name: true,
                rating: true,
              },
            },
            // Get analysis summary without full data
            analysis: {
              select: {
                evaluation: true,
                blunders: true,
              },
            },
          },
        });

        // Count total for pagination
        const total = await this.prisma.game.count({
          where: {
            OR: [
              { studentId: userId },
              { coachId: userId },
            ],
          },
        });

        return {
          games,
          pagination: {
            page,
            limit,
            total,
            pages: Math.ceil(total / limit),
          },
        };
      },
      { ttl: 60, tags: [`user:${userId}`, 'games'] }, // 1 minute cache
    );
  }

  /**
   * Batch load games for multiple IDs (prevents N+1 queries)
   */
  async findManyOptimized(ids: string[]) {
    // Check cache for each ID
    const cached: any[] = [];
    const uncachedIds: string[] = [];

    for (const id of ids) {
      const cachedGame = await this.cache.get(`game:${id}`);
      if (cachedGame) {
        cached.push(cachedGame);
      } else {
        uncachedIds.push(id);
      }
    }

    // Batch load uncached games
    if (uncachedIds.length > 0) {
      const games = await this.prisma.game.findMany({
        where: { id: { in: uncachedIds } },
        select: {
          id: true,
          studentId: true,
          coachId: true,
          pgn: true,
          fen: true,
          status: true,
          student: {
            select: { id: true, name: true, rating: true },
          },
          coach: {
            select: { id: true, name: true, rating: true },
          },
        },
      });

      // Cache the loaded games
      for (const game of games) {
        await this.cache.set(`game:${game.id}`, game, { ttl: 300 });
        cached.push(game);
      }
    }

    return cached;
  }
}

// src/database/database.optimization.ts
// Database optimization utilities
import { Injectable, OnModuleInit } from '@nestjs/common';
import { PrismaService } from './prisma.service';

@Injectable()
export class DatabaseOptimizationService implements OnModuleInit {
  constructor(private prisma: PrismaService) {}

  async onModuleInit() {
    // Set up database optimizations on startup
    await this.createIndexes();
    await this.analyzeQueryPerformance();
  }

  /**
   * Create additional indexes for performance
   */
  private async createIndexes() {
    // These are in addition to indexes defined in schema.prisma
    const indexes = [
      // Composite index for game queries
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_games_status_dates 
       ON "Game" (status, "startedAt" DESC, "endedAt" DESC)`,
      
      // Index for move lookups
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_moves_game_evaluation 
       ON "Move" ("gameId", evaluation) WHERE evaluation IS NOT NULL`,
      
      // Index for user progress tracking
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_progress_user_activity 
       ON "Progress" ("userId", "lastActivityAt" DESC)`,
      
      // Partial index for active games only
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_games_active 
       ON "Game" ("studentId", "coachId") WHERE status = 'ACTIVE'`,
    ];

    for (const index of indexes) {
      try {
        await this.prisma.$executeRawUnsafe(index);
      } catch (error) {
        console.error(`Error creating index: ${error.message}`);
      }
    }
  }

  /**
   * Analyze slow queries and suggest optimizations
   */
  private async analyzeQueryPerformance() {
    // Enable query logging for slow queries (> 100ms)
    await this.prisma.$executeRaw`
      ALTER DATABASE ${Prisma.sql`CURRENT_DATABASE()`} 
      SET log_min_duration_statement = 100;
    `;

    // Create extension for query analysis
    await this.prisma.$executeRaw`
      CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
    `;
  }

  /**
   * Get slow query report
   */
  async getSlowQueries() {
    const result = await this.prisma.$queryRaw`
      SELECT 
        query,
        calls,
        total_exec_time,
        mean_exec_time,
        stddev_exec_time,
        rows
      FROM pg_stat_statements
      WHERE mean_exec_time > 100
      ORDER BY mean_exec_time DESC
      LIMIT 20;
    `;

    return result;
  }
}

// src/common/decorators/cache.decorator.ts
// Decorator for easy method-level caching
import { SetMetadata } from '@nestjs/common';

export interface CacheConfig {
  key?: string | ((args: any[]) => string);
  ttl?: number;
  tags?: string[];
}

export const Cache = (config: CacheConfig = {}) => 
  SetMetadata('cache', config);

// Cache interceptor implementation
import { 
  Injectable, 
  NestInterceptor, 
  ExecutionContext, 
  CallHandler 
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable, of } from 'rxjs';
import { tap } from 'rxjs/operators';
import { CacheService } from '../cache/cache.service';

@Injectable()
export class CacheInterceptor implements NestInterceptor {
  constructor(
    private reflector: Reflector,
    private cacheService: CacheService,
  ) {}

  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<any>> {
    const cacheConfig = this.reflector.get<CacheConfig>(
      'cache',
      context.getHandler(),
    );

    if (!cacheConfig) {
      return next.handle();
    }

    const request = context.switchToHttp().getRequest();
    const cacheKey = this.getCacheKey(cacheConfig, context);

    // Try to get from cache
    const cached = await this.cacheService.get(cacheKey);
    if (cached) {
      return of(cached);
    }

    // Execute and cache result
    return next.handle().pipe(
      tap(async (result) => {
        await this.cacheService.set(
          cacheKey,
          result,
          {
            ttl: cacheConfig.ttl,
            tags: cacheConfig.tags,
          },
        );
      }),
    );
  }

  private getCacheKey(config: CacheConfig, context: ExecutionContext): string {
    if (typeof config.key === 'function') {
      const args = context.getArgByIndex(1); // Method arguments
      return config.key(args);
    }

    if (config.key) {
      return config.key;
    }

    // Generate key from method name and arguments
    const request = context.switchToHttp().getRequest();
    const methodName = context.getHandler().name;
    const className = context.getClass().name;
    
    return `${className}:${methodName}:${JSON.stringify(request.params)}`;
  }
}

// Usage example in controller
export class GamesController {
  @Get(':id')
  @Cache({ 
    key: (args) => `game:${args[0].params.id}`,
    ttl: 300,
    tags: ['games'],
  })
  async findOne(@Param('id') id: string) {
    return this.gamesService.findOne(id);
  }
}