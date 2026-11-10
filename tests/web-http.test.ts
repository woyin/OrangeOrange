import { expect, test, beforeEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
const network = vi.hoisted(() => ({
  request: vi.fn(),
  urls: [] as string[],
  pinned: [] as string[],
}));
vi.mock("node:https", () => ({ request: network.request }));
vi.mock("node:http", () => ({ request: network.request }));
vi.mock("node:dns/promises", () => ({
  lookup: async () => [{ address: "93.184.216.34", family: 4 }],
}));
import { createWeb } from "../src/web.js";
type Reply = { status: number; headers: Record<string, string>; body: string };
let replies: Reply[] = [];
beforeEach(() => {
  network.urls = [];
  network.pinned = [];
  replies = [];
  network.request.mockImplementation(
    (url: URL, options: any, callback: any) => {
      network.urls.push(url.href);
      options.lookup(
        url.hostname,
        { all: true },
        (_error: unknown, records: { address: string }[]) =>
          network.pinned.push(...records.map((r) => r.address)),
      );
      const request = new EventEmitter() as EventEmitter & { end: () => void };
      request.end = () =>
        queueMicrotask(() => {
          const reply = replies.shift()!;
          const response = new Readable({ read() {} }) as any;
          response.statusCode = reply.status;
          response.headers = reply.headers;
          callback(response);
          response.push(Buffer.from(reply.body));
          response.push(null);
        });
      return request;
    },
  );
});
test("公开网页请求固定已验证的 DNS 地址，提取真实响应正文", async () => {
  replies.push({
    status: 200,
    headers: { "content-type": "text/html" },
    body: "<title>来源</title><article>正文证据</article>",
  });
  const result = await createWeb(undefined).fetch(
    "https://example.com/article",
  );
  expect(result.content).toContain("正文证据");
  expect(result.title).toBe("来源");
  expect(network.pinned).toEqual(["93.184.216.34"]);
});
test("重定向到私有地址时拒绝第二次请求", async () => {
  replies.push({
    status: 302,
    headers: { location: "http://169.254.169.254/latest/meta-data" },
    body: "",
  });
  await expect(
    createWeb(undefined).fetch("https://example.com/article"),
  ).rejects.toThrow("网络地址");
  expect(network.urls).toHaveLength(1);
});
test("响应超过上限或类型不支持时终止读取；搜索凭据不随重定向转发", async () => {
  const web = createWeb("secret");
  replies.push({
    status: 200,
    headers: { "content-type": "text/plain" },
    body: "x".repeat(1024 * 1024 + 1),
  });
  await expect(web.fetch("https://example.com/big")).rejects.toThrow("1 MiB");
  replies.push({
    status: 200,
    headers: { "content-type": "application/pdf" },
    body: "pdf",
  });
  await expect(web.fetch("https://example.com/pdf")).rejects.toThrow(
    "文本或 HTML",
  );
  replies.push({
    status: 302,
    headers: { location: "https://other.example/search" },
    body: "",
  });
  await expect(web.search("科技")).rejects.toThrow("重定向");
  expect(network.urls).toHaveLength(3);
  expect(network.urls.at(-1)).toContain("api.search.brave.com");
});
