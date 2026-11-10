import { expect, test } from "vitest";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { SubmissionId } from "@earendil-works/pi-durable";
import { setup } from "./helpers.js";
test("中文短词与英文搜索返回原文来源；分页、重建和索引丢失恢复", async () => {
  const app = await setup();
  try {
    const c = (await app.runtime.dispatch("conversation.create")) as {
      id: number;
    };
    for (const content of [
      "发布检查：部署数据库",
      "English deployment checklist",
    ]) {
      const input = (await app.runtime.dispatch("input.submit", {
        conversationId: c.id,
        requestId: content,
        content,
      })) as { id: number };
      await (await app.runtime.harness.submission(
        input.id as SubmissionId,
        ctx,
      ))!.wait(ctx);
    }
    const hits = (await app.runtime.dispatch("history.search", {
      query: "发布",
    })) as any[];
    expect(hits).toEqual([
      expect.objectContaining({
        conversationId: c.id,
        content: "发布检查：部署数据库",
      }),
    ]);
    expect(
      await app.runtime.dispatch("history.search", { query: "数据库" }),
    ).toHaveLength(1);
    expect(
      await app.runtime.dispatch("history.search", { query: "deployment" }),
    ).toHaveLength(1);
    const first = (await app.runtime.dispatch("history.list", {
      id: c.id,
      limit: 2,
    })) as any;
    const next = (await app.runtime.dispatch("history.list", {
      id: c.id,
      limit: 2,
      before: first.before,
    })) as any;
    expect(next.items.every((item: any) => item.id < first.before)).toBe(true);
    await app.runtime.dispatch("history.rebuild");
    expect(
      await app.runtime.dispatch("history.search", { query: "发布" }),
    ).toEqual(hits);
    await app.reopen(true);
    expect(
      await app.runtime.dispatch("history.search", { query: "发布" }),
    ).toEqual(hits);
  } finally {
    await app.cleanup();
  }
});
