import { Hono } from "hono";
import { cors } from 'hono/cors'
import type { Env } from "./types";
import { resolveAllHandler } from "./routes/links";

const app = new Hono<{ Bindings: Env }>();

// 简单 CORS 中间件（你可以按域名白名单来做）
app.use('*', cors({ origin: '*', allowMethods: ['GET', 'POST', 'OPTIONS'], allowHeaders: ['Content-Type'], maxAge: 86400 }));

// 对应原 /api/links/resolve-all
app.post("/api/links/resolve-all", resolveAllHandler);

export default app;
