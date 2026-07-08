// @ts-nocheck
import { PrismaClient } from '@prisma/client';
// PrismaClient 建议全局复用，避免热更新时创建过多数据库连接。
export const prisma = new PrismaClient();
