import { parseXml } from "../utils/xml";
import { formatBytes } from "../utils/bytes";
import { parseRequestContent } from "../utils/parse";
import type { AppInfo, DownloadItem, Env } from "../types";

const COOKIE_URI =
  "https://fe3.delivery.mp.microsoft.com/ClientWebService/client.asmx";
const FILELIST_URI =
  "https://fe3.delivery.mp.microsoft.com/ClientWebService/client.asmx";
const URL_URI =
  "https://fe3.delivery.mp.microsoft.com/ClientWebService/client.asmx/secured";

// 暴露给 route 用的：解析 ProductInput
export { parseRequestContent };

/**
 * GetCookieAsync：发送 SOAP，取 EncryptedData
 */
export async function getCookie(
  env: Env,
  cookieSoapTemplate: string
): Promise<string> {
  if (!cookieSoapTemplate.trim()) {
    throw new Error("cookieSoapTemplate 不能为空（请提供 cookie.xml 内容）");
  }

  const resp = await fetch(COOKIE_URI, {
    method: "POST",
    headers: {
      "Content-Type": "application/soap+xml; charset=utf-8"
    },
    body: cookieSoapTemplate
  });

  if (!resp.ok) return "";

  const text = await resp.text();
  if (!text) return "";

  const doc = parseXml<any>(text);

  // 因为 removeNSPrefix=true，EncryptedData 通常可以直接访问
  // 但 SOAP 结构不完全固定，这里做一个宽松的查找
  const encryptedData = findFirstNodeValue(doc, "EncryptedData");
  return encryptedData ?? "";
}

/**
 * GetAppInformationAsync：访问 /v9.0/products/{productId}
 */
export async function getAppInformation(
  env: Env,
  productId: string,
  market: string,
  locale: string
): Promise<{ requestResult: boolean; appInfo: AppInfo; error?: string }> {

  const appInfo: AppInfo = {
    Name: "",
    Publisher: "",
    Description: "",
    CategoryId: "",
    ProductId: productId
  };

  if (!productId.trim()) {
    return { requestResult: false, appInfo, error: "ProductId is empty" };
  }

  const url = `https://storeedgefd.dsx.mp.microsoft.com/v9.0/products/${encodeURIComponent(
    productId
  )}?market=${encodeURIComponent(market)}&locale=${encodeURIComponent(
    locale
  )}&deviceFamily=Windows.Desktop`;

  const resp = await fetch(url);

  if (!resp.ok) {
    return {
      requestResult: false,
      appInfo,
      error: `HTTP ${resp.status} ${resp.statusText}`
    };
  }

  let json: any;
  try {
    json = await resp.json();
  } catch (ex) {
    return {
      requestResult: false,
      appInfo,
      error: "JSON parse error: " + (ex as Error).message
    };
  }

  const payload = json?.Payload;
  if (!payload) {
    return {
      requestResult: false,
      appInfo,
      error: "Payload missing in response"
    };
  }

  appInfo.Name = payload.Title ?? "";
  appInfo.Publisher = payload.PublisherName ?? "";
  appInfo.Description = payload.Description ?? "";

  const skus = payload.Skus;
  if (Array.isArray(skus) && skus.length > 0) {
    const fdStr = skus[0]?.FulfillmentData;
    if (typeof fdStr === "string") {
      try {
        const fdJson = JSON.parse(fdStr);
        appInfo.CategoryId = fdJson?.WuCategoryId ?? "";
      } catch {
        // ignore
      }
    }
  }

  return { requestResult: true, appInfo };
}


/**
 * GetFileListXmlAsync：WU SOAP，返回 XML 字符串，做 HTML 实体还原
 */
export async function getFileListXml(
  env: Env,
  cookie: string,
  categoryId: string,
  ring: string,
  wuSoapTemplate: string
): Promise<string> {
  if (!cookie.trim()) throw new Error("cookie 不能为空，请先获取 Cookie");
  if (!categoryId.trim()) throw new Error("categoryId 不能为空");
  if (!ring.trim()) throw new Error("ring 不能为空");
  if (!wuSoapTemplate.trim()) {
    throw new Error("wuSoapTemplate 不能为空（请提供 wu.xml 内容）");
  }

  let body = wuSoapTemplate
    .replace("{1}", cookie)
    .replace("{2}", categoryId)
    .replace("{3}", ring)
    .replace("{cookie}", cookie)
    .replace("{categoryId}", categoryId)
    .replace("{ring}", ring);

  const resp = await fetch(FILELIST_URI, {
    method: "POST",
    headers: {
      "Content-Type": "application/soap+xml; charset=utf-8"
    },
    body
  });

  if (!resp.ok) return "";

  let text = await resp.text();
  // C# 原逻辑：做 HTML 实体替换
  text = text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;lt;/g, "<")
    .replace(/&amp;gt;/g, ">");

  return text;
}

