/**
 * Market Routes
 */
import { FastifyInstance } from 'fastify';
import { prisma } from '../db.js';

const humanizeItemName = (value: string) => {
    return value
        .toLowerCase()
        .split('_')
        .map((part) => (part.length > 0 ? part[0].toUpperCase() + part.slice(1) : part))
        .join(' ');
};

export async function marketRoutes(app: FastifyInstance) {
    /**
     * GET /api/v1/market/listings
     * Query params: cityId, itemName, sort, limit, offset
     */
    app.get('/api/v1/market/listings', async (request, reply) => {
        const {
            cityId,
            itemName,
            sort,
            sortBy,
            limit = 50,
            offset = 0
        } = request.query as {
            cityId?: string;
            itemName?: string;
            sort?: string;
            sortBy?: string;
            limit?: number;
            offset?: number;
        };

        const where: Record<string, unknown> = {
            status: 'active'
        };

        if (cityId) {
            where.cityId = cityId;
        }

        if (itemName) {
            where.itemDef = {
                name: {
                    contains: itemName,
                    mode: 'insensitive'
                }
            };
        }

        let orderBy: Record<string, 'asc' | 'desc'> = { createdAt: 'desc' };
        const sortKey = sortBy ?? sort;
        if (sortKey === 'price' || sortKey === 'price_asc') {
            orderBy = { priceEach: 'asc' };
        } else if (sortKey === 'price_desc') {
            orderBy = { priceEach: 'desc' };
        }

        const listings = await prisma.marketListing.findMany({
            where,
            orderBy,
            skip: Math.max(Number(offset), 0),
            take: Math.min(Number(limit), 200),
            include: {
                itemDef: true,
                seller: { select: { id: true, name: true } }
            }
        });

        return reply.send({
            listings: listings.map((listing) => ({
                id: listing.id,
                sellerId: listing.sellerId,
                sellerName: listing.seller?.name ?? null,
                itemName: listing.itemDef.name,
                item: {
                    id: listing.itemDefId,
                    name: listing.itemDef.name,
                    displayName: humanizeItemName(listing.itemDef.name),
                    category: listing.itemDef.category,
                    description: listing.itemDef.description ?? null
                },
                seller: listing.seller,
                quantity: listing.quantity,
                priceEach: listing.priceEach.toString(),
                price: listing.priceEach.toString(),
                quality: null,
                cityId: listing.cityId,
                status: listing.status,
                listedAt: listing.createdAt,
                createdAt: listing.createdAt,
                expiresAt: listing.expiresAt
            }))
        });
    });
}
