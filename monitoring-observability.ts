// src/common/interceptors/logging.interceptor.ts
// This is like recording every move in a chess game for later analysis
import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  Logger,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { Request } from 'express';
import * as winston from 'winston';
import * as DailyRotateFile from 'winston-daily-rotate-file';

// Advanced logging with Winston for production-grade observability
@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private logger: winston.Logger;

  constructor() {
    // Configure structured logging for easy parsing
    this.logger = winston.createLogger({
      level: process.env.LOG_LEVEL || 'info',
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.errors({ stack: true }),
        winston.format.json(),
      ),
      defaultMeta: { service: 'chess-learning-api' },
      transports: [
        // Console output for development
        new winston.transports.Console({
          format: winston.format.combine(
            winston.format.colorize(),
            winston.format.simple(),
          ),
        }),
        // File rotation for production
        new DailyRotateFile({
          filename: 'logs/application-%DATE%.log',
          datePattern: 'YYYY-MM-DD',
          maxSize: '20m',
          maxFiles: '14d',
        }),
        // Error log file
        new DailyRotateFile({
          filename: 'logs/error-%DATE%.log',
          datePattern: 'YYYY-MM-DD',
          maxSize: '20m',
          maxFiles: '30d',
          level: 'error',
        }),
      ],
    });
  }

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const request = context.switchToHttp().getRequest<Request>();
    const { method, url, body, headers } = request;
    const startTime = Date.now();
    
    // Generate unique request ID for tracing
    const requestId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    request['requestId'] = requestId;

    // Log incoming request
    this.logger.info('Incoming request', {
      requestId,
      method,
      url,
      userAgent: headers['user-agent'],
      ip: request.ip,
      userId: request['user']?.userId,
    });

    return next.handle().pipe(
      tap({
        next: (data) => {
          // Log successful response
          const responseTime = Date.now() - startTime;
          
          this.logger.info('Request completed', {
            requestId,
            method,
            url,
            statusCode: context.switchToHttp().getResponse().statusCode,
            responseTime,
            userId: request['user']?.userId,
          });

          // Performance warning for slow requests
          if (responseTime > 1000) {
            this.logger.warn('Slow request detected', {
              requestId,
              method,
              url,
              responseTime,
              threshold: 1000,
            });
          }
        },
        error: (error) => {
          // Log errors with full context
          const responseTime = Date.now() - startTime;
          
          this.logger.error('Request failed', {
            requestId,
            method,
            url,
            error: {
              message: error.message,
              stack: error.stack,
              name: error.name,
            },
            responseTime,
            userId: request['user']?.userId,
            body: this.sanitizeBody(body),
          });
        },
      }),
    );
  }

  private sanitizeBody(body: any): any {
    // Remove sensitive data from logs
    const sanitized = { ...body };
    const sensitiveFields = ['password', 'token', 'secret', 'creditCard'];
    
    sensitiveFields.forEach(field => {
      if (sanitized[field]) {
        sanitized[field] = '[REDACTED]';
      }
    });
    
    return sanitized;
  }
}

// src/common/metrics/prometheus.service.ts
// Metrics collection for Prometheus/Grafana dashboards
import { Injectable } from '@nestjs/common';
import * as promClient from 'prom-client';

@Injectable()
export class MetricsService {
  private register: promClient.Registry;
  
  // Custom metrics for our chess platform
  private gameMetrics: {
    gamesStarted: promClient.Counter;
    gamesCompleted: promClient.Counter;
    movesPlayed: promClient.Counter;
    analysisRequests: promClient.Counter;
    activeGames: promClient.Gauge;
    moveLatency: promClient.Histogram;
    analysisTime: promClient.Histogram;
    userRatingChanges: promClient.Histogram;
  };

