// test/setup.ts - Global test configuration
// This sets up our testing environment like preparing a chess board
import { Test } from '@nestjs/testing';
import { PrismaService } from '../src/database/prisma.service';
import { RedisService } from '../src/database/redis.service';

// Mock services for isolated testing
export const mockPrismaService = {
  user: {
    create: jest.fn(),
    findUnique: jest.fn(),
    findMany: jest.fn(),
    update: jest.fn(),
  },
  game: {
    create: jest.fn(),
    findUnique: jest.fn(),
    update: jest.fn(),
  },
  // Add other models as needed
};

export const mockRedisService = {
  get: jest.fn(),
  set: jest.fn(),
  setex: jest.fn(),
  del: jest.fn(),
};

// test/unit/auth.service.spec.ts
// Unit tests are like analyzing individual chess pieces
import { Test, TestingModule } from '@nestjs/testing';
import { AuthService } from '../../src/modules/auth/auth.service';
import { UsersService } from '../../src/modules/users/users.service';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';

describe('AuthService - Testing our authentication logic', () => {
  let authService: AuthService;
  let usersService: UsersService;
  let jwtService: JwtService;

  // Set up our testing board before each game
  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        {
          provide: UsersService,
          useValue: {
            findByEmail: jest.fn(),
            create: jest.fn(),
            findById: jest.fn(),
          },
        },
        {
          provide: JwtService,
          useValue: {
            sign: jest.fn(),
            verify: jest.fn(),
          },
        },
      ],
    }).compile();

    authService = module.get<AuthService>(AuthService);
    usersService = module.get<UsersService>(UsersService);
    jwtService = module.get<JwtService>(JwtService);
  });

  describe('login - Testing user authentication', () => {
    it('should return JWT token for valid credentials', async () => {
      // Arrange - Set up our test position
      const mockUser = {
        id: '123',
        email: 'player@chess.com',
        password: await bcrypt.hash('password123', 10),
        name: 'Chess Player',
        role: 'STUDENT',
        rating: 1200,
      };

      const mockToken = 'mock-jwt-token';

      // Configure our mocks to return expected values
      jest.spyOn(usersService, 'findByEmail').mockResolvedValue(mockUser);
      jest.spyOn(jwtService, 'sign').mockReturnValue(mockToken);

      // Act - Make our move
      const result = await authService.login({
        email: 'player@chess.com',
        password: 'password123',
      });

      // Assert - Check if we achieved checkmate
      expect(result).toEqual({
        access_token: mockToken,
        user: {
          id: mockUser.id,
          email: mockUser.email,
          name: mockUser.name,
          role: mockUser.role,
          rating: mockUser.rating,
        },
      });

      // Verify our pieces moved correctly
      expect(usersService.findByEmail).toHaveBeenCalledWith('player@chess.com');
      expect(jwtService.sign).toHaveBeenCalledWith({
        sub: mockUser.id,
        email: mockUser.email,
        role: mockUser.role,
      });
    });

    it('should throw UnauthorizedException for invalid password', async () => {
      // This tests our defense against invalid attacks
      const mockUser = {
        id: '123',
        email: 'player@chess.com',
        password: await bcrypt.hash('correctpassword', 10),
      };

      jest.spyOn(usersService, 'findByEmail').mockResolvedValue(mockUser);

      // Expect the service to defend against wrong password
      await expect(
        authService.login({
          email: 'player@chess.com',
          password: 'wrongpassword',
        })
      ).rejects.toThrow('Invalid credentials');
    });
  });

  describe('register - Testing new user creation', () => {
    it('should create user and return JWT token', async () => {
      // Testing our opening moves for new players
      const registerDto = {
        email: 'newplayer@chess.com',
        password: 'securepass123',
        name: 'New Player',
        role: 'STUDENT' as const,
      };

      const mockCreatedUser = {
        id: 'new-user-id',
        ...registerDto,
        password: 'hashed-password',
        rating: 1200,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const mockToken = 'new-user-token';

      // Set up our expected game flow
      jest.spyOn(usersService, 'create').mockResolvedValue(mockCreatedUser);
      jest.spyOn(jwtService, 'sign').mockReturnValue(mockToken);

      // Execute the registration
      const result = await authService.register(registerDto);

      // Verify the outcome
      expect(result.access_token).toBe(mockToken);
      expect(result.user.email).toBe(registerDto.email);
      
      // Ensure password was hashed (security check)
      const createCall = (usersService.create as jest.Mock).mock.calls[0][0];
      expect(createCall.password).not.toBe(registerDto.password);
      expect(await bcrypt.compare(registerDto.password, createCall.password)).toBe(true);
    });
  });
});

