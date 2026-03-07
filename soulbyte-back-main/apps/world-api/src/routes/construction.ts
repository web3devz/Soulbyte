/**
 * Construction Routes
 */
import { FastifyInstance } from 'fastify';
import { prisma } from '../db.js';

export async function constructionRoutes(app: FastifyInstance) {
    app.get('/api/v1/construction/projects', async (_request, reply) => {
        const projects = await prisma.constructionProject.findMany({
            orderBy: { createdAt: 'desc' },
            take: 100
        });
        return reply.send({ projects });
    });

    app.get('/api/v1/construction/projects/:id', async (request, reply) => {
        const { id } = request.params as { id: string };
        const project = await prisma.constructionProject.findUnique({ where: { id } });
        if (!project) return reply.code(404).send({ error: 'Project not found' });
        return reply.send({ project });
    });

    app.get('/api/v1/construction/quotes', async (request, reply) => {
        const { request_id, lot_id } = request.query as { request_id?: string; lot_id?: string };
        let requestIds: string[] = [];
        if (request_id) {
            requestIds = [request_id];
        } else if (lot_id) {
            const requests = await prisma.constructionRequest.findMany({
                where: { lotId: lot_id, status: { in: ['pending', 'quoted'] } },
                orderBy: { createdAt: 'desc' },
                take: 5
            });
            requestIds = requests.map(r => r.id);
        }
        const quotes = requestIds.length
            ? await prisma.constructionQuote.findMany({
                where: { requestId: { in: requestIds }, status: 'pending' },
                orderBy: { createdAt: 'desc' }
            })
            : [];
        return reply.send({ quotes });
    });

    app.get('/api/v1/businesses/:id/construction-history', async (request, reply) => {
        const { id } = request.params as { id: string };
        const history = await prisma.constructionProject.findMany({
            where: { constructorId: id },
            orderBy: { createdAt: 'desc' }
        });
        return reply.send({ history });
    });
}