/**
 * GetAppxPackagesAsync：解析 fileListXml，然后对每个 SecuredFragment 调用 secured 接口拿真实 URL
 */
export async function getAppxPackages(
  env: Env,
  fileListXml: string,
  ring: string,
  urlSoapTemplate: string
): Promise<DownloadItem[]> {

  const result: DownloadItem[] = [];
  if (!fileListXml.trim()) return result;

  const doc = parseXml<any>(fileListXml);

  // 找到所有 ExtendedUpdateInfo → Update
  const updates = findAllNodes(doc, "Update");

  const tasks = updates.map(async update => {
    const xmlNode = update?.Xml;
    if (!xmlNode) return;

    const filesNode = xmlNode?.Files;
    if (!filesNode) return;

    const files = Array.isArray(filesNode.File)
      ? filesNode.File
      : [filesNode.File];

    for (const f of files) {
      const fileName = f["@_FileName"] ?? "";
      const digest = f["@_Digest"] ?? "";
      const size = Number(f["@_Size"] ?? 0);

      const installerId = f["@_InstallerSpecificIdentifier"] ?? "";
      const rawFileName = f["@_FileName"] ?? "";

      let ext = "";
      const dotIndex = rawFileName.lastIndexOf(".");
      if (dotIndex >= 0) {
        ext = rawFileName.substring(dotIndex);
      }

      const finalFileName = installerId + ext;

      if (!installerId || !digest) continue;

      // 调用 secured SOAP 获取真实 URL
      const url = await getAppxUrl(
        env,
        installerId,
        "1",
        ring,
        digest,
        urlSoapTemplate
      );

      result.push({
        fileName: finalFileName,
        fileLink: url,
        fileSize: formatBytes(size),
        isSelected: false,
        isSelectMode: false
      });
    }
  });

  await Promise.all(tasks);
  return result;
}


/**
 * GetAppxUrlAsync：secured 接口，按 Digest 匹配 Url
 */
async function getAppxUrl(
  env: Env,
  updateID: string,
  revisionNumber: string,
  ring: string,
  digest: string,
  urlSoapTemplate: string
): Promise<string> {
  if (!urlSoapTemplate.trim()) {
    throw new Error("urlSoapTemplate 不能为空");
  }

  const body = urlSoapTemplate
    .replace("{1}", updateID)
    .replace("{2}", revisionNumber)
    .replace("{3}", ring)
    .replace("{updateID}", updateID)
    .replace("{revisionNumber}", revisionNumber)
    .replace("{ring}", ring);

  const resp = await fetch(URL_URI, {
    method: "POST",
    headers: {
      "Content-Type": "application/soap+xml; charset=utf-8"
    },
    body
  });

  if (!resp.ok) return "";

  const text = await resp.text();
  if (!text) return "";

  const doc = parseXml<any>(text);

  const fileLocations = findAllNodes(doc, "FileLocation");

  for (const fl of fileLocations) {
    const fileDigest: string = fl?.FileDigest ?? "";
    if (
      fileDigest &&
      digest &&
      fileDigest.toLowerCase() === digest.toLowerCase()
    ) {
      const url: string = fl?.Url ?? "";
      if (url) return url;
    }
  }

  return "";
}

/**
 * GetNonAppxPackagesAsync：packageManifests 接口
 */
