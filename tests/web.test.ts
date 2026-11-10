import { expect, test, vi } from "vitest";
const dns = vi.hoisted(() => ({
  records: [{ address: "93.184.216.34", family: 4 }],
}));
vi.mock("node:dns/promises", () => ({ lookup: async () => dns.records }));
import {
  createWeb,
  extractPage,
  publicAddress,
  publicUrl,
} from "../src/web.js";

test("网页访问拒绝内网、保留地址、IPv4 映射 IPv6 和混合 DNS，允许公开地址", async () => {
  for (const ip of [
    "127.0.0.1",
    "10.1.2.3",
    "172.16.1.1",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "::1",
    "fc00::1",
    "fe80::1",
    "::ffff:127.0.0.1",
    "2001:db8::1",
  ])
    expect(publicAddress(ip), ip).toBe(false);
  expect(publicAddress("8.8.8.8")).toBe(true);
  expect(publicAddress("2606:4700:4700::1111")).toBe(true);
  await expect(publicUrl("file:///etc/passwd")).rejects.toThrow();
  await expect(
    publicUrl("https://user:password@example.com"),
  ).rejects.toThrow();
  await expect(publicUrl("https://example.com:8080")).rejects.toThrow();
  await expect(
    createWeb(undefined).fetch("http://127.0.0.1/private"),
  ).rejects.toThrow("网络地址");
  dns.records = [
    { address: "93.184.216.34", family: 4 },
    { address: "127.0.0.1", family: 4 },
  ];
  await expect(publicUrl("https://example.com")).rejects.toThrow("网络地址");
  dns.records = [{ address: "93.184.216.34", family: 4 }];
  expect((await publicUrl("https://example.com")).url.hostname).toBe(
    "example.com",
  );
});

test("网页正文提取移除脚本与导航，解码实体并限制输出", () => {
  const page = extractPage(
    "<html><head><title>科技新闻</title></head><body><nav>导航</nav><script>evil()</script><article><h1>市场 &amp; 科技</h1><p>正文证据</p></article></body></html>",
    "text/html",
  );
  expect(page.title).toBe("科技新闻");
  expect(page.content).toContain("市场 & 科技");
  expect(page.content).toContain("正文证据");
  expect(page.content).not.toContain("evil");
  expect(page.content).not.toContain("导航");
  expect(extractPage("x".repeat(21000), "text/plain")).toEqual({
    title: "",
    content: "x".repeat(20000),
    truncated: true,
  });
});

test("搜索使用配置凭据、查询与时间过滤，输出带来源且不包含凭据", async () => {
  let requestUrl = "";
  let requestHeaders: Record<string, string> | undefined;
  const web = createWeb("private-search-key", async (url, headers) => {
    requestUrl = url;
    requestHeaders = headers;
    return {
      url,
      body: JSON.stringify({
        web: {
          results: [
            {
              title: "发布消息",
              url: "https://example.com/news",
              description: "新产品",
              age: "1 day ago",
            },
          ],
        },
      }),
      type: "application/json",
    };
  });
  const result = await web.search("科技市场", "pd");
  const url = new URL(requestUrl);
  expect(url.hostname).toBe("api.search.brave.com");
  expect(url.searchParams.get("q")).toBe("科技市场");
  expect(url.searchParams.get("freshness")).toBe("pd");
  expect(requestHeaders?.["X-Subscription-Token"]).toBe("private-search-key");
  expect(result.results[0].url).toBe("https://example.com/news");
  expect(result.untrusted).toBe(true);
  expect(JSON.stringify(result)).not.toContain("private-search-key");
  await expect(web.search("科技", "invalid")).rejects.toThrow("freshness");
  await expect(createWeb(undefined).search("科技")).rejects.toThrow(
    "BRAVE_SEARCH_API_KEY",
  );
});
