// @ts-nocheck
/**
 * @file services/rag-service/src/routes/admin-page.ts
 * @module RAG Service 兼容层
 * @description 提供 /kb-admin 知识库管理页面路由。
 * @see 联动关注：public/kb-admin.html。
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
export async function adminPageRoutes(app) {
    app.get('/', async (_request, reply) => reply.redirect('/kb-admin'));
    app.get('/kb-admin', async (_request, reply) => {
        // 本地管理页作为 rag-service 的静态调试入口，避免第一版再引入前端构建链路。
        const html = await readFile(resolve(process.cwd(), 'public/kb-admin.html'), 'utf-8');
        return reply.type('text/html; charset=utf-8').send(html);
    });
}
