import { readFile } from "node:fs/promises";
const report = JSON.parse(
  await readFile(
    new URL("../docs/acceptance-results.json", import.meta.url),
    "utf8",
  ),
);
const failures = [];
for (let n = 1; n <= 24; n++) {
  const id = `AT-${String(n).padStart(3, "0")}`;
  const item = report.cases.find((c) => c.id === id);
  if (!item || item.status !== "PASS" || !item.evidence?.length)
    failures.push(`${id}: ${item?.status ?? "MISSING"}`);
}
const targets = report.environment?.verifiedPlatforms ?? [];
for (const platform of ["linux/amd64", "linux/arm64"])
  if (!targets.includes(platform))
    failures.push(`缺少实际镜像启动验收：${platform}`);
if ((report.environment?.soakDurationMs ?? 0) < 72 * 3600000)
  failures.push("缺少完整72小时稳定性证据");
if (!report.environment?.openWrtVerified)
  failures.push("缺少真实OpenWrt部署验收");
if (
  !report.environment?.realModelVerified ||
  !report.environment?.realTelegramVerified
)
  failures.push("缺少真实模型或Telegram闭环验收");
console.log(
  JSON.stringify({ releasable: failures.length === 0, failures }, null, 2),
);
if (failures.length) process.exitCode = 1;
