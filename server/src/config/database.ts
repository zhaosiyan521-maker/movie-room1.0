import { PrismaClient } from '@prisma/client';

// 兜底：未配置 .env / DATABASE_URL 时，也能连上项目目录下的本地 SQLite
// （路径相对 server 目录；一键启动脚本会优先从 .env.example 生成 .env）
if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = 'file:./dev.db';
}

export const prisma = new PrismaClient({
  log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error']
});

// 优雅关闭
process.on('beforeExit', async () => {
  await prisma.$disconnect();
});