export async function getNonAppxPackages(
  env: Env,
  productId: string,
  market: string
): Promise<DownloadItem[]> {
  const result: DownloadItem[] = [];
  if (!productId.trim()) return result;
  if (!market.trim()) {
    throw new Error("market 必须提供");
  }

  const url = `https://storeedgefd.dsx.mp.microsoft.com/v9.0/packageManifests/${encodeURIComponent(
    productId
  )}?market=${encodeURIComponent(market)}`;

  const resp = await fetch(url);
  if (!resp.ok) return result;

  const json = (await resp.json()) as any;
  const data = json?.Data;
  if (!data) return result;

  const versions = data.Versions;
  if (!Array.isArray(versions) || versions.length === 0) return result;

  const v0 = versions[0];
  const installers = v0?.Installers;
  if (!Array.isArray(installers)) return result;

  const tasks = installers.map(async (installer: any) => {
    const installerType: string = installer?.InstallerType ?? "";
    const installerUrl: string = installer?.InstallerUrl ?? "";
    const installerLocale: string = installer?.InstallerLocale ?? "";

    if (!installerUrl) return;

    const sizeBytes = await getNonAppxPackageFileSize(installerUrl);
    const sizeStr = formatBytes(sizeBytes);

    // EXE/MSI 或无类型：取文件名去扩展
    const isExeOrMsi =
      installerUrl.toLowerCase().endsWith(".exe") ||
      installerUrl.toLowerCase().endsWith(".msi");

    let fileName: string;
    if (!installerType || isExeOrMsi) {
      const lastSlash = installerUrl.lastIndexOf("/");
      const lastDot = installerUrl.lastIndexOf(".");
      if (lastSlash >= 0 && lastDot > lastSlash) {
        fileName = installerUrl.substring(lastSlash + 1, lastDot);
      } else {
        fileName = installerUrl.split("/").pop() ?? installerUrl;
      }
    } else {
      const name = installerUrl.split("/").pop() ?? installerUrl;
      fileName = `${name} (${installerLocale}).${installerType}`;
    }

    result.push({
      fileName: fileName,
      fileLink: installerUrl,
      fileSize: sizeStr,
      isSelected: false,
      isSelectMode: false
    });
  });

  await Promise.all(tasks);
  return result;
}

/**
 * HEAD 请求获取文件大小
 */
async function getNonAppxPackageFileSize(url: string): Promise<number> {
  const resp = await fetch(url, { method: "HEAD" });
  if (!resp.ok) return 0;
  const len = resp.headers.get("content-length");
  return len ? Number(len) || 0 : 0;
}

/**
 * 工具：在任意嵌套对象中宽松查找第一个指定 key 的值（递归）
 */
function findFirstNodeValue(obj: any, key: string): string | undefined {
  if (!obj || typeof obj !== "object") return undefined;
  if (key in obj && typeof obj[key] === "string") return obj[key];

  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (v && typeof v === "object") {
      const found = findFirstNodeValue(v, key);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

/**
 * 工具：查找所有指定名字的节点（假设 XML 已经去掉 namespace）
 */
function findAllNodes(obj: any, key: string): any[] {
  const result: any[] = [];
  function walk(node: any) {
    if (!node || typeof node !== "object") return;
    if (node[key]) {
      const val = node[key];
      if (Array.isArray(val)) {
        result.push(...val);
      } else {
        result.push(val);
      }
    }
    for (const k of Object.keys(node)) {
      const v = node[k];
      if (v && typeof v === "object") {
        walk(v);
      }
    }
  }
  walk(obj);
  return result;
}

/**
 * 工具：粗略模拟「祖先块」查找。
 * 这里 fast-xml-parser 输出的是树结构，我们没有真正的 parent 指针，
 * 所以用一个近似：在整体树中找同时包含所有 targetKeys 的上层对象。
 */
function findAncestorWith(
  root: any,
  targetKeys: string[]
): any | undefined {
  // 简化做法：在整个 root 中找同时含有这些 key 的节点
  let found: any | undefined;
  function walk(node: any) {
    if (!node || typeof node !== "object") return;
    if (found) return;

    const hasAll = targetKeys.every(k => {
      if (node[k]) return true;
      // 如果节点下有同名 key 的子结构也算
      const tmp = findAllNodes(node, k);
      return tmp.length > 0;
    });

    if (hasAll) {
      found = node;
      return;
    }

    for (const key of Object.keys(node)) {
      const v = node[key];
      if (v && typeof v === "object") walk(v);
    }
  }

  walk(root);
  return found;
}

/**
 * 工具：在一个对象下找第一个指定的子节点
 */
function findFirstChild(node: any, key: string): any | undefined {
  if (!node || typeof node !== "object") return undefined;
  if (node[key]) {
    const v = node[key];
    return Array.isArray(v) ? v[0] : v;
  }
  for (const k of Object.keys(node)) {
    const v = node[k];
    if (v && typeof v === "object") {
      const found = findFirstChild(v, key);
      if (found) return found;
    }
  }
  return undefined;
}
