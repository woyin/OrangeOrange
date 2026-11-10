import { expect, test } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { SubmissionId } from "@earendil-works/pi-durable";
import { setup } from "./helpers.js";

test("通过 Durable 模型工具循环读取资料、加载技能和创建独立提醒", async () => {
  const app = await setup();
  try {
    await writeFile(
      join(app.cfg.workspace, "资料.md"),
      "证据：orange-acceptance-749",
    );
    await mkdir(join(app.dir, "skills", "review"), { recursive: true });
    await writeFile(
      join(app.dir, "skills", "review", "SKILL.md"),
      "---\ndescription: 只读资料检查\n---\n使用 read_file 读取并引用来源。",
    );
    await app.reopen();
    const tools: { name: string; args: Record<string, string> }[] = [
      { name: "read_file", args: { path: "资料.md" } },
      { name: "skill_load", args: { name: "review" } },
      {
        name: "reminder_create",
        args: {
          text: "工具创建提醒",
          at: new Date(Date.now() + 60000).toISOString(),
          timezone: "UTC",
        },
      },
    ];
    app.faux.setResponses(
      tools.flatMap((t) => [
        fauxAssistantMessage(fauxToolCall(t.name, t.args), {
          stopReason: "toolUse",
        }),
        fauxAssistantMessage("根据工具结果完成"),
      ]),
    );
    const c = (await app.runtime.dispatch("conversation.create")) as {
      id: number;
    };
    for (const tool of tools) {
      const admitted = (await app.runtime.dispatch("input.submit", {
        conversationId: c.id,
        requestId: tool.name,
        content: `使用 ${tool.name}`,
      })) as { id: number };
      expect(
        (
          await (await app.runtime.harness.submission(
            admitted.id as SubmissionId,
            ctx,
          ))!.wait(ctx)
        ).status,
      ).toBe("done");
    }
    const history = (await app.runtime.dispatch("history.list", {
      id: c.id,
      limit: 100,
    })) as any;
    const results = history.items.filter(
      (e: any) => e.kind === "pi.tool-result",
    );
    expect(results).toHaveLength(3);
    expect(JSON.stringify(results)).toContain("orange-acceptance-749");
    expect(JSON.stringify(results)).toContain("使用 read_file 读取并引用来源");
    expect(await app.runtime.dispatch("reminder.list")).toEqual([
      expect.objectContaining({ text: "工具创建提醒", status: "scheduled" }),
    ]);
    await app.runtime.dispatch("conversation.cancel", { id: c.id });
    await app.reopen();
    expect(await app.runtime.dispatch("reminder.list")).toHaveLength(1);
  } finally {
    await app.cleanup();
  }
});

test("持续工具调用受 maxTurns 限制；模型失败使用有限重试", async () => {
  const app = await setup();
  try {
    app.faux.setResponses(
      Array.from({ length: 20 }, () =>
        fauxAssistantMessage(fauxToolCall("memory_list", {}), {
          stopReason: "toolUse",
        }),
      ),
    );
    const c = (await app.runtime.dispatch("conversation.create")) as {
      id: number;
    };
    const admitted = (await app.runtime.dispatch("input.submit", {
      conversationId: c.id,
      requestId: "loop",
      content: "循环测试",
    })) as { id: number };
    const end = await (await app.runtime.harness.submission(
      admitted.id as SubmissionId,
      ctx,
    ))!.wait(ctx);
    expect(end).toMatchObject({ status: "unanswered", reason: "turn_limit" });
    expect(app.faux.state.callCount).toBe(12);
    app.faux.setResponses(
      Array.from({ length: 3 }, () =>
        fauxAssistantMessage("", {
          stopReason: "error",
          errorMessage: "429 rate limit",
        }),
      ),
    );
    const retry = (await app.runtime.dispatch("input.submit", {
      conversationId: c.id,
      requestId: "retry",
      content: "重试测试",
    })) as { id: number };
    expect(
      await (await app.runtime.harness.submission(
        retry.id as SubmissionId,
        ctx,
      ))!.wait(ctx),
    ).toMatchObject({ status: "unanswered", reason: "model_error" });
    expect(app.faux.state.callCount).toBe(15);
  } finally {
    await app.cleanup();
  }
});
