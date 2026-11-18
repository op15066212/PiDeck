// _cli.mjs —— 本技能五个检查器共用的命令行约定与源码定位。
//
// 为什么抽出来（2026-11-18）：同一套约定（--src= / --skill= / 位置参数 / --selftest，
// 以及「src/main 还是 src」的两种布局探测）在 check-fields / check-paths / check-doc 里
// 各写了一遍，默认路径还各算一遍。实测的后果是同一个技能的三条判据对同一份源码给出
// 不同的「找不到」：有的 rc=2 并指名路径，有的直接抛栈。
//
// 统一性 = 同一事实的可写处个数。这里的「事实」是「源码在哪」，可写处从三处收到一处。
// 模块放在技能目录内：技能必须自包含，引用目录外的东西会让它单独复制出去后坏掉。

import fs from "node:fs";
import path from "node:path";

/** --name=value 形式的值；没有就返回 null。 */
export function opt(name, list = process.argv.slice(2)) {
  const hit = list.find((a) => a.startsWith("--" + name + "="));
  return hit ? hit.slice(name.length + 3) : null;
}

/** 第一个不以 -- 开头的参数（位置参数）。 */
export function positional(list = process.argv.slice(2)) {
  return list.find((a) => !a.startsWith("--")) || null;
}

export function isSelftest(list = process.argv.slice(2)) {
  return list.includes("--selftest");
}

/** 两种布局都认：src/web/... 与 src/main/web/...。返回真正的 src 根。 */
export function pickBase(base) {
  if (fs.existsSync(path.join(base, "web/WebApiRoutes.ts"))) return base;
  if (fs.existsSync(path.join(base, "main/web/WebApiRoutes.ts"))) return path.join(base, "main");
  return base;
}

/** 源码根：--src= 优先，其次技能位置往上三级（技能在 <repo>/resources/skills/<name>）。 */
export function srcBase(here, list = process.argv.slice(2)) {
  const arg = opt("src", list);
  return pickBase(arg ? path.resolve(arg) : path.resolve(here, "../../../src/main"));
}

/** 被检的 SKILL.md：位置参数优先，其次本目录。 */
export function skillFile(here, list = process.argv.slice(2)) {
  return positional(list) || path.join(here, "SKILL.md");
}

/** 两个会承载路由的源文件，存在的才算。 */
export function routeFiles(base) {
  return ["web/WebApiRoutes.ts", "web/WebServiceManager.ts"]
    .map((rel) => path.join(base, rel))
    .filter((f) => fs.existsSync(f));
}
