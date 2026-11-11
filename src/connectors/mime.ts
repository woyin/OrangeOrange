/**
 * 独立 Gmail MIME 组装模块（App Connector / Gmail 首发）。
 *
 * 设计来源：docs/Home_Durable_Agent_v1.1/APP_CONNECTORS_GMAIL.md 第 3.3 节。
 *
 * 硬约束：
 * - 纯组装函数。不读文件、不访问网络、不解析配置。附件只能由调用方传入已读取的 bytes，
 *   并附带声明的 sha256 / 文件名 / 尺寸 / 内型；本模块只校验这些声明，不接受路径字符串，
 *   因此不存在按任意宿主机路径发送的入口。
 * - 所有头部输入（地址、显示名、主题、文件名、Message-ID）拒绝 CR/LF 与控制字符，
 *   以防 header 注入和隐形收件人。
 * - 正文使用 base64 传输编码，规避 8bit、行长度和折行问题；行尾统一 CRLF。
 * - 输出 raw 为 Gmail users.messages.send 需要的 base64url（无 padding）。
 * - Message-ID 可以由调用方固定，供审批哈希与审计使用；未提供时才随机生成。
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";

export type MimeErrorCode =
  | "INVALID_INPUT"
  | "INVALID_ADDRESS"
  | "INVALID_DISPLAY_NAME"
  | "INVALID_SUBJECT"
  | "INVALID_BODY"
  | "INVALID_DATE"
  | "INVALID_MESSAGE_ID"
  | "INVALID_ATTACHMENT"
  | "ATTACHMENT_TOO_LARGE"
  | "ATTACHMENT_TOTAL_TOO_LARGE"
  | "ATTACHMENT_HASH_MISMATCH"
  | "ATTACHMENT_SIZE_MISMATCH"
  | "TOO_MANY_RECIPIENTS"
  | "TOO_MANY_ATTACHMENTS";

/** 校验失败统一抛出的错误；code 可用于错误分类与用户可见提示。 */
export class MimeError extends Error {
  readonly code: MimeErrorCode;
  constructor(code: MimeErrorCode, message: string) {
    super(message);
    this.name = "MimeError";
    this.code = code;
  }
}

/** 邮件地址与尺寸上限；所有上限都可以用 input.limits 逐项覆写。 */
export interface MimeLimits {
  /** to + cc + bcc 去重后的收件人上限。 */
  maxRecipients: number;
  maxSubjectChars: number;
  maxDisplayNameChars: number;
  maxAddressChars: number;
  maxBodyChars: number;
  maxAttachmentCount: number;
  maxAttachmentBytes: number;
  maxTotalAttachmentBytes: number;
  maxFilenameChars: number;
  maxMessageIdChars: number;
}

export const DEFAULT_MIME_LIMITS: Readonly<MimeLimits> = Object.freeze({
  maxRecipients: 100,
  maxSubjectChars: 900,
  maxDisplayNameChars: 200,
  maxAddressChars: 254,
  maxBodyChars: 500_000,
  maxAttachmentCount: 10,
  maxAttachmentBytes: 10 * 1024 * 1024,
  maxTotalAttachmentBytes: 25 * 1024 * 1024,
  maxFilenameChars: 200,
  maxMessageIdChars: 320,
});

export interface MailAddress {
  readonly address: string;
  readonly name?: string;
}

/** 收件人输入：裸地址字符串，或带显示名的对象。不接受逗号拼接的地址列表。 */
export type AddressInput = string | MailAddress;

/**
 * 内部层附件输入：只允许可信 resolver 构造，不作为提议/Agent 输入的公开类型。
 *
 * 责任划分：
 * - 提议层对外只暴露 {artifactId, filename}，并把 artifact 的 sha256、sizeBytes、mimeType
 *   与规范化后的 filename 绑定进审批哈希。
 * - 发送时 resolver 从受管存储重读 bytes，调用 sha256Hex 复核绑定值，再把这里的完整元数据
 *   与 bytes 一并传入。本模块用声明值再校验一次，任何不一致都 fail-closed 抛错，
 *   不产出 raw，因此不会发信。
 * - bytes 必须是真实字节；字符串、路径、文件句柄一律拒绝，模块内没有路径读取能力。
 */
export interface ManagedAttachmentInput {
  readonly filename: string;
  readonly mimeType: string;
  readonly bytes: Uint8Array;
  readonly sha256: string;
  readonly sizeBytes: number;
}

