import { createMiddleware } from 'hono/factory';

export const auth = () =>
  createMiddleware(async (c, next) => {
    const authHeader = c.req.header('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return new Response('Missing or invalid authentication token', {
        status: 401,
        headers: { 'Content-Type': 'text/plain' },
      });
    }

    const token = authHeader.split(' ')[1];

    if (token !== c.env.NX_CACHE_ACCESS_TOKEN) {
      return new Response('Missing or invalid authentication token', {
        status: 401,
        headers: { 'Content-Type': 'text/plain' },
      });
    }

    await next();
  });
