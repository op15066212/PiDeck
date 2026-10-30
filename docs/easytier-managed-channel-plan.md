# EasyTier 从只读渠道升级为可托管渠道

状态：**已落地**（2026-10-31，dev 分支）。落地范围经用户确认：单网络实例、多共享节点、服务模式启停、密钥明文存设置。

## 背景

现状（`src/main/web/remoteAccess/easytierAccess.ts`）把 EasyTier 定义为**只读渠道**：
PiDeck 只调 `easytier-cli -o json node` 读虚拟 IP，不启动/停止网络，也不进
`RemoteAccessChannelId` 的 start/stop 白名单。用户得自己开客户端或命令行。

实测下来这条路对普通用户不通：官方公共节点 `public.easytier.cn` 已下线，
客户端还要手填网络名/密钥/对等节点三处，手机上尤其难。

## 目标

PiDeck 完整托管本机 EasyTier core：检测 → 配置 → 启动 → 展示连接信息 → 分享给手机。

手机端拿到配置的方式已探明（`easytier-web/frontend-lib/src/components/RemoteManagement.vue`）：

```html
<input type="file" accept="application/toml">  →  parse_config(tomlText)
```

即 **TOML 文件 → App「导入配置」→ 选文件 → 保存并启动**。文件名不校验，扩展名 `.toml`。

## 能力对照表

| 能力 | 现状 | 目标 | 门禁 |
|---|---|---|---|
| 检测 core | 只找 `easytier-cli` | 同时定位 `easytier-core` | 单测：PATH/常见目录/自定义路径三路 |
| 启停网络 | 无（只读） | `easytier-cli service install/start/stop/status` | 手动验证：装服务→启停→状态回读 |
| 配置网络 | 无 | 设置项：网络名/密钥/多 peer/绑定 IP | 单测：清洗与非法值丢弃 |
| 生成配置 | 无 | 按设置生成 TOML（同 core 启动打印格式） | 单测：TOML 字段与 core dump 对齐 |
| 下发配置 | 无 | `GET /api/easytier/config.toml` | 手动验证：curl 拿到的文件能被 App 导入 |
| 展示连接信息 | 读虚拟 IP | 额外展示服务状态、peer 数 | 现有 peer 表复用 |
| Web 访问地址 | 已有 QR | 不变 | — |

## 关键决策

1. **服务模式而非每次 UAC**：Windows 下 Electron 无法带 UAC 创建进程且拿不到句柄。
   改用 `easytier-cli service install` 一次性装成系统服务，之后 `start/stop/status` 全部免提权。
   提权仅发生在 install 那一步（用户执行一条命令或 UAC 弹窗）。
2. **密钥明文存 `settings.json`**：与现有 `apiKey` 等字段同级别。用户已确认接受。
   仅存本地，不经 Web API 暴露（`/api/state` 投影不含密钥）。
3. **单实例多 peer**：不做多网络实例并行。TOML 里 `[[peer]]` 重复即可。
4. **绑定 IP**：默认 DHCP；用户填了固定 IPv4 则写 `ipv4` 并关闭 `dhcp`。

## 分阶段

- **P1 契约层**：`shared/types/settings.ts` 四个新字段 + 清洗函数；`shared/types/remoteAccess.ts`
  把 `easytier` 加入 `RemoteAccessChannelId`，状态补 `serviceInstalled/serviceRunning/configPresent`。
- **P2 主进程**：`easytierService.ts`（检测/服务控制/TOML 生成）；`RemoteAccessManager` 接入
  start/stop 与配置注入。
- **P3 下发**：`/api/easytier/config.toml`，`Content-Type: application/toml`，
  `Content-Disposition: attachment; filename="<网络名>.toml"`。仅在本机 Web 服务运行时可用。
- **P4 渲染层**：EasyTier 卡片加网络名/密钥/peer 列表/绑定 IP/启动停止/分享面板（QR 指向下载地址）。
- **P5 i18n**：四份词典 + `node scripts/genZhTwCopy.mjs`。

## 风险

- 手机首次必须能访问下载地址：同 Wi-Fi 走局域网 IP，异网需先开 Cloudflare/Tailscale 通道。
  UI 需按当前可用渠道切换二维码目标，不能只给一个地址。
- `parse_config` 对未知字段可能报错，生成的 TOML 只写 core 自身 dump 出现过的字段。
- 服务名默认 `easytier`，与用户手工装的服务可能冲突，需在 install 前 `status` 探测。