/** 校验通过后的附件元数据；可安全写入审批记录与日志。 */
export interface VerifiedAttachment {
  readonly filename: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly sha256: string;
}

export interface GmailMimeInput {
  readonly from: AddressInput;
  readonly to: readonly AddressInput[];
  readonly cc?: readonly AddressInput[];
  readonly bcc?: readonly AddressInput[];
  readonly subject: string;
  readonly plainText: string;
  readonly html?: string;
  readonly replyTo?: AddressInput;
  /** 受管附件（内部层）；沿用调用方已校验的 sha256/sizeBytes，本模块再复核。 */
  readonly attachments?: readonly ManagedAttachmentInput[];
  /** 固定 Message-ID：可带尖括号，也可以只是本地部分（自动补 From 域）。 */
  readonly messageId?: string;
  /** 固定 Date 头，便于测试与审批哈希复现；缺省为当前时间。 */
  readonly date?: Date;
  readonly limits?: Partial<MimeLimits>;
  /** 测试注入用；返回 MIME 边界随机字节。 */
  readonly random?: (size: number) => Uint8Array;
}

export interface GmailMimeMessage {
  /** Gmail users.messages.send 的 raw 字段（base64url，无 padding）。 */
  readonly raw: string;
  /** 原始 RFC 5322/MIME 文本（CRLF），仅用于测试与审计，不应写入普通日志。 */
  readonly mime: string;
  readonly messageId: string;
  readonly subject: string;
  readonly from: MailAddress;
  readonly to: readonly MailAddress[];
  readonly cc: readonly MailAddress[];
  readonly bcc: readonly MailAddress[];
  readonly replyTo?: MailAddress;
  readonly attachments: readonly VerifiedAttachment[];
  /** 去重后的 to + cc + bcc 数量。 */
  readonly recipientCount: number;
  /** mime 的 UTF-8 字节数。 */
  readonly sizeBytes: number;
}

