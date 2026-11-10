import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { LookupFunction } from "node:net";
import ipaddr from "ipaddr.js";
import { load } from "cheerio";
import { text } from "./config.js";

export function publicAddress(address: string) {
  try {
    return ipaddr.process(address).range() === "unicast";
  } catch {
    return false;
  }
}
async function resolveHost(hostname: string, signal?: AbortSignal) {
  if (!signal) return lookup(hostname, { all: true });
  signal.throwIfAborted();
  return new Promise<{ address: string; family: number }[]>(
    (resolve, reject) => {
      const cancel = () => reject(new Error("域名查询已取消或超时"));
      signal.addEventListener("abort", cancel, { once: true });
      void lookup(hostname, { all: true }).then(
        (records) => {
          signal.removeEventListener("abort", cancel);
          resolve(records);
        },
        (error) => {
          signal.removeEventListener("abort", cancel);
          reject(error);
        },
      );
    },
  );
}
export async function publicUrl(value: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const url = new URL(value);
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    (url.port && !["80", "443"].includes(url.port))
  )
    throw new Error("只允许标准端口的公开 HTTP(S) 网页");
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const records = ipaddr.isValid(hostname)
    ? [
        {
          address: hostname,
          family: ipaddr.parse(hostname).kind() === "ipv4" ? 4 : 6,
        },
      ]
    : await resolveHost(hostname, signal);
  if (!records.length || records.some((r) => !publicAddress(r.address)))
    throw new Error("不能访问本机、私有或保留网络地址");
  return { url, records };
}
async function publicGet(
  value: string,
  headers: Record<string, string> = {},
  signal: AbortSignal = AbortSignal.timeout(20000),
  redirects = 0,
): Promise<{ url: string; body: string; type: string }> {
  const { url, records } = await publicUrl(value, signal);
  const pinned: LookupFunction = (_hostname, options, callback) => {
    if (options.all) callback(null, records);
    else callback(null, records[0]!.address, records[0]!.family);
  };
  return new Promise((resolve, reject) => {
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(
      url,
      {
        agent: false,
        lookup: pinned,
        headers: {
          "User-Agent": "OrangeOrange/0.1",
          "Accept-Encoding": "identity",
          ...headers,
        },
        signal: AbortSignal.any([signal, AbortSignal.timeout(12000)]),
      },
      (response) => {
        const status = response.statusCode ?? 0;
        if ([301, 302, 303, 307, 308].includes(status)) {
          const location = response.headers.location;
          response.destroy();
          if (!location || redirects >= 3 || Object.keys(headers).length) {
            reject(new Error("网页重定向被拒绝"));
            return;
          }
          void publicGet(
            new URL(location, url).href,
            {},
            signal,
            redirects + 1,
          ).then(resolve, reject);
          return;
        }
        if (status < 200 || status >= 300) {
          response.destroy();
          reject(new Error(`网页请求失败：HTTP ${status}`));
          return;
        }
        const type = response.headers["content-type"] ?? "";
        if (
          !/^(text\/|application\/(json|xhtml\+xml))/i.test(type) ||
          (response.headers["content-encoding"] &&
            response.headers["content-encoding"] !== "identity")
        ) {
          response.destroy();
          reject(new Error("仅支持未压缩的文本或 HTML 网页"));
          return;
        }
        const chunks: Buffer[] = [];
        let length = 0;
        response.on("data", (chunk: Buffer) => {
          length += chunk.length;
          if (length > 1024 * 1024)
            response.destroy(new Error("网页超过 1 MiB"));
          else chunks.push(chunk);
        });
        response.on("error", reject);
        response.on("end", () =>
          resolve({
            url: url.href,
            body: Buffer.concat(chunks).toString("utf8"),
            type,
          }),
        );
      },
    );
    request.on("error", () => reject(new Error("网页连接失败或超时")));
    request.end();
  });
}
export function extractPage(body: string, type: string) {
  if (!/html/i.test(type))
    return {
      title: "",
      content: body.slice(0, 20000),
      truncated: body.length > 20000,
    };
  const $ = load(body);
  const title = $("title").first().text().trim();
  $("script,style,noscript,nav,footer,header,form,svg,iframe").remove();
  $("br,p,div,section,article,li,h1,h2,h3,tr").append("\n");
  const main = $("main,article").first();
  const content = (main.length ? main.text() : $("body").text())
    .replace(/[\t\r ]+/g, " ")
    .replace(/\n\s*\n/g, "\n")
    .trim();
  return {
    title,
    content: content.slice(0, 20000),
    truncated: content.length > 20000,
  };
}
export function createWeb(apiKey: string | undefined, get = publicGet) {
  return {
    async fetch(url: string, signal?: AbortSignal) {
      const page = await get(text(url, "网页 URL", 2048), {}, signal);
      return {
        url: page.url,
        retrievedAt: new Date().toISOString(),
        ...extractPage(page.body, page.type),
        untrusted: true,
      };
    },
    async search(query: string, freshness?: string, signal?: AbortSignal) {
      if (!apiKey)
        throw new Error(
          "在线搜索未配置：请设置 BRAVE_SEARCH_API_KEY 并重启服务",
        );
      const url = new URL("https://api.search.brave.com/res/v1/web/search");
      url.searchParams.set("q", text(query, "搜索词", 500));
      url.searchParams.set("count", "8");
      if (freshness !== undefined) {
        if (!["pd", "pw", "pm", "py"].includes(freshness))
          throw new Error("freshness 只支持 pd、pw、pm、py");
        url.searchParams.set("freshness", freshness);
      }
      const response = await get(
        url.href,
        { "X-Subscription-Token": apiKey, Accept: "application/json" },
        signal,
      );
      const body = JSON.parse(response.body);
      if (
        !body ||
        typeof body !== "object" ||
        body.error ||
        (body.web?.results !== undefined && !Array.isArray(body.web.results))
      )
        throw new Error("搜索服务返回格式无效");
      return {
        query,
        retrievedAt: new Date().toISOString(),
        untrusted: true,
        results: (body.web?.results ?? [])
          .slice(0, 8)
          .map((r: Record<string, unknown>) => ({
            title: String(r.title ?? "").slice(0, 500),
            url: String(r.url ?? "").slice(0, 2048),
            description: String(r.description ?? "").slice(0, 1600),
            ...(typeof r.age === "string" ? { age: r.age } : {}),
          })),
      };
    },
  };
}