// test/integration/games.e2e-spec.ts
// Integration tests are like playing a full game
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/database/prisma.service';
import * as io from 'socket.io-client';

describe('Games E2E - Testing the complete game flow', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let authToken: string;
  let gameId: string;

  // Prepare the tournament hall
  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    prisma = app.get<PrismaService>(PrismaService);
    
    // Initialize our application
    await app.init();
    await app.listen(3001); // Different port for testing

    // Clean database - Fresh board
    await prisma.game.deleteMany();
    await prisma.user.deleteMany();

    // Create test users - Our players
    const studentResponse = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        email: 'student@test.com',
        password: 'password123',
        name: 'Test Student',
        role: 'STUDENT',
      });

    authToken = studentResponse.body.access_token;

    const coachResponse = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        email: 'coach@test.com',
        password: 'password123',
        name: 'Test Coach',
        role: 'COACH',
      });

    // Create a game between student and coach
    const gameResponse = await request(app.getHttpServer())
      .post('/games')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        coachId: coachResponse.body.user.id,
      });

    gameId = gameResponse.body.id;
  });

  afterAll(async () => {
    await app.close();
  });

  describe('HTTP Endpoints - Testing REST API moves', () => {
    it('should create a new game', async () => {
      // Already tested in beforeAll, but let's verify the structure
      const response = await request(app.getHttpServer())
        .get(`/games/${gameId}`)
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        id: gameId,
        status: 'ACTIVE',
        fen: expect.stringContaining('rnbqkbnr'), // Starting position
      });
    });

    it('should analyze a completed game', async () => {
      // First, let's complete a game with some moves
      // This would typically be done via WebSocket, but for testing...
      
      // Request analysis
      const response = await request(app.getHttpServer())
        .post(`/analysis/game/${gameId}`)
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(202); // Accepted for processing
      expect(response.body).toMatchObject({
        message: 'Analysis queued',
        jobId: expect.any(String),
      });
    });
  });

  describe('WebSocket - Testing real-time gameplay', () => {
    let studentSocket: any;
    let coachSocket: any;

    beforeEach((done) => {
      // Connect both players to the game
      studentSocket = io('http://localhost:3001/games', {
        auth: { token: authToken },
      });

      // In real test, get coach token properly
      coachSocket = io('http://localhost:3001/games', {
        auth: { token: 'coach-token' },
      });

      let connectCount = 0;
      const checkConnected = () => {
        connectCount++;
        if (connectCount === 2) done();
      };

      studentSocket.on('connect', checkConnected);
      coachSocket.on('connect', checkConnected);
    });

    afterEach(() => {
      studentSocket.disconnect();
      coachSocket.disconnect();
    });

    it('should allow players to make moves', (done) => {
      // Join the game room
      studentSocket.emit('joinGame', { gameId });

      // Listen for game state
      studentSocket.on('gameState', (state: any) => {
        expect(state.fen).toBeDefined();
        expect(state.turn).toBe('w'); // White to move

        // Make a move (e4)
        studentSocket.emit('makeMove', {
          gameId,
          move: 'e4',
        });
      });

      // Listen for move confirmation
      studentSocket.on('moveMade', (moveData: any) => {
        expect(moveData.move).toBe('e4');
        expect(moveData.turn).toBe('b'); // Black's turn now
        expect(moveData.latency).toBeLessThan(100); // Performance check
        done();
      });
    });

    it('should allow coaches to undo moves', (done) => {
      // This demonstrates the teaching capability
      coachSocket.emit('joinGame', { gameId });

      coachSocket.on('gameState', () => {
        // Request undo
        coachSocket.emit('undoMove', { gameId });
      });

      coachSocket.on('moveUndone', (state: any) => {
        expect(state.fen).toBeDefined();
        done();
      });
    });
  });
});

