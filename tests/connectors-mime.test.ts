import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import {
  DEFAULT_MIME_LIMITS,
  MimeError,
  buildGmailMimeMessage,
  encodeSubject,
  formatRfc5322Date,
  normalizeMessageId,
  sha256Hex,
  validateAddress,
  type GmailMimeInput,
  type MimeErrorCode,
} from "../src/connectors/mime.js";

const DATE = new Date("2026-02-03T04:05:06Z");

function base(overrides: Partial<GmailMimeInput> = {}): GmailMimeInput {
  return {
    from: { address: "owner@example.com", name: "Owner" },
    to: ["alice@example.com"],
    subject: "Weekly report",
    plainText: "Hello\n",
    date: DATE,
    messageId: "fixed-1@example.com",
    ...overrides,
  };
}

function errorCode(run: () => unknown): MimeErrorCode {
  try {
    run();
  } catch (error) {
    if (error instanceof MimeError) return error.code;
    throw error;
  }
  throw new Error("expected MimeError");
}

function decodeRaw(raw: string): string {
  return Buffer.from(raw, "base64url").toString("utf8");
}

function topHeaders(mime: string): string {
  const index = mime.indexOf("\r\n\r\n");
  return index < 0 ? mime : mime.slice(0, index);
}

function topEntity(mime: string): string {
  const index = mime.indexOf("\r\n\r\n");
  return index < 0 ? "" : mime.slice(index + 4);
}

function splitMultipart(entity: string): { boundary: string; parts: string[] } {
  const match = /boundary="([^"]+)"/.exec(entity);
  if (match === null || match[1] === undefined) throw new Error("missing boundary");
  const boundary = match[1];
  const segments = entity.split("--" + boundary);
  const parts = segments
    .slice(1, -1)
    .map((part) => part.replace(/^\r\n/, "").replace(/\r\n$/, ""));
  return { boundary, parts };
}

function partHeaders(part: string): string {
  const index = part.indexOf("\r\n\r\n");
  return index < 0 ? part : part.slice(0, index);
}

function partBody(part: string): Buffer {
  const index = part.indexOf("\r\n\r\n");
  const body = index < 0 ? "" : part.slice(index + 4);
  return Buffer.from(body.replace(/\r\n/g, ""), "base64");
}

function partText(part: string): string {
  return partBody(part).toString("utf8");
}

function partBodyLines(part: string): string[] {
  const index = part.indexOf("\r\n\r\n");
  const body = index < 0 ? "" : part.slice(index + 4);
  return body.split("\r\n").filter((line) => line.length > 0);
}

function headerValue(mime: string, name: string): string {
  const lines = topHeaders(mime).split("\r\n");
  const start = lines.findIndex((line) => line.startsWith(name + ":"));
  if (start < 0) return "";
  let value = (lines[start] ?? "").slice(name.length + 1).trim();
  for (let index = start + 1; index < lines.length; index++) {
    const line = lines[index] ?? "";
    if (!line.startsWith(" ") && !line.startsWith("\t")) break;
    value += " " + line.trim();
  }
  return value;
}

function addresses(list: readonly { address: string }[]): string[] {
  return list.map((item) => item.address);
}

function decodeRfc2047(value: string): string {
  const collapsed = value.replace(/(\?=)\s+(?==\?UTF-8\?B\?)/gi, "$1");
  return collapsed.replace(/=\?UTF-8\?B\?([^?]*)\?=/gi, (_all, encoded: string) =>
    Buffer.from(encoded, "base64").toString("utf8"),
  );
}

