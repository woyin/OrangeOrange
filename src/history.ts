import { DatabaseSync } from "node:sqlite";
import type { EntryId, EntryRecord, Storage } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";

export function messageText(entry: EntryRecord): string {
  if (entry.kind !== "pi.user" && entry.kind !== "pi.assistant") return "";
  return (entry.model ?? [])
    .filter(
      (m) =>
        m.role === "user" ||
        (m.role === "assistant" &&
          m.stopReason !== "error" &&
          m.stopReason !== "aborted"),
    )
    .map((m) =>
      typeof m.content === "string"
        ? m.content
        : m.content
            .filter((c) => c.type === "text")
            .map((c) => c.text)
            .join("\n"),
    )
    .join("\n");
}
// Unicode words for Latin scripts; individual Han characters make 1–2 character Chinese queries searchable.
function terms(value: string): string[] {
  return (
    value
      .normalize("NFKC")
      .toLowerCase()
      .replace(/\p{Script=Han}/gu, " $& ")
      .match(/[\p{L}\p{N}_]+/gu) ?? []
  );
}
export class History {
  private db: DatabaseSync;
  private pending: Promise<void> = Promise.resolve();
  constructor(
    private storage: Storage,
    path: string,
  ) {
    this.db = new DatabaseSync(path);
    try {
      this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE VIRTUAL TABLE IF NOT EXISTS messages USING fts5(conversation UNINDEXED, entry UNINDEXED, content UNINDEXED, tokens, tokenize='${"unicode" + "61"}');
      CREATE TABLE IF NOT EXISTS cursors (conversation INTEGER PRIMARY KEY, entry INTEGER NOT NULL);`);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  sync(): Promise<void> {
    const next = this.pending.catch(() => {}).then(() => this.catchUp());
    this.pending = next;
    return next;
  }
  private async catchUp() {
    let cursor;
    do {
      const conversations = await this.storage.scanConversations(
        { order: "ascending" },
        100,
        cursor,
        ctx,
      );
      for (const conversation of conversations.items) {
        const last = this.db
          .prepare("SELECT entry FROM cursors WHERE conversation=?")
          .get(conversation.id)?.entry as number | undefined;
        let entryCursor;
        do {
          const page = await this.storage.scanEntries(
            {
              conversationId: conversation.id,
              order: "ascending",
              ...(last === undefined
                ? {}
                : { minEntryId: (last + 1) as EntryId }),
            },
            100,
            entryCursor,
            ctx,
          );
          this.db.exec("BEGIN IMMEDIATE");
          try {
            for (const entry of page.items) {
              const content = messageText(entry);
              if (content)
                this.db
                  .prepare(
                    "INSERT OR REPLACE INTO messages(rowid, conversation, entry, content, tokens) VALUES (?, ?, ?, ?, ?)",
                  )
                  .run(
                    entry.id,
                    conversation.id,
                    entry.id,
                    content,
                    terms(content).join(" "),
                  );
            }
            const newest = page.items.at(-1)?.id;
            if (newest !== undefined)
              this.db
                .prepare(
                  "INSERT INTO cursors VALUES (?, ?) ON CONFLICT(conversation) DO UPDATE SET entry=excluded.entry",
                )
                .run(conversation.id, newest);
            this.db.exec("COMMIT");
          } catch (e) {
            this.db.exec("ROLLBACK");
            throw e;
          }
          entryCursor = page.next;
        } while (entryCursor);
      }
      cursor = conversations.next;
    } while (cursor);
  }
  async search(query: string, conversationIds?: number[]) {
    if (!query.trim() || query.length > 200)
      throw new Error("查询必须为 1–200 字符");
    await this.sync();
    const words = [...new Set(terms(query))];
    if (!words.length) return [];
    return this.db
      .prepare(
        "SELECT conversation AS conversationId, entry AS entryId, content FROM messages WHERE messages MATCH ? AND (? IS NULL OR conversation IN (SELECT value FROM json_each(?))) ORDER BY rank LIMIT 20",
      )
      .all(
        words.map((t) => `"${t.replaceAll('"', '""')}"`).join(" AND "),
        conversationIds === undefined ? null : JSON.stringify(conversationIds),
        JSON.stringify(conversationIds ?? []),
      );
  }
  async rebuild() {
    const next = this.pending
      .catch(() => {})
      .then(async () => {
        this.db.exec(
          "BEGIN; DELETE FROM messages; DELETE FROM cursors; COMMIT;",
        );
        await this.catchUp();
      });
    this.pending = next;
    await next;
    return { rebuilt: true };
  }
  async close() {
    await this.pending.catch(() => {});
    this.db.close();
  }
}
