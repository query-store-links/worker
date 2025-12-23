import type { Context } from "hono";
import type {
    Env,
    ResolveAllRequest,
    ResolveAllResponse
} from "../types";
import {
    parseRequestContent,
    getCookie,
    getAppInformation,
    getFileListXml,
    getAppxPackages,
    getNonAppxPackages
} from "../helpers/queryLinks";

/**
 * 从 KV 获取模板，不存在则尝试从远程拉取并写回 KV。
 * 对应 C# 的 GetOrDownloadTemplateAsync，只是把文件系统换成 KV。
 */
async function getOrDownloadTemplate(
    c: Context<{ Bindings: Env }>,
    fileName: "cookie.xml" | "wu.xml" | "url.xml"
): Promise<string> {
    const env = c.env;
    const kvKey = `xml/${fileName}`;

    // 先从 KV 读
    const cached = await env.XML_TEMPLATES.get(kvKey);
    if (cached) return cached;

    // 远程拉取
    const url = `https://assets.krnl64.win/qsl/xml/${fileName}`;
    try {
        const resp = await fetch(url);
        if (!resp.ok) return "";
        const text = await resp.text();

        // 写回 KV（异步不 await 也行，这里还是 await 一下）
        await env.XML_TEMPLATES.put(kvKey, text);

        return text;
    } catch {
        return "";
    }
}

/**
 * 日志：简化版（打到 Worker 日志）
 */
async function logException(
    c: Context<{ Bindings: Env }>,
    ex: unknown,
    context: string,
    productId: string | undefined,
    req: ResolveAllRequest
) {
    const err =
        ex instanceof Error ? ex : new Error(String(ex ?? "Unknown error"));
    console.error(
        `[${new Date().toISOString()}] ${context} Product=${productId} Input=${req.productInput
        } Market=${req.market} Locale=${req.locale} Ring=${req.ring
        }\n${err.stack ?? err.message}\n----`
    );
}

export async function resolveAllHandler(
    c: Context<{ Bindings: Env }>
) {
    const env = c.env;

    let body: ResolveAllRequest;
    try {
        body = (await c.req.json()) as ResolveAllRequest;
    } catch {
        return c.text("Request body is required and must be JSON.", 400);
    }

    const errors: string[] = [];
    const productId = parseRequestContent(body.productInput ?? "");

    const resp: ResolveAllResponse = {
        productId: productId
    };

    // Cookie
    let cookieTemplate = await getOrDownloadTemplate(c, "cookie.xml");
    if (!cookieTemplate.trim()) {
        errors.push("Missing cookie.xml in KV and failed to download default.");
    } else {
        try {
            resp.cookie = await getCookie(env, cookieTemplate);
            if (!resp.cookie) {
                errors.push("Cookie not obtained or empty.");
            }
        } catch (ex) {
            errors.push("Cookie error: " + (ex as Error).message);
            await logException(c, ex, "Cookie error", productId, body);
        }
    }

    // AppInfo
    try {
        const market =
            body.market || env.DEFAULT_MARKET || "CN";
        const locale =
            body.locale || env.DEFAULT_LOCALE || "zh-CN";
        const { requestResult, appInfo, error} = await getAppInformation(
            env,
            productId,
            market,
            locale
        );
        if (requestResult) {
            resp.appInfo = appInfo;
        } else {
            errors.push("Failed to get app information." + (error ? " " + error : ""));
        }
    } catch (ex) {
        errors.push("AppInfo error: " + (ex as Error).message);
        await logException(c, ex, "AppInfo error", productId, body);
    }

    // FileListXml（依赖 Cookie + CategoryId）
    if (resp.appInfo?.CategoryId && resp.cookie) {
        const wuTemplate = await getOrDownloadTemplate(c, "wu.xml");
        if (!wuTemplate.trim()) {
            errors.push("Missing wu.xml in KV and failed to download default.");
        } else {
            try {
                const ring = body.ring || env.DEFAULT_RING || "Retail";
                resp.fileListXml = await getFileListXml(
                    env,
                    resp.cookie,
                    resp.appInfo.CategoryId,
                    ring,
                    wuTemplate
                );
            } catch (ex) {
                errors.push("FileList error: " + (ex as Error).message);
                await logException(c, ex, "FileList error", productId, body);
            }
        }
    }

    // APPX
    if (body.includeAppx !== false && resp.fileListXml) {
        const urlTemplate = await getOrDownloadTemplate(c, "url.xml");
        if (!urlTemplate.trim()) {
            errors.push("Missing url.xml in KV and failed to download default.");
        } else {
            try {
                const ring = body.ring || env.DEFAULT_RING || "Retail";
                resp.appxPackages = await getAppxPackages(
                    env,
                    resp.fileListXml,
                    ring,
                    urlTemplate
                );
            } catch (ex) {
                errors.push("Appx parse error: " + (ex as Error).message);
                await logException(c, ex, "Appx parse error", productId, body);
            }
        }
    }

    // Non-APPX
    if (body.includeNonAppx !== false) {
        try {
            const market =
                body.market || env.DEFAULT_MARKET || "CN";
            resp.nonAppxPackages = await getNonAppxPackages(
                env,
                productId,
                market
            );
        } catch (ex) {
            errors.push("NonAppx error: " + (ex as Error).message);
            await logException(c, ex, "NonAppx error", productId, body);
        }
    }

    resp.errors = errors;

    // 可以按需要加 CORS
    return c.json(resp);
}
