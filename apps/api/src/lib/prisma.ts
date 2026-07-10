// @ts-nocheck
/**
 * @file apps/api/src/lib/prisma.ts
 * @module API 入口与基础设施
 * @description 创建并导出 Prisma Client 单例。
 * @see 联动关注：schema.prisma 和 DATABASE_URL。
 */
import { PrismaClient } from '@prisma/client';
// PrismaClient 建议全局复用，避免热更新时创建过多数据库连接。
export const prisma = new PrismaClient();
