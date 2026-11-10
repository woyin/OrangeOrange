import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "../config.js";
import { text } from "../config.js";
import type { Adapter, Fetch } from "./types.js";
import { telegramAdapter } from "./telegram.js";
import { whatsappAdapter, type WhatsAppConfig } from "./whatsapp.js";
import { weixinAdapter, type WeixinCredentials } from "./weixin.js";
export async function loadChannels(
  config: Config,
  fetcher: Fetch = fetch,
): Promise<{ adapters: Adapter[]; whatsapp?: WhatsAppConfig }> {
  const env = config.channelEnv;
  const adapters: Adapter[] = [];
  const required = (name: string) => text(env[name], name, 2000);
  const users = (name: string) =>
    (env[name] ?? "")
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean);
  if (env.ORANGE_TELEGRAM_TOKEN) {
    const token = required("ORANGE_TELEGRAM_TOKEN");
    if (!/^\d+:[A-Za-z0-9_-]+$/.test(token))
      throw new Error("Telegram token 格式无效");
    adapters.push(
      telegramAdapter(
        token,
        users("ORANGE_TELEGRAM_USERS"),
        env.ORANGE_TELEGRAM_MEMORY_SCOPE,
        fetcher,
      ),
    );
  }
  let whatsapp: WhatsAppConfig | undefined;
  if (env.ORANGE_WHATSAPP_TOKEN) {
    const version = required("ORANGE_WHATSAPP_API_VERSION");
    if (!/^v\d+\.\d+$/.test(version)) throw new Error("WhatsApp API 版本无效");
    const phoneId = required("ORANGE_WHATSAPP_PHONE_ID");
    if (!/^\d+$/.test(phoneId)) throw new Error("WhatsApp phone ID 无效");
    const port = Number(required("ORANGE_WHATSAPP_PORT"));
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw new Error("WhatsApp 回调端口无效");
    whatsapp = {
      token: required("ORANGE_WHATSAPP_TOKEN"),
      phoneId,
      version,
      port,
      appSecret: required("ORANGE_WHATSAPP_APP_SECRET"),
      verifyToken: required("ORANGE_WHATSAPP_VERIFY_TOKEN"),
      allowedUsers: users("ORANGE_WHATSAPP_USERS"),
      sharedScope: env.ORANGE_WHATSAPP_MEMORY_SCOPE,
    };
    adapters.push(whatsappAdapter(whatsapp, fetcher));
  }
  if (env.ORANGE_WEIXIN_TOKEN || env.ORANGE_WEIXIN_ENABLED === "1") {
    let saved: WeixinCredentials | undefined;
    if (!env.ORANGE_WEIXIN_TOKEN) {
      try {
        saved = JSON.parse(
          await readFile(
            join(config.dataDir, "weixin-credentials.json"),
            "utf8",
          ),
        );
      } catch {
        throw new Error("缺少有效微信凭据；请先运行 weixin login");
      }
    }
    const credentials = saved ?? {
      account: required("ORANGE_WEIXIN_ACCOUNT_ID"),
      token: required("ORANGE_WEIXIN_TOKEN"),
      user: "",
      base: "https://ilinkai.weixin.qq.com",
    };
    if (!credentials.account || !credentials.token || !credentials.base)
      throw new Error("微信凭据不完整");
    const allowed = users("ORANGE_WEIXIN_USERS");
    adapters.push(
      weixinAdapter(
        credentials,
        allowed.length ? allowed : credentials.user ? [credentials.user] : [],
        env.ORANGE_WEIXIN_MEMORY_SCOPE,
        fetcher,
      ),
    );
  }
  return { adapters, whatsapp };
}