test("纯文本邮件：固定 Message-ID/Date、CRLF 行尾、base64url 与解码一致", () => {
  const message = buildGmailMimeMessage(base());
  expect(message.messageId).toBe("<fixed-1@example.com>");
  expect(message.subject).toBe("Weekly report");
  expect(message.recipientCount).toBe(1);
  const headers = topHeaders(message.mime);
  expect(headers).toContain("Message-ID: <fixed-1@example.com>");
  expect(headers).toContain("Date: Tue, 03 Feb 2026 04:05:06 +0000");
  expect(headers).toContain("From: Owner <owner@example.com>");
  expect(headers).toContain("To: alice@example.com");
  expect(headers).toContain("MIME-Version: 1.0");
  expect(headers).toContain("Subject: Weekly report");
  // 行尾只有 CRLF，没有裸 CR 或裸 LF。
  expect(message.mime.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
  // raw 是 base64url（无 padding），解码后与原文一致。
  expect(message.raw).toMatch(/^[A-Za-z0-9_-]+$/);
  expect(decodeRaw(message.raw)).toBe(message.mime);
  expect(message.sizeBytes).toBe(Buffer.byteLength(message.mime, "utf8"));
  // 单段 text/plain，正文 base64 传输编码。
  expect(topEntity(message.mime)).toContain("Content-Type: text/plain; charset=UTF-8");
  expect(topEntity(message.mime)).toContain("Content-Transfer-Encoding: base64");
  expect(partText(topEntity(message.mime))).toBe("Hello\r\n");
});

test("长正文的 base64 每行不超过 76 字符", () => {
  const body = "0123456789".repeat(40);
  const message = buildGmailMimeMessage(base({ plainText: body }));
  const lines = partBodyLines(topEntity(message.mime));
  expect(lines.length).toBeGreaterThan(1);
  for (const line of lines) {
    expect(line.length).toBeLessThanOrEqual(76);
    expect(line).toMatch(/^[A-Za-z0-9+/]+=*$/);
  }
  expect(partText(topEntity(message.mime))).toBe(body);
});

test("UTF-8 主题与显示名使用 RFC 2047 分块编码并可无损解码", () => {
  const subject = "每日设备简报：温度 22°C，湿度正常。".repeat(4);
  const name = "家庭审计机器人";
  const encoded = encodeSubject(subject);
  const words = encoded.split(/\s+/);
  expect(words.length).toBeGreaterThan(1);
  for (const word of words) {
    expect(word).toMatch(/^=\?UTF-8\?B\?[A-Za-z0-9+/]+=*\?=$/);
    expect(word.length).toBeLessThanOrEqual(75);
  }
  expect(decodeRfc2047(encoded)).toBe(subject);

  const message = buildGmailMimeMessage(
    base({ subject, from: { address: "owner@example.com", name } }),
  );
  expect(decodeRfc2047(headerValue(message.mime, "Subject"))).toBe(subject);
  const fromValue = decodeRfc2047(headerValue(message.mime, "From"));
  expect(fromValue).toContain(name);
  expect(fromValue).toContain("<owner@example.com>");
  // 纯 ASCII 主题不加 encoded-word。
  const ascii = buildGmailMimeMessage(base({ subject: "Plain ASCII subject" }));
  expect(topHeaders(ascii.mime)).toContain("Subject: Plain ASCII subject");
});

test("显示名中的特殊字符使用引号包裹且可解析", () => {
  const message = buildGmailMimeMessage(
    base({ from: { address: "owner@example.com", name: 'Owner, "Ops"' } }),
  );
  expect(headerValue(message.mime, "From")).toBe('"Owner, \\"Ops\\"" <owner@example.com>');
});

test("to/cc/bcc：跨列表按小写地址去重，先出现者保留", () => {
  const message = buildGmailMimeMessage(
    base({
      to: ["alice@example.com", { address: "Bob@Example.com", name: "Bob" }],
      cc: ["bob@example.com", "carol@example.com"],
      bcc: ["carol@example.com", "dave@example.com"],
    }),
  );
  expect(addresses(message.to)).toEqual(["alice@example.com", "Bob@example.com"]);
  expect(addresses(message.cc)).toEqual(["carol@example.com"]);
  expect(addresses(message.bcc)).toEqual(["dave@example.com"]);
  expect(message.recipientCount).toBe(4);
  const headers = topHeaders(message.mime);
  expect(headers).toContain("To: alice@example.com, Bob <Bob@example.com>");
  expect(headers).toContain("Cc: carol@example.com");
  expect(headers).toContain("Bcc: dave@example.com");
});

test("长收件人列表折行且不产生超长行", () => {
  const to = Array.from({ length: 40 }, (_value, index) => ({
    address: "recipient" + index + "@example.com",
    name: "Recipient number " + index,
  }));
  const message = buildGmailMimeMessage(base({ to }));
  expect(message.recipientCount).toBe(40);
  const headerLines = topHeaders(message.mime).split("\r\n");
  for (const line of headerLines) expect(line.length).toBeLessThanOrEqual(998);
  const continuations = headerLines.filter((line) => line.startsWith(" "));
  expect(continuations.length).toBeGreaterThan(0);
  const toIndex = headerLines.findIndex((line) => line.startsWith("To: "));
  expect(toIndex).toBeGreaterThanOrEqual(0);
  expect(headerLines[toIndex + 1]?.startsWith(" ")).toBe(true);
  // 所有收件人都出现在头里。
  for (const item of to) expect(message.mime).toContain(item.address);
});

test("HTML 正文生成 multipart/alternative；带附件时嵌套在 mixed 内", () => {
  const html = "<p>Hello <strong>team</strong></p>";
  const onlyHtml = buildGmailMimeMessage(base({ html }));
  expect(topEntity(onlyHtml.mime)).toContain("Content-Type: multipart/alternative");
  const alternative = splitMultipart(topEntity(onlyHtml.mime));
  expect(alternative.parts).toHaveLength(2);
  const plainPart = alternative.parts.find((part) => partHeaders(part).includes("text/plain"));
  const htmlPart = alternative.parts.find((part) => partHeaders(part).includes("text/html"));
  expect(partText(plainPart ?? "")).toBe("Hello\r\n");
  expect(partText(htmlPart ?? "")).toBe(html);

  const bytes = Buffer.from("PDF-BYTES-01");
  const mixed = buildGmailMimeMessage(
    base({
      html,
      attachments: [
        {
          filename: "report.pdf",
          mimeType: "application/pdf",
          bytes,
          sha256: sha256Hex(bytes),
          sizeBytes: bytes.byteLength,
        },
      ],
    }),
  );
  expect(topEntity(mixed.mime)).toContain("Content-Type: multipart/mixed");
  const mixedParts = splitMultipart(topEntity(mixed.mime));
  expect(mixedParts.parts).toHaveLength(2);
  const first = mixedParts.parts[0] ?? "";
  expect(first).toContain("Content-Type: multipart/alternative");
  expect(splitMultipart(first).parts).toHaveLength(2);
});

test("受管附件：字节、声明哈希、RFC 2231 文件名与元数据", () => {
  const bytes = Buffer.from("report-body-bytes");
  const sha256 = sha256Hex(bytes);
  const message = buildGmailMimeMessage(
    base({
      attachments: [
        {
          filename: "月度报表.pdf",
          mimeType: "application/pdf",
          bytes,
          sha256: sha256.toUpperCase(),
          sizeBytes: bytes.byteLength,
        },
      ],
    }),
  );
  const parts = splitMultipart(topEntity(message.mime)).parts;
  const attachment =
    parts.find((part) => partHeaders(part).includes("Content-Disposition: attachment")) ?? "";
  const headers = partHeaders(attachment);
  expect(headers).toContain("Content-Type: application/pdf");
  expect(headers).toContain("Content-Transfer-Encoding: base64");
  expect(headers).toContain("filename*=UTF-8''%E6%9C%88%E5%BA%A6%E6%8A%A5%E8%A1%A8.pdf");
  expect(headers).toMatch(/filename="[^"]*\.pdf"/);
  expect(headers).toContain("X-Attachment-SHA256: " + sha256);
  expect(partBody(attachment).equals(bytes)).toBe(true);
  expect(message.attachments).toEqual([
    {
      filename: "月度报表.pdf",
      mimeType: "application/pdf",
      sizeBytes: bytes.byteLength,
      sha256,
    },
  ]);

  const ascii = buildGmailMimeMessage(
    base({
      attachments: [
        {
          filename: "report.pdf",
          mimeType: "application/pdf",
          bytes,
          sha256,
          sizeBytes: bytes.byteLength,
        },
      ],
    }),
  );
  const asciiPart =
    splitMultipart(topEntity(ascii.mime)).parts.find((part) =>
      partHeaders(part).includes("Content-Disposition: attachment"),
    ) ?? "";
  expect(partHeaders(asciiPart)).toContain('filename="report.pdf"');
  expect(partHeaders(asciiPart)).not.toContain("filename*=");
});

test("安全：主题/显示名/地址的注入与畸形输入全部拒绝", () => {
  expect(
    errorCode(() => buildGmailMimeMessage(base({ subject: "Hi\r\nBcc: evil@example.com" }))),
  ).toBe("INVALID_SUBJECT");
  expect(
    errorCode(() => buildGmailMimeMessage(base({ subject: "Hi\nBcc: evil@example.com" }))),
  ).toBe("INVALID_SUBJECT");
  expect(errorCode(() => buildGmailMimeMessage(base({ subject: "   " })))).toBe("INVALID_SUBJECT");
  expect(
    errorCode(() =>
      buildGmailMimeMessage(
        base({ from: { address: "owner@example.com", name: "Own\r\nBcc: evil@example.com" } }),
      ),
    ),
  ).toBe("INVALID_DISPLAY_NAME");

  const badAddresses = [
    "alice@example.com, evil@example.com",
    "alice@example.com; evil@example.com",
    " alice @example.com ",
    "<alice@example.com>",
    "Alice <alice@example.com>",
    "alice@@example.com",
    "alice@example",
    ".alice@example.com",
    "alice..bob@example.com",
    "alice.@example.com",
    "用户@example.com",
    "alice@-example.com",
    "alice@example..com",
    "alice@example.c0m",
    "alice@example.com\r\nBcc: evil@example.com",
    "",
  ];
  for (const address of badAddresses) {
    expect(errorCode(() => validateAddress(address))).toBe("INVALID_ADDRESS");
    expect(errorCode(() => buildGmailMimeMessage(base({ to: [address] })))).toBe("INVALID_ADDRESS");
  }
  expect(validateAddress("Alice@Example.COM")).toBe("Alice@example.com");
  expect(errorCode(() => buildGmailMimeMessage(base({ to: [] })))).toBe("INVALID_INPUT");

  // 正文控制字符（NUL）与空正文拒绝。
  expect(errorCode(() => buildGmailMimeMessage(base({ plainText: "Hi\u0000there" })))).toBe(
    "INVALID_BODY",
  );
  expect(errorCode(() => buildGmailMimeMessage(base({ plainText: "   " })))).toBe("INVALID_BODY");
});

test("安全：附件不接受路径、文件名越界或声明不符", () => {
  const bytes = Buffer.from("abc");
  const sha256 = sha256Hex(bytes);
  const attachment = (overrides: Record<string, unknown> = {}) => ({
    filename: "a.txt",
    mimeType: "text/plain",
    bytes,
    sha256,
    sizeBytes: bytes.byteLength,
    ...overrides,
  });

  // 只接受调用方已读取的字节；字符串路径不是合法输入。
  for (const value of ["/etc/passwd", "a.txt", 42, null]) {
    expect(
      errorCode(() =>
        buildGmailMimeMessage(base({ attachments: [attachment({ bytes: value }) as never] })),
      ),
    ).toBe("INVALID_ATTACHMENT");
  }

  const badFilenames = [
    "../etc/passwd",
    "..",
    ".",
    "sub/report.pdf",
    "sub\\report.pdf",
    "/absolute.pdf",
    "report\r\n.pdf",
    "a\u0000.pdf",
    "",
  ];
  for (const filename of badFilenames) {
    expect(
      errorCode(() => buildGmailMimeMessage(base({ attachments: [attachment({ filename })] }))),
    ).toBe("INVALID_ATTACHMENT");
  }
  for (const mimeType of ["text", "text/", "/plain", "text/plain\r\nBcc: evil@example.com"]) {
    expect(
      errorCode(() => buildGmailMimeMessage(base({ attachments: [attachment({ mimeType })] }))),
    ).toBe("INVALID_ATTACHMENT");
  }

  expect(
    errorCode(() =>
      buildGmailMimeMessage(
        base({ attachments: [attachment({ sha256: sha256Hex(Buffer.from("other")) })] }),
      ),
    ),
  ).toBe("ATTACHMENT_HASH_MISMATCH");
  expect(
    errorCode(() => buildGmailMimeMessage(base({ attachments: [attachment({ sizeBytes: 4 })] }))),
  ).toBe("ATTACHMENT_SIZE_MISMATCH");
  expect(
    errorCode(() =>
      buildGmailMimeMessage(base({ attachments: [attachment({ sha256: undefined })] })),
    ),
  ).toBe("INVALID_ATTACHMENT");
  expect(
    errorCode(() =>
      buildGmailMimeMessage(
        base({ limits: { maxAttachmentBytes: 2 }, attachments: [attachment()] }),
      ),
    ),
  ).toBe("ATTACHMENT_TOO_LARGE");
  expect(
    errorCode(() =>
      buildGmailMimeMessage(
        base({
          limits: { maxTotalAttachmentBytes: 5 },
          attachments: [attachment(), attachment({ filename: "b.txt" })],
        }),
      ),
    ),
  ).toBe("ATTACHMENT_TOTAL_TOO_LARGE");
  expect(
    errorCode(() =>
      buildGmailMimeMessage(
        base({
          limits: { maxAttachmentCount: 1 },
          attachments: [attachment(), attachment({ filename: "b.txt" })],
        }),
      ),
    ),
  ).toBe("TOO_MANY_ATTACHMENTS");
});

test("安全：收件人上限、limits 校验与无效日期", () => {
  expect(
    errorCode(() =>
      buildGmailMimeMessage(
        base({ to: ["a@example.com", "b@example.com"], limits: { maxRecipients: 1 } }),
      ),
    ),
  ).toBe("TOO_MANY_RECIPIENTS");
  expect(errorCode(() => buildGmailMimeMessage(base({ limits: { maxSubjectChars: 0 } })))).toBe(
    "INVALID_INPUT",
  );
  expect(errorCode(() => buildGmailMimeMessage(base({ date: new Date(Number.NaN) })))).toBe(
    "INVALID_DATE",
  );
  expect(errorCode(() => formatRfc5322Date(new Date("nope")))).toBe("INVALID_DATE");
  expect(DEFAULT_MIME_LIMITS.maxRecipients).toBe(100);
});

test("Message-ID：固定、规范化与缺省生成", () => {
  expect(normalizeMessageId("abc@example.com", "example.com")).toBe("<abc@example.com>");
  expect(normalizeMessageId("<abc@example.com>", "example.com")).toBe("<abc@example.com>");
  expect(normalizeMessageId("local-1", "example.com")).toBe("<local-1@example.com>");
  const invalidMessageIds = [
    "a b@example.com",
    "a@b@example.com",
    "a@b",
    "",
    "<a@example.com",
    "a@example.com>",
    "a@example.c0m",
    "a@example.com\r\nBcc: evil@example.com",
  ];
  for (const value of invalidMessageIds) {
    expect(errorCode(() => normalizeMessageId(value, "example.com"))).toBe("INVALID_MESSAGE_ID");
  }
  // 固定 Message-ID 与固定 Date 让纯文本邮件完全可复现（用于审批哈希）。
  const first = buildGmailMimeMessage(base({ messageId: "audit-42" }));
  const second = buildGmailMimeMessage(base({ messageId: "audit-42" }));
  expect(first.messageId).toBe("<audit-42@example.com>");
  expect(first.raw).toBe(second.raw);
  // 缺省时随机生成，且域来自 From。
  const generated = buildGmailMimeMessage(base({ messageId: undefined }));
  expect(generated.messageId).toMatch(/^<[0-9a-f-]{36}@example\.com>$/);
  expect(generated.messageId).not.toBe(
    buildGmailMimeMessage(base({ messageId: undefined })).messageId,
  );
});

test("Reply-To 与可选的 html 缺省行为", () => {
  const message = buildGmailMimeMessage(base({ replyTo: "support@example.com" }));
  expect(topHeaders(message.mime)).toContain("Reply-To: support@example.com");
  expect(message.replyTo?.address).toBe("support@example.com");
  expect(buildGmailMimeMessage(base()).replyTo).toBeUndefined();
  expect(topEntity(buildGmailMimeMessage(base()).mime)).not.toContain("multipart/");
});

test("MIME 边界与正文冲突时重新生成，且正文无法伪造结构", () => {
  const colliding = new Uint8Array(12).fill(7);
  const fresh = new Uint8Array(12).fill(9);
  const collidingBoundary = "=_hda_" + Buffer.from(colliding).toString("base64url");
  const freshBoundary = "=_hda_" + Buffer.from(fresh).toString("base64url");
  const sequence = [colliding, fresh];
  let call = 0;
  const plainText = "marker --" + collidingBoundary + " stays text\r\n";
  const message = buildGmailMimeMessage(
    base({
      plainText,
      html: "<p>marker</p>",
      random: () => sequence[Math.min(call++, sequence.length - 1)] ?? fresh,
    }),
  );
  expect(message.mime).not.toContain(collidingBoundary);
  expect(message.mime).toContain("--" + freshBoundary);
  // 只有开始边界 + 结束边界 + 1 个内部分隔，注入文本没有产生额外边界。
  expect(message.mime.split("--" + freshBoundary).length - 1).toBe(3);
  const parts = splitMultipart(topEntity(message.mime)).parts;
  expect(partText(parts[0] ?? "")).toBe(plainText);
  // 永远冲突时报错，而不是产出可被拆分的结构。
  expect(
    errorCode(() =>
      buildGmailMimeMessage(base({ plainText, html: "<p>x</p>", random: () => colliding })),
    ),
  ).toBe("INVALID_INPUT");
  expect(
    errorCode(() => buildGmailMimeMessage(base({ html: "<p>x</p>", random: () => "nope" as never }))),
  ).toBe("INVALID_INPUT");
});

test("模块不引入文件系统或进程能力，附件字节只能来自调用方", () => {
  const source = readFileSync(new URL("../src/connectors/mime.ts", import.meta.url), "utf8");
  expect(source).toMatch(/from "node:crypto"/);
  for (const forbidden of [
    "node:fs",
    "node:path",
    "node:child_process",
    "readFile",
    "createReadStream",
    "process.env",
  ]) {
    expect(source).not.toContain(forbidden);
  }
});