// test/performance/load.test.ts
// Performance tests are like simultaneous exhibitions
import { check, sleep } from 'k6';
import http from 'k6/http';
import { Rate } from 'k6/metrics';

// Custom metrics to track our performance
const errorRate = new Rate('errors');

export const options = {
  stages: [
    { duration: '2m', target: 100 }, // Ramp up to 100 users
    { duration: '5m', target: 100 }, // Stay at 100 users
    { duration: '2m', target: 200 }, // Ramp up to 200 users
    { duration: '5m', target: 200 }, // Stay at 200 users
    { duration: '2m', target: 0 },   // Ramp down to 0 users
  ],
  thresholds: {
    http_req_duration: ['p(95)<500'], // 95% of requests under 500ms
    errors: ['rate<0.1'],             // Error rate under 10%
  },
};

export default function () {
  // Simulate a user session
  const BASE_URL = 'http://localhost:3000';
  
  // 1. Login
  const loginRes = http.post(`${BASE_URL}/auth/login`, JSON.stringify({
    email: `user${Math.random()}@test.com`,
    password: 'password123',
  }), {
    headers: { 'Content-Type': 'application/json' },
  });
  
  check(loginRes, {
    'login successful': (r) => r.status === 200,
    'login fast': (r) => r.timings.duration < 300,
  });
  
  errorRate.add(loginRes.status !== 200);
  
  if (loginRes.status === 200) {
    const token = loginRes.json('access_token');
    
    // 2. Create a game
    const gameRes = http.post(`${BASE_URL}/games`, JSON.stringify({
      coachId: 'test-coach-id',
    }), {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
    });
    
    check(gameRes, {
      'game created': (r) => r.status === 201,
      'game creation fast': (r) => r.timings.duration < 200,
    });
    
    // 3. Simulate gameplay
    sleep(1); // Think time between moves
    
    // 4. Request analysis
    if (gameRes.status === 201) {
      const gameId = gameRes.json('id');
      const analysisRes = http.post(
        `${BASE_URL}/analysis/game/${gameId}`,
        null,
        {
          headers: { 'Authorization': `Bearer ${token}` },
        }
      );
      
      check(analysisRes, {
        'analysis queued': (r) => r.status === 202,
      });
    }
  }
  
  sleep(1); // Wait before next iteration
}

// test/monitoring/health-checks.spec.ts
// Health checks are like checking if all pieces are on the board
describe('Health Monitoring - System vitals', () => {
  it('should report healthy when all services are up', async () => {
    const response = await request(app.getHttpServer())
      .get('/health');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      status: 'healthy',
      services: {
        database: 'connected',
        redis: 'connected',
        stockfish: 'available',
      },
      uptime: expect.any(Number),
      memory: {
        used: expect.any(Number),
        total: expect.any(Number),
        percentage: expect.any(Number),
      },
    });
  });

  it('should measure WebSocket latency', async () => {
    // This ensures our real-time features stay responsive
    const latencyTest = await measureWebSocketLatency();
    
    expect(latencyTest.average).toBeLessThan(50); // Under 50ms average
    expect(latencyTest.p95).toBeLessThan(100);    // 95th percentile under 100ms
    expect(latencyTest.p99).toBeLessThan(200);    // 99th percentile under 200ms
  });
});

// Helper function to measure WebSocket performance
async function measureWebSocketLatency() {
  const measurements: number[] = [];
  const socket = io('http://localhost:3001/games');
  
  return new Promise((resolve) => {
    socket.on('connect', () => {
      // Send 100 ping messages
      for (let i = 0; i < 100; i++) {
        const start = Date.now();
        socket.emit('ping', { timestamp: start });
        
        socket.once('pong', () => {
          measurements.push(Date.now() - start);
          
          if (measurements.length === 100) {
            // Calculate statistics
            measurements.sort((a, b) => a - b);
            const stats = {
              average: measurements.reduce((a, b) => a + b, 0) / measurements.length,
              median: measurements[50],
              p95: measurements[95],
              p99: measurements[99],
              min: measurements[0],
              max: measurements[99],
            };
            
            socket.disconnect();
            resolve(stats);
          }
        });
      }
    });
  });
}