const ATOM = /^[A-Za-z0-9!#$%&'*+/=?^\x60{|}~-]+$/;
const DOMAIN_LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
const TLD = /^[A-Za-z]{2,63}$/;
const MEDIA_TYPE = /^[A-Za-z0-9!#$&^_.+-]{1,64}\/[A-Za-z0-9!#$&^_.+-]{1,64}$/;
const HEX_SHA256 = /^[0-9a-fA-F]{64}$/;
// 头部禁止一切控制字符（含 TAB、CR、LF）。
const HEADER_CONTROL = /[\u0000-\u001f\u007f]/;
// 正文字符串禁止控制字符，但保留 TAB/LF/CR。
const BODY_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const NON_ASCII = /[^\x20-\x7e]/;
const DISPLAY_SPECIALS = /[()<>\[\]:;@\\,."]/;
const ADDRESS_STRUCTURAL = /[<>()\[\],;:"\\]/;
const FILENAME_FORBIDDEN = /[/\\\u0000-\u001f\u007f]/;
const RFC2231_SAFE = /^[A-Za-z0-9!#$&+\-.^_\x60|~]$/;

function resolveLimits(overrides?: Partial<MimeLimits>): MimeLimits {
  const limits: MimeLimits = { ...DEFAULT_MIME_LIMITS };
  if (overrides === undefined) return limits;
  if (overrides === null || typeof overrides !== "object")
    throw new MimeError("INVALID_INPUT", "limits 必须是对象");
  const keys = Object.keys(DEFAULT_MIME_LIMITS) as (keyof MimeLimits)[];
  for (const key of keys) {
    const value = overrides[key];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)
      throw new MimeError("INVALID_INPUT", "limits." + key + " 必须是正整数");
    limits[key] = value;
  }
  return limits;
}

function assertLocalPart(local: string, code: MimeErrorCode, label: string): void {
  if (local.length === 0 || local.length > 64)
    throw new MimeError(code, label + "的本地部分长度不合法");
  for (const part of local.split(".")) {
    if (part.length === 0 || part.length > 63 || !ATOM.test(part))
      throw new MimeError(code, label + "的本地部分包含不允许的字符");
  }
}

function assertDomain(domain: string, code: MimeErrorCode, label: string): void {
  if (domain.length === 0 || domain.length > 255)
    throw new MimeError(code, label + "的域名长度不合法");
  const labels = domain.split(".");
  if (labels.length < 2) throw new MimeError(code, label + "的域名缺少点分标签");
  for (const item of labels) {
    if (!DOMAIN_LABEL.test(item))
      throw new MimeError(code, label + "的域名标签不合法");
  }
  const tld = labels[labels.length - 1] ?? "";
  if (!TLD.test(tld)) throw new MimeError(code, label + "的顶级域名不合法");
}

/**
 * 校验单个邮件地址。只接受裸地址（ASCII、无空白、无显示名、无分隔符），
 * 因此类似两个地址用逗号拼接的网页文本不会被当成两个收件人。
 * 返回域名小写化的规范化地址。
 */
export function validateAddress(
  input: string,
  limits: MimeLimits = DEFAULT_MIME_LIMITS,
): string {
  if (typeof input !== "string")
    throw new MimeError("INVALID_ADDRESS", "邮件地址必须是字符串");
  const value = input.trim();
  if (value.length === 0)
    throw new MimeError("INVALID_ADDRESS", "邮件地址不能为空");
  if (value.length > limits.maxAddressChars)
    throw new MimeError("INVALID_ADDRESS", "邮件地址超过长度上限");
  if (HEADER_CONTROL.test(value) || /\s/.test(value))
    throw new MimeError("INVALID_ADDRESS", "邮件地址不能包含空白或控制字符");
  if (NON_ASCII.test(value))
    throw new MimeError("INVALID_ADDRESS", "邮件地址仅接受 ASCII 字符");
  if (ADDRESS_STRUCTURAL.test(value))
    throw new MimeError("INVALID_ADDRESS", "邮件地址不能包含 <>()[],;:\"\\ 或显示名");
  const at = value.indexOf("@");
  if (at <= 0 || at !== value.lastIndexOf("@"))
    throw new MimeError("INVALID_ADDRESS", "邮件地址必须恰好包含一个 @");
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  assertLocalPart(local, "INVALID_ADDRESS", "邮件地址");
  assertDomain(domain, "INVALID_ADDRESS", "邮件地址");
  return local + "@" + domain.toLowerCase();
}

/** 把收件人输入规范化为 MailAddress；显示名中的控制字符同样拒绝。 */
export function normalizeAddress(
  input: AddressInput,
  limits: MimeLimits = DEFAULT_MIME_LIMITS,
): MailAddress {
  if (typeof input === "string") return { address: validateAddress(input, limits) };
  if (input === null || typeof input !== "object")
    throw new MimeError("INVALID_ADDRESS", "收件人必须是字符串或 {address, name}");
  const address = validateAddress(input.address, limits);
  const rawName = input.name;
  if (rawName === undefined || rawName === null) return { address };
  if (typeof rawName !== "string")
    throw new MimeError("INVALID_DISPLAY_NAME", "显示名必须是字符串");
  const name = rawName.trim();
  if (name.length === 0) return { address };
  if (HEADER_CONTROL.test(name))
    throw new MimeError("INVALID_DISPLAY_NAME", "显示名不能包含控制字符或换行");
  if (name.length > limits.maxDisplayNameChars)
    throw new MimeError("INVALID_DISPLAY_NAME", "显示名超过长度上限");
  return { address, name };
}

/** 规范化并去重（按小写地址，先出现者保留）一个收件人列表。 */
export function normalizeAddressList(
  input: readonly AddressInput[],
  limits: MimeLimits = DEFAULT_MIME_LIMITS,
  field = "addresses",
): MailAddress[] {
  if (!Array.isArray(input)) throw new MimeError("INVALID_INPUT", field + " 必须是数组");
  const seen = new Set<string>();
  const result: MailAddress[] = [];
  for (const item of input) {
    const address = normalizeAddress(item, limits);
    const key = address.address.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(address);
  }
  return result;
}

/** RFC 4648 base64url，无 padding。 */
function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

/** 计算附件字节的 sha256（小写 hex），供调用方填写声明值。 */
export function sha256Hex(bytes: Uint8Array): string {
  if (!(bytes instanceof Uint8Array))
    throw new MimeError("INVALID_ATTACHMENT", "附件内容必须是 Uint8Array 字节");
  return createHash("sha256").update(Buffer.from(bytes)).digest("hex");
}

/** 把任意换行（CRLF/CR/LF）统一为 CRLF。 */
export function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n|\r|\n/g, "\r\n");
}

export function validateSubject(
  subject: string,
  limits: MimeLimits = DEFAULT_MIME_LIMITS,
): string {
  if (typeof subject !== "string")
    throw new MimeError("INVALID_SUBJECT", "主题必须是字符串");
  if (HEADER_CONTROL.test(subject))
    throw new MimeError("INVALID_SUBJECT", "主题不能包含控制字符或换行");
  const value = subject.trim();
  if (value.length === 0) throw new MimeError("INVALID_SUBJECT", "主题不能为空");
  if (value.length > limits.maxSubjectChars)
    throw new MimeError("INVALID_SUBJECT", "主题超过长度上限");
  return value;
}

function encodeWord(text: string): string {
  return "=?UTF-8?B?" + Buffer.from(text, "utf8").toString("base64") + "?=";
}

/** 按 UTF-8 字节切成多个 encoded-word，每个不超过 75 字符且不拆分码点。 */
function chunkEncodedWords(value: string): string[] {
  const words: string[] = [];
  let buffer = "";
  for (const char of value) {
    if (buffer.length > 0 && Buffer.byteLength(buffer + char, "utf8") > 45) {
      words.push(encodeWord(buffer));
      buffer = "";
    }
    buffer += char;
  }
  if (buffer.length > 0) words.push(encodeWord(buffer));
  return words;
}

/**
 * RFC 2047 头部文本编码：纯 ASCII 原样返回；含非 ASCII 时用 UTF-8 base64 encoded-word。
 * 本函数假定输入已通过控制字符校验。
 */
export function encodeHeaderText(
  value: string,
  options: { fold?: boolean } = {},
): string {
  if (!NON_ASCII.test(value)) return value;
  return chunkEncodedWords(value).join(options.fold === true ? "\r\n " : " ");
}

/** 校验并编码 Subject 头（UTF-8 主题使用 RFC 2047）。 */
export function encodeSubject(
  subject: string,
  limits: MimeLimits = DEFAULT_MIME_LIMITS,
): string {
  const value = validateSubject(subject, limits);
  if (!NON_ASCII.test(value)) return value;
  const words = chunkEncodedWords(value);
  const single = words.join(" ");
  return single.length > 60 ? words.join("\r\n ") : single;
}

function quoteDisplayName(name: string): string {
  return '"' + name.replace(/[\\"]/g, (char) => "\\" + char) + '"';
}

function formatAddressHeader(address: MailAddress): string {
  const name = address.name;
  if (name === undefined || name.length === 0) return address.address;
  if (NON_ASCII.test(name)) return encodeHeaderText(name) + " <" + address.address + ">";
  if (DISPLAY_SPECIALS.test(name))
    return quoteDisplayName(name) + " <" + address.address + ">";
  return name + " <" + address.address + ">";
}

function foldAddressHeader(name: string, addresses: readonly MailAddress[]): string {
  if (addresses.length === 0) throw new MimeError("INVALID_INPUT", name + " 不能为空");
  const formatted = addresses.map(formatAddressHeader);
  const lines: string[] = [];
  let line = name + ": " + (formatted[0] ?? "");
  for (let index = 1; index < formatted.length; index++) {
    const value = formatted[index] ?? "";
    if (line.length + 2 + value.length > 78) {
      lines.push(line + ",");
      line = " " + value;
    } else {
      line += ", " + value;
    }
  }
  lines.push(line);
  return lines.join("\r\n");
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTH_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
] as const;

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/** RFC 5322 date-time，固定 UTC（+0000），避免本地时区与夏令时影响审批哈希。 */
export function formatRfc5322Date(date: Date): string {
  if (!(date instanceof Date) || Number.isNaN(date.getTime()))
    throw new MimeError("INVALID_DATE", "date 必须是有效 Date");
  const day = DAY_NAMES[date.getUTCDay()] ?? "Sun";
  const month = MONTH_NAMES[date.getUTCMonth()] ?? "Jan";
  return (
    day + ", " + pad2(date.getUTCDate()) + " " + month + " " + date.getUTCFullYear() +
    " " + pad2(date.getUTCHours()) + ":" + pad2(date.getUTCMinutes()) + ":" +
    pad2(date.getUTCSeconds()) + " +0000"
  );
}

/**
 * 规范化 Message-ID。可固定为完整的 <id@domain>、裸 id@domain，
 * 或仅是本地部分（自动补 From 域名）。返回带尖括号的形式。
 */
export function normalizeMessageId(
  input: string,
  fallbackDomain: string,
  limits: MimeLimits = DEFAULT_MIME_LIMITS,
): string {
  if (typeof input !== "string")
    throw new MimeError("INVALID_MESSAGE_ID", "Message-ID 必须是字符串");
  let value = input.trim();
  if (value.startsWith("<") && value.endsWith(">")) value = value.slice(1, -1);
  if (value.length === 0)
    throw new MimeError("INVALID_MESSAGE_ID", "Message-ID 不能为空");
  if (value.length > limits.maxMessageIdChars)
    throw new MimeError("INVALID_MESSAGE_ID", "Message-ID 超过长度上限");
  if (HEADER_CONTROL.test(value) || /\s/.test(value))
    throw new MimeError("INVALID_MESSAGE_ID", "Message-ID 不能包含空白或控制字符");
  if (/[<>]/.test(value))
    throw new MimeError("INVALID_MESSAGE_ID", "Message-ID 不能包含多余的尖括号");
  const at = value.indexOf("@");
  if (at === -1) {
    value = value + "@" + fallbackDomain;
  } else if (at !== value.lastIndexOf("@") || at === 0 || at === value.length - 1) {
    throw new MimeError("INVALID_MESSAGE_ID", "Message-ID 必须包含一个 @ 与两侧内容");
  }
  const split = value.indexOf("@");
  const local = value.slice(0, split);
  const domain = value.slice(split + 1);
  assertLocalPart(local, "INVALID_MESSAGE_ID", "Message-ID");
  assertDomain(domain, "INVALID_MESSAGE_ID", "Message-ID");
  return "<" + value + ">";
}

/** 传输编码：每 76 字符折行，符合 RFC 2045。 */
function wrapBase64(base64: string): string {
  const lines: string[] = [];
  for (let index = 0; index < base64.length; index += 76)
    lines.push(base64.slice(index, index + 76));
  return lines.join("\r\n");
}

function percentEncodeRfc2231(value: string): string {
  let out = "";
  for (const byte of Buffer.from(value, "utf8")) {
    const char = String.fromCharCode(byte);
    out += RFC2231_SAFE.test(char)
      ? char
      : "%" + byte.toString(16).toUpperCase().padStart(2, "0");
  }
  return out;
}

function asciiFallbackFilename(name: string): string {
  const replaced = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return replaced.length > 0 ? replaced : "attachment";
}

function textEntity(contentType: "text/plain" | "text/html", text: string): string {
  return [
    "Content-Type: " + contentType + "; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    wrapBase64(Buffer.from(text, "utf8").toString("base64")),
  ].join("\r\n");
}

function attachmentEntity(attachment: VerifiedAttachment, bytes: Uint8Array): string {
  const fallback = asciiFallbackFilename(attachment.filename);
  const disposition = NON_ASCII.test(attachment.filename)
    ? 'Content-Disposition: attachment; filename="' + fallback +
      "\"; filename*=UTF-8''" + percentEncodeRfc2231(attachment.filename)
    : 'Content-Disposition: attachment; filename="' + fallback + '"';
  return [
    "Content-Type: " + attachment.mimeType + '; name="' + fallback + '"',
    "Content-Transfer-Encoding: base64",
    disposition,
    "X-Attachment-SHA256: " + attachment.sha256,
    "",
    wrapBase64(Buffer.from(bytes).toString("base64")),
  ].join("\r\n");
}

function multipartEntity(
  subtype: "mixed" | "alternative",
  boundary: string,
  parts: readonly string[],
): string {
  const lines: string[] = [
    "Content-Type: multipart/" + subtype + '; boundary="' + boundary + '"',
    "",
    "This is a multi-part message in MIME format.",
  ];
  for (const part of parts) {
    lines.push("--" + boundary);
    lines.push(...part.split("\r\n"));
  }
  lines.push("--" + boundary + "--", "");
  return lines.join("\r\n");
}

function createBoundary(random: (size: number) => Uint8Array, taken: string): string {
  for (let attempt = 0; attempt < 16; attempt++) {
    const bytes = random(12);
    if (!(bytes instanceof Uint8Array) || bytes.length === 0)
      throw new MimeError("INVALID_INPUT", "random 必须返回非空 Uint8Array");
    const boundary = "=_hda_" + toBase64Url(bytes);
    if (!taken.includes(boundary)) return boundary;
  }
  throw new MimeError("INVALID_INPUT", "无法生成与正文不冲突的 MIME 边界");
}

function verifyAttachment(
  input: ManagedAttachmentInput,
  limits: MimeLimits,
): { verified: VerifiedAttachment; bytes: Uint8Array } {
  if (input === null || typeof input !== "object")
    throw new MimeError("INVALID_ATTACHMENT", "附件必须是对象");
  const filename = input.filename;
  if (typeof filename !== "string")
    throw new MimeError("INVALID_ATTACHMENT", "附件文件名必须是字符串");
  const name = filename.trim();
  if (name.length === 0)
    throw new MimeError("INVALID_ATTACHMENT", "附件文件名不能为空");
  if (name.length > limits.maxFilenameChars)
    throw new MimeError("INVALID_ATTACHMENT", "附件文件名超过长度上限");
  if (FILENAME_FORBIDDEN.test(name) || name === "." || name === "..")
    throw new MimeError(
      "INVALID_ATTACHMENT",
      "附件文件名不能包含路径分隔符、..、控制字符或换行",
    );
  const mimeType = input.mimeType;
  if (typeof mimeType !== "string" || !MEDIA_TYPE.test(mimeType))
    throw new MimeError("INVALID_ATTACHMENT", "附件类型必须是合法的 type/subtype");
  const bytes = input.bytes;
  if (!(bytes instanceof Uint8Array))
    throw new MimeError(
      "INVALID_ATTACHMENT",
      "附件只能传入调用方已读取的 Uint8Array 字节，不接受路径或字符串",
    );
  if (typeof input.sizeBytes !== "number" || !Number.isSafeInteger(input.sizeBytes))
    throw new MimeError("INVALID_ATTACHMENT", "附件 sizeBytes 必须是整数");
  if (input.sizeBytes !== bytes.byteLength)
    throw new MimeError(
      "ATTACHMENT_SIZE_MISMATCH",
      "附件实际字节数与声明 sizeBytes 不一致",
    );
  if (bytes.byteLength > limits.maxAttachmentBytes)
    throw new MimeError("ATTACHMENT_TOO_LARGE", "单个附件超过尺寸上限");
  const declared = input.sha256;
  if (typeof declared !== "string" || !HEX_SHA256.test(declared))
    throw new MimeError("INVALID_ATTACHMENT", "附件 sha256 必须是 64 位十六进制字符串");
  const actual = sha256Hex(bytes);
  if (actual !== declared.toLowerCase())
    throw new MimeError("ATTACHMENT_HASH_MISMATCH", "附件内容与声明 sha256 不一致");
  return {
    verified: {
      filename: name,
      mimeType: mimeType.toLowerCase(),
      sizeBytes: bytes.byteLength,
      sha256: actual,
    },
    bytes,
  };
}

/**
 * 组装 Gmail 发信所需的 MIME 与 base64url raw。
 *
 * 校验失败抛 MimeError；调用方应把这类失败记为不可重试的 FAILED_VALIDATION，
 * 并让用户修改后重新审批。
 */
export function buildGmailMimeMessage(input: GmailMimeInput): GmailMimeMessage {
  if (input === null || typeof input !== "object")
    throw new MimeError("INVALID_INPUT", "发信参数必须是对象");
  const limits = resolveLimits(input.limits);

  const from = normalizeAddress(input.from, limits);
  const to = normalizeAddressList(input.to, limits, "to");
  if (to.length === 0) throw new MimeError("INVALID_INPUT", "to 至少需要一个收件人");
  const replyTo =
    input.replyTo === undefined ? undefined : normalizeAddress(input.replyTo, limits);

  const seen = new Set<string>(to.map((item) => item.address.toLowerCase()));
  const take = (list: MailAddress[]): MailAddress[] => {
    const kept: MailAddress[] = [];
    for (const item of list) {
      const key = item.address.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      kept.push(item);
    }
    return kept;
  };
  const cc = take(input.cc === undefined ? [] : normalizeAddressList(input.cc, limits, "cc"));
  const bcc = take(
    input.bcc === undefined ? [] : normalizeAddressList(input.bcc, limits, "bcc"),
  );
  const recipientCount = to.length + cc.length + bcc.length;
  if (recipientCount > limits.maxRecipients)
    throw new MimeError("TOO_MANY_RECIPIENTS", "收件人数量超过上限");

  const subject = validateSubject(input.subject, limits);
  if (typeof input.plainText !== "string")
    throw new MimeError("INVALID_BODY", "纯文本正文必须是字符串");
  const plainText = normalizeLineEndings(input.plainText);
  if (BODY_CONTROL.test(plainText))
    throw new MimeError("INVALID_BODY", "纯文本正文包含不允许的控制字符");
  if (plainText.trim().length === 0)
    throw new MimeError("INVALID_BODY", "纯文本正文不能为空");
  if (plainText.length > limits.maxBodyChars)
    throw new MimeError("INVALID_BODY", "纯文本正文超过长度上限");

  let html: string | undefined;
  if (input.html !== undefined) {
    if (typeof input.html !== "string")
      throw new MimeError("INVALID_BODY", "HTML 正文必须是字符串");
    const normalized = normalizeLineEndings(input.html);
    if (BODY_CONTROL.test(normalized))
      throw new MimeError("INVALID_BODY", "HTML 正文包含不允许的控制字符");
    if (normalized.trim().length === 0)
      throw new MimeError("INVALID_BODY", "HTML 正文不能为空");
    if (normalized.length > limits.maxBodyChars)
      throw new MimeError("INVALID_BODY", "HTML 正文超过长度上限");
    html = normalized;
  }

  const rawAttachments = input.attachments ?? [];
  if (!Array.isArray(rawAttachments))
    throw new MimeError("INVALID_INPUT", "attachments 必须是数组");
  if (rawAttachments.length > limits.maxAttachmentCount)
    throw new MimeError("TOO_MANY_ATTACHMENTS", "附件数量超过上限");
  let totalBytes = 0;
  const attachments: VerifiedAttachment[] = [];
  const attachmentBytes: Uint8Array[] = [];
  for (const item of rawAttachments) {
    const result = verifyAttachment(item, limits);
    totalBytes += result.bytes.byteLength;
    if (totalBytes > limits.maxTotalAttachmentBytes)
      throw new MimeError("ATTACHMENT_TOTAL_TOO_LARGE", "附件总尺寸超过上限");
    attachments.push(result.verified);
    attachmentBytes.push(result.bytes);
  }

  const fromDomain = from.address.slice(from.address.lastIndexOf("@") + 1);
  const messageId =
    input.messageId === undefined
      ? "<" + randomUUID() + "@" + fromDomain + ">"
      : normalizeMessageId(input.messageId, fromDomain, limits);
  const date = input.date === undefined ? new Date() : input.date;
  const dateHeader = formatRfc5322Date(date);

  const random = input.random ?? ((size: number) => randomBytes(size));
  const taken = [
    subject,
    plainText,
    html ?? "",
    ...attachments.map((item) => item.filename),
    messageId,
  ].join("\n");

  const bodyEntity =
    html === undefined
      ? textEntity("text/plain", plainText)
      : multipartEntity("alternative", createBoundary(random, taken), [
          textEntity("text/plain", plainText),
          textEntity("text/html", html),
        ]);

  const entity =
    attachments.length === 0
      ? bodyEntity
      : multipartEntity("mixed", createBoundary(random, taken), [
          bodyEntity,
          ...attachments.map((item, index) =>
            attachmentEntity(item, attachmentBytes[index] ?? new Uint8Array(0)),
          ),
        ]);

  const headerLines: string[] = [
    "From: " + formatAddressHeader(from),
    foldAddressHeader("To", to),
  ];
  if (cc.length > 0) headerLines.push(foldAddressHeader("Cc", cc));
  if (bcc.length > 0) headerLines.push(foldAddressHeader("Bcc", bcc));
  if (replyTo !== undefined)
    headerLines.push("Reply-To: " + formatAddressHeader(replyTo));
  headerLines.push(
    "Subject: " + encodeSubject(subject, limits),
    "Date: " + dateHeader,
    "Message-ID: " + messageId,
    "MIME-Version: 1.0",
  );

  const mime =
    headerLines.join("\r\n") +
    "\r\n\r\n" +
    (entity.endsWith("\r\n") ? entity : entity + "\r\n");

  const result: GmailMimeMessage = {
    raw: toBase64Url(Buffer.from(mime, "utf8")),
    mime,
    messageId,
    subject,
    from,
    to,
    cc,
    bcc,
    attachments,
    recipientCount,
    sizeBytes: Buffer.byteLength(mime, "utf8"),
  };
  return replyTo === undefined ? result : { ...result, replyTo };
}
