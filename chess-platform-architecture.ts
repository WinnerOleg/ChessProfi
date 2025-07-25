// Project Structure
chess-learning-platform/
├── src/
│   ├── modules/
│   │   ├── auth/
│   │   │   ├── auth.module.ts
│   │   │   ├── auth.service.ts
│   │   │   ├── auth.controller.ts
│   │   │   ├── strategies/
│   │   │   │   └── jwt.strategy.ts
│   │   │   └── guards/
│   │   │       ├── jwt-auth.guard.ts
│   │   │       └── roles.guard.ts
│   │   ├── users/
│   │   │   ├── users.module.ts
│   │   │   ├── users.service.ts
│   │   │   ├── users.controller.ts
│   │   │   └── dto/
│   │   ├── games/
│   │   │   ├── games.module.ts
│   │   │   ├── games.service.ts
│   │   │   ├── games.gateway.ts        // WebSocket handler
│   │   │   └── games.controller.ts
│   │   ├── analysis/
│   │   │   ├── analysis.module.ts
│   │   │   ├── analysis.service.ts
│   │   │   ├── analysis.processor.ts    // BullMQ worker
│   │   │   └── stockfish.service.ts
│   │   ├── lessons/
│   │   │   ├── lessons.module.ts
│   │   │   ├── lessons.service.ts
│   │   │   └── lessons.controller.ts
│   │   └── ai-assistant/
│   │       ├── ai-assistant.module.ts
│   │       ├── ai-assistant.service.ts
│   │       └── pattern-recognition.ts
│   ├── common/
│   │   ├── decorators/
│   │   ├── filters/
│   │   ├── interceptors/
│   │   └── pipes/
│   ├── database/
│   │   ├── prisma.service.ts
│   │   └── redis.service.ts
│   └── main.ts
├── prisma/
│   └── schema.prisma
├── test/
├── docker-compose.yml
└── package.json

// Main Application Bootstrap
// src/main.ts
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisIoAdapter } from './adapters/redis-io.adapter';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const configService = app.get(ConfigService);
  
  // Enable CORS with specific origins
  app.enableCors({
    origin: configService.get('ALLOWED_ORIGINS')?.split(',') || ['http://localhost:3000'],
    credentials: true,
  });
  
  // Global validation pipe with transformation
  app.useGlobalPipes(new ValidationPipe({
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
  }));
  
  // Redis adapter for WebSocket scaling
  const redisIoAdapter = new RedisIoAdapter(app);
  await redisIoAdapter.connectToRedis();
  app.useWebSocketAdapter(redisIoAdapter);
  
  // Swagger documentation
  const config = new DocumentBuilder()
    .setTitle('Chess Learning Platform API')
    .setDescription('Real-time collaborative chess learning')
    .setVersion('1.0')
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api/docs', app, document);
  
  await app.listen(configService.get('PORT') || 3000);
}
bootstrap();

// Prisma Schema
// prisma/schema.prisma
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

generator client {
  provider = "prisma-client-js"
}

enum UserRole {
  STUDENT
  COACH
  ADMIN
}

enum GameStatus {
  ACTIVE
  COMPLETED
  ABANDONED
}

model User {
  id        String   @id @default(cuid())
  email     String   @unique
  password  String
  name      String
  role      UserRole
  rating    Int      @default(1200)
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  
  // Relations
  studentsGames Game[]   @relation("StudentGames")
  coachGames    Game[]   @relation("CoachGames")
  lessons       Lesson[]
  progress      Progress[]
  
  @@index([email])
  @@index([role])
}

model Game {
  id         String     @id @default(cuid())
  studentId  String
  coachId    String
  pgn        String     @db.Text
  fen        String     // Current position
  status     GameStatus @default(ACTIVE)
  startedAt  DateTime   @default(now())
  endedAt    DateTime?
  
  // Relations
  student    User       @relation("StudentGames", fields: [studentId], references: [id])
  coach      User       @relation("CoachGames", fields: [coachId], references: [id])
  moves      Move[]
  analysis   Analysis?
  lesson     Lesson?    @relation(fields: [lessonId], references: [id])
  lessonId   String?
  
  @@index([studentId, coachId])
  @@index([status])
}

model Move {
  id          String   @id @default(cuid())
  gameId      String
  moveNumber  Int
  notation    String   // e.g., "e4", "Nf3"
  fen         String   // Position after move
  evaluation  Float?   // Stockfish evaluation
  annotation  String?  // Coach's comment
  timestamp   DateTime @default(now())
  
  game        Game     @relation(fields: [gameId], references: [id], onDelete: Cascade)
  
  @@unique([gameId, moveNumber])
  @@index([gameId])
}

model Analysis {
  id           String   @id @default(cuid())
  gameId       String   @unique
  blunders     Json     // Array of move numbers and severity
  mistakes     Json
  inaccuracies Json
  bestMoves    Json
  evaluation   Float    // Overall game quality (0-100)
  createdAt    DateTime @default(now())
  
  game         Game     @relation(fields: [gameId], references: [id])
}

model Lesson {
  id          String    @id @default(cuid())
  title       String
  description String?
  coachId     String
  topics      String[]  // e.g., ["opening", "tactics", "endgame"]
  createdAt   DateTime  @default(now())
  
  coach       User      @relation(fields: [coachId], references: [id])
  games       Game[]
  progress    Progress[]
  
  @@index([coachId])
}

model Progress {
  id              String   @id @default(cuid())
  userId          String
  lessonId        String
  completionRate  Float    @default(0) // 0-100
  weaknesses      Json     // Identified pattern weaknesses
  strengths       Json
  lastActivityAt  DateTime @default(now())
  
  user            User     @relation(fields: [userId], references: [id])
  lesson          Lesson   @relation(fields: [lessonId], references: [id])
  
  @@unique([userId, lessonId])
  @@index([userId])
}