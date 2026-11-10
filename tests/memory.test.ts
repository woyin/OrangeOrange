import { expect, test } from "vitest";
import {
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { SubmissionId } from "@earendil-works/pi-durable";
import { setup } from "./helpers.js";
test("记忆工具真实提交；新会话注入快照，旧会话保持，删除与重启生效", async () => {
  const app = await setup();
  const requests: unknown[] = [];
  try {
    app.faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("memory_save", {
          content: "偏好简体中文",
          id: "preference",
        }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("已保存"),
      (context) => {
        requests.push(context.messages);
        return fauxAssistantMessage("读取快照");
      },
    ]);
    const a = (await app.runtime.dispatch("conversation.create")) as {
      id: number;
    };
    const input = (await app.runtime.dispatch("input.submit", {
      conversationId: a.id,
      requestId: "remember",
      content: "请记住偏好",
    })) as { id: number };
    await (await app.runtime.harness.submission(
      input.id as SubmissionId,
      ctx,
    ))!.wait(ctx);
    expect(await app.runtime.dispatch("memory.list")).toEqual([
      expect.objectContaining({ id: "preference", content: "偏好简体中文" }),
    ]);
    const b = (await app.runtime.dispatch("conversation.create")) as {
      id: number;
    };
    const bs = (await app.runtime.dispatch("input.submit", {
      conversationId: b.id,
      requestId: "snapshot",
      content: "我的偏好",
    })) as { id: number };
    await (await app.runtime.harness.submission(
      bs.id as SubmissionId,
      ctx,
    ))!.wait(ctx);
    expect(JSON.stringify(requests)).toContain("偏好简体中文");
    expect(
      ((await app.runtime.dispatch("conversation.state", { id: a.id })) as any)
        .profile.memory,
    ).toEqual([]);
    expect(
      ((await app.runtime.dispatch("conversation.state", { id: b.id })) as any)
        .profile.memory,
    ).toHaveLength(1);
    await app.reopen();
    expect(await app.runtime.dispatch("memory.list")).toHaveLength(1);
    await app.runtime.dispatch("memory.delete", { id: "preference" });
    const c = (await app.runtime.dispatch("conversation.create")) as {
      id: number;
    };
    expect(
      ((await app.runtime.dispatch("conversation.state", { id: c.id })) as any)
        .profile.memory,
    ).toEqual([]);
    expect(
      ((await app.runtime.dispatch("conversation.state", { id: b.id })) as any)
        .profile.memory,
    ).toHaveLength(1);
  } finally {
    await app.cleanup();
  }
});
test("容量不足时回滚原有记忆", async () => {
  const app = await setup();
  try {
    for (let i = 0; i < 3; i++)
      await app.runtime.dispatch("memory.save", {
        id: String(i),
        content: "字".repeat(1999) + String(i),
      });
    await expect(
      app.runtime.dispatch("memory.save", { id: "overflow", content: "额外" }),
    ).rejects.toThrow("容量");
    expect(await app.runtime.dispatch("memory.list")).toHaveLength(3);
  } finally {
    await app.cleanup();
  }
});
