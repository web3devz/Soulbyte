import fs from 'fs';
import path from 'path';
import { ethers } from 'ethers';
import { prisma } from '../db.js';
import { RPC_CONFIG } from '../config/network.js';

const ERROR_LOG_PATH = path.resolve(process.cwd(), 'logs/rpc-errors.log');

type RpcEndpoint = {
    url: string;
    label: string;
};

export class ResilientProvider {
    private endpoints: RpcEndpoint[];

    constructor() {
        const primary = RPC_CONFIG.primary;
        const fallbacks = RPC_CONFIG.fallbacks ?? [];
        const all = [primary, ...fallbacks].filter(Boolean);
        const unique = Array.from(new Set(all));
        this.endpoints = unique.map((url, index) => ({
            url,
            label: index === 0 ? 'primary' : `fallback_${index}`
        }));
    }

    async execute<T>(
        operation: (provider: ethers.JsonRpcProvider) => Promise<T>,
        context: string
    ): Promise<T> {
        const retriesPerEndpoint = Math.max(1, Number(RPC_CONFIG.retryAttempts ?? 3));
        const retryDelayMs = Math.max(100, Number(RPC_CONFIG.retryDelayMs ?? 500));

        for (const endpoint of this.endpoints) {
            const provider = new ethers.JsonRpcProvider(endpoint.url);
            for (let attempt = 1; attempt <= retriesPerEndpoint; attempt += 1) {
                try {
                    return await operation(provider);
                } catch (error) {
                    const isLastAttempt = attempt === retriesPerEndpoint;
                    const isLastEndpoint = endpoint === this.endpoints[this.endpoints.length - 1];
                    if (!isLastAttempt) {
                        await sleep(retryDelayMs);
                        continue;
                    }
                    if (!isLastEndpoint) {
                        console.warn(
                            `[RPC] All retries failed on ${endpoint.url} for [${context}]. Falling back.`
                        );
                        break;
                    }
                    const message = `[RPC FATAL] All endpoints exhausted for [${context}]. ` +
                        `Error: ${error instanceof Error ? error.message : String(error)}`;
                    await this.logError(message, context);
                    throw new Error(message);
                }
            }
        }

        throw new Error(`[RPC] Unexpected exit from retry loop for [${context}]`);
    }

    private async logError(message: string, context: string): Promise<void> {
        const timestamp = new Date().toISOString();
        const entry = `${timestamp} | ${message}\n`;

        try {
            fs.mkdirSync(path.dirname(ERROR_LOG_PATH), { recursive: true });
            fs.appendFileSync(ERROR_LOG_PATH, entry, 'utf8');
        } catch {
            console.error('[RPC] Failed to write error log to file');
        }

        try {
            await prisma.rpcErrorLog.create({
                data: {
                    context,
                    message,
                    occurredAt: new Date()
                }
            });
        } catch {
            console.error('[RPC] Failed to write error log to database');
        }

        console.error(message);
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

export const resiProvider = new ResilientProvider();
