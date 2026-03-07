/**
 * Database client singleton for world-api
 * Uses Prisma 7.x with pg adapter for PostgreSQL
 */
import pg from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../../generated/prisma/index.js';

// PostgreSQL connection pool
const connectionString = process.env.DATABASE_URL || 'postgresql://soulbyte:soulbyte@localhost:5432/soulbyte';
const pool = new pg.Pool({ connectionString });

// Prisma adapter for PostgreSQL
const adapter = new PrismaPg(pool);

// Create singleton instance with adapter
const globalForPrisma = globalThis as unknown as {
    prisma: PrismaClient | undefined;
};

export const prisma =
    globalForPrisma.prisma ??
    new PrismaClient({
        adapter,
        log: process.env.NODE_ENV === 'development'
            ? ['query', 'error', 'warn']
            : ['error'],
    });

if (process.env.NODE_ENV !== 'production') {
    globalForPrisma.prisma = prisma;
}

/**
 * Graceful shutdown helper
 */
export async function disconnectDB(): Promise<void> {
    await prisma.$disconnect();
    await pool.end();
}

/**
 * Connect and validate database
 */
export async function connectDB(): Promise<void> {
    try {
        // Test the connection by running a simple query
        await prisma.$connect();
        console.log('✓ Database connected');
    } catch (error) {
        console.error('✗ Database connection failed:', error);
        throw error;
    }
}

// Re-export Prisma types for use in other files
export { PrismaClient };