  constructor() {
    this.register = new promClient.Registry();
    
    // Default metrics (CPU, memory, etc.)
    promClient.collectDefaultMetrics({ register: this.register });
    
    // Initialize custom metrics
    this.gameMetrics = {
      gamesStarted: new promClient.Counter({
        name: 'chess_games_started_total',
        help: 'Total number of games started',
        labelNames: ['game_type'],
        registers: [this.register],
      }),
      
      gamesCompleted: new promClient.Counter({
        name: 'chess_games_completed_total',
        help: 'Total number of games completed',
        labelNames: ['result', 'game_type'],
        registers: [this.register],
      }),
      
      movesPlayed: new promClient.Counter({
        name: 'chess_moves_played_total',
        help: 'Total number of moves played',
        labelNames: ['piece_type'],
        registers: [this.register],
      }),
      
      analysisRequests: new promClient.Counter({
        name: 'chess_analysis_requests_total',
        help: 'Total number of analysis requests',
        labelNames: ['analysis_type'],
        registers: [this.register],
      }),
      
      activeGames: new promClient.Gauge({
        name: 'chess_active_games',
        help: 'Number of currently active games',
        registers: [this.register],
      }),
      
      moveLatency: new promClient.Histogram({
        name: 'chess_move_latency_ms',
        help: 'Latency of move processing in milliseconds',
        buckets: [10, 25, 50, 100, 250, 500, 1000],
        registers: [this.register],
      }),
      
      analysisTime: new promClient.Histogram({
        name: 'chess_analysis_duration_seconds',
        help: 'Time taken to analyze a game',
        buckets: [1, 5, 10, 30, 60, 120, 300],
        registers: [this.register],
      }),
      
      userRatingChanges: new promClient.Histogram({
        name: 'chess_rating_changes',
        help: 'Distribution of rating changes',
        buckets: [-100, -50, -25, -10, 0, 10, 25, 50, 100],
        registers: [this.register],
      }),
    };
  }

  // Metric recording methods
  recordGameStart(gameType: string = 'standard') {
    this.gameMetrics.gamesStarted.inc({ game_type: gameType });
    this.gameMetrics.activeGames.inc();
  }

  recordGameEnd(result: string, gameType: string = 'standard') {
    this.gameMetrics.gamesCompleted.inc({ result, game_type: gameType });
    this.gameMetrics.activeGames.dec();
  }

  recordMove(pieceType: string, latencyMs: number) {
    this.gameMetrics.movesPlayed.inc({ piece_type: pieceType });
    this.gameMetrics.moveLatency.observe(latencyMs);
  }

  recordAnalysis(type: string, durationSeconds: number) {
    this.gameMetrics.analysisRequests.inc({ analysis_type: type });
    this.gameMetrics.analysisTime.observe(durationSeconds);
  }

  recordRatingChange(change: number) {
    this.gameMetrics.userRatingChanges.observe(change);
  }

  async getMetrics(): Promise<string> {
    return this.register.metrics();
  }
}

// src/common/middleware/security.middleware.ts
// Security middleware - Protecting our kingdom
import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import * as helmet from 'helmet';
import * as rateLimit from 'express-rate-limit';
import * as mongoSanitize from 'express-mongo-sanitize';

@Injectable()
export class SecurityMiddleware implements NestMiddleware {
  private helmetMiddleware = helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        scriptSrc: ["'self'"],
        imgSrc: ["'self'", 'data:', 'https:'],
        connectSrc: ["'self'", 'wss:', 'https:'],
      },
    },
    hsts: {
      maxAge: 31536000,
      includeSubDomains: true,
      preload: true,
    },
  });

  // Rate limiting configurations for different endpoints
  private readonly rateLimiters = {
    auth: rateLimit({
      windowMs: 15 * 60 * 1000, // 15 minutes
      max: 5, // 5 requests per window
      message: 'Too many authentication attempts, please try again later',
      standardHeaders: true,
      legacyHeaders: false,
    }),
    
    api: rateLimit({
      windowMs: 1 * 60 * 1000, // 1 minute
      max: 100, // 100 requests per minute
      message: 'Too many requests, please try again later',
      standardHeaders: true,
      legacyHeaders: false,
    }),
    
    analysis: rateLimit({
      windowMs: 5 * 60 * 1000, // 5 minutes
      max: 10, // 10 analysis requests per 5 minutes
      message: 'Analysis rate limit exceeded, please wait before requesting more',
      standardHeaders: true,
      legacyHeaders: false,
    }),
  };

  use(req: Request, res: Response, next: NextFunction) {
    // Apply helmet security headers
    this.helmetMiddleware(req, res, () => {
      // Apply rate limiting based on route
      if (req.path.startsWith('/auth')) {
        this.rateLimiters.auth(req, res, next);
      } else if (req.path.startsWith('/analysis')) {
        this.rateLimiters.analysis(req, res, next);
      } else {
        this.rateLimiters.api(req, res, next);
      }
    });
  }
}

// src/common/services/alert.service.ts
// Alerting service for critical issues
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';

interface Alert {
  level: 'info' | 'warning' | 'critical';
  title: string;
  message: string;
  metadata?: Record<string, any>;
}

@Injectable()
export class AlertService {
  private transporter: nodemailer.Transporter;
  private alertThresholds = {
    errorRate: 0.05, // 5% error rate
    responseTime: 2000, // 2 seconds
    memoryUsage: 0.85, // 85% memory usage
    activeGames: 1000, // High load threshold
  };

