import { expect, test } from "vitest";
import { setup, until } from "./helpers.js";
test("可控时钟：创建去重、取消、到期、显式已读；取消与交付按提交顺序处理", async () => {
  let clock = Date.now();
  const app = await setup({ now: () => clock });
  try {
    const input = {
      id: "once",
      text: "检查发布",
      at: new Date(clock + 60000).toISOString(),
      timezone: "Asia/Shanghai",
    };
    const a = await app.runtime.dispatch("reminder.create", input);
    expect(await app.runtime.dispatch("reminder.create", input)).toEqual(a);
    await expect(
      app.runtime.dispatch("reminder.create", { ...input, text: "不同正文" }),
    ).rejects.toThrow("不同内容");
    await app.runtime.dispatch("reminder.create", {
      ...input,
      id: "cancelled",
    });
    await app.runtime.dispatch("reminder.cancel", { id: "cancelled" });
    clock += 61000;
    app.runtime.harness.resume();
    const inbox = await until(
      () => app.runtime.dispatch("inbox.list") as Promise<any[]>,
      (n) => n.length === 1,
    );
    expect(inbox[0].id).toBe("once");
    expect(
      ((await app.runtime.dispatch("reminder.cancel", { id: "once" })) as any)
        .status,
    ).toBe("delivered");
    expect(
      ((await app.runtime.dispatch("reminder.list")) as any[]).find(
        (r) => r.id === "cancelled",
      ).status,
    ).toBe("cancelled");
    await app.runtime.dispatch("inbox.ack", { id: "once" });
    expect(await app.runtime.dispatch("inbox.list")).toEqual([]);
    expect(
      await app.runtime.dispatch("inbox.list", { all: true }),
    ).toHaveLength(1);
    await expect(
      app.runtime.dispatch("reminder.create", {
        ...input,
        id: "bad",
        at: "2026-11-01T09:00:00",
      }),
    ).rejects.toThrow("UTC");
    await expect(
      app.runtime.dispatch("reminder.create", {
        ...input,
        id: "bad-date",
        at: "2026-02-30T09:00:00Z",
      }),
    ).rejects.toThrow("日历");
  } finally {
    await app.cleanup();
  }
});