  constructor(private configService: ConfigService) {
    // Configure email alerts
    this.transporter = nodemailer.createTransport({
      host: configService.get('SMTP_HOST'),
      port: configService.get('SMTP_PORT'),
      secure: true,
      auth: {
        user: configService.get('SMTP_USER'),
        pass: configService.get('SMTP_PASS'),
      },
    });
  }

  async sendAlert(alert: Alert) {
    const recipients = this.configService.get('ALERT_RECIPIENTS', '').split(',');
    
    if (recipients.length === 0) {
      console.error('No alert recipients configured');
      return;
    }

    const emailContent = {
      from: 'Chess Learning Platform <alerts@chesslearning.com>',
      to: recipients,
      subject: `[${alert.level.toUpperCase()}] ${alert.title}`,
      html: this.generateAlertEmail(alert),
    };

    try {
      await this.transporter.sendMail(emailContent);
    } catch (error) {
      console.error('Failed to send alert email:', error);
      // Could also send to Slack, PagerDuty, etc.
    }
  }

  private generateAlertEmail(alert: Alert): string {
    const color = {
      info: '#0066cc',
      warning: '#ff9900',
      critical: '#cc0000',
    }[alert.level];

    return `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background-color: ${color}; color: white; padding: 20px; border-radius: 8px 8px 0 0;">
          <h2 style="margin: 0;">${alert.title}</h2>
        </div>
        <div style="border: 1px solid #ddd; padding: 20px; border-radius: 0 0 8px 8px;">
          <p style="font-size: 16px; line-height: 1.5;">${alert.message}</p>
          ${alert.metadata ? `
            <h3>Additional Details:</h3>
            <pre style="background-color: #f5f5f5; padding: 10px; border-radius: 4px; overflow-x: auto;">
${JSON.stringify(alert.metadata, null, 2)}
            </pre>
          ` : ''}
          <p style="color: #666; font-size: 14px; margin-top: 20px;">
            Timestamp: ${new Date().toISOString()}<br>
            Environment: ${this.configService.get('NODE_ENV')}
          </p>
        </div>
      </div>
    `;
  }

  // Check system health and send alerts if needed
  async checkSystemHealth(metrics: any) {
    // Check error rate
    if (metrics.errorRate > this.alertThresholds.errorRate) {
      await this.sendAlert({
        level: 'critical',
        title: 'High Error Rate Detected',
        message: `Error rate has reached ${(metrics.errorRate * 100).toFixed(2)}%, exceeding threshold of ${this.alertThresholds.errorRate * 100}%`,
        metadata: {
          currentRate: metrics.errorRate,
          threshold: this.alertThresholds.errorRate,
          recentErrors: metrics.recentErrors,
        },
      });
    }

    // Check response time
    if (metrics.avgResponseTime > this.alertThresholds.responseTime) {
      await this.sendAlert({
        level: 'warning',
        title: 'Slow Response Times',
        message: `Average response time is ${metrics.avgResponseTime}ms, exceeding threshold of ${this.alertThresholds.responseTime}ms`,
        metadata: {
          p50: metrics.responseTimeP50,
          p95: metrics.responseTimeP95,
          p99: metrics.responseTimeP99,
        },
      });
    }

    // Check memory usage
    const memoryUsagePercent = metrics.memoryUsed / metrics.memoryTotal;
    if (memoryUsagePercent > this.alertThresholds.memoryUsage) {
      await this.sendAlert({
        level: 'warning',
        title: 'High Memory Usage',
        message: `Memory usage at ${(memoryUsagePercent * 100).toFixed(2)}%, exceeding threshold of ${this.alertThresholds.memoryUsage * 100}%`,
        metadata: {
          used: `${(metrics.memoryUsed / 1024 / 1024).toFixed(2)} MB`,
          total: `${(metrics.memoryTotal / 1024 / 1024).toFixed(2)} MB`,
          available: `${(metrics.memoryAvailable / 1024 / 1024).toFixed(2)} MB`,
        },
      });
    }
  }
}

// src/app.module.ts - Updated with monitoring
import { Module, MiddlewareConsumer, NestModule } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { PrometheusModule } from '@willsoto/nestjs-prometheus';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor';
import { SecurityMiddleware } from './common/middleware/security.middleware';
import { MetricsService } from './common/metrics/prometheus.service';
import { AlertService } from './common/services/alert.service';
// ... other imports

@Module({
  imports: [
    // ... existing modules
    ScheduleModule.forRoot(),
    PrometheusModule.register({
      path: '/metrics',
      defaultMetrics: {
        enabled: true,
      },
    }),
  ],
  providers: [
    {
      provide: APP_INTERCEPTOR,
      useClass: LoggingInterceptor,
    },
    MetricsService,
    AlertService,
    // ... other providers
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(SecurityMiddleware)
      .forRoutes('*');
  }
}