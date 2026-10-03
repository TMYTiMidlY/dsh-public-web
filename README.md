# dsh-public-web

这个仓库为官方 DeepSeek Harness 的 **Web profile 直接远程访问**补齐浏览器端的设置与文件预览能力，并维护这条接入路径的部署说明。浏览器连接的是正在运行的 `dsh web`；本仓不实现 dsh-mobile、配对客户端、中继协议或另一套后端。

官方已经支持公网 authority 放行，也已经能公告公网地址。本插件仍有存在的理由，是因为截至 `dsh-v0.2.1-alpha.1`：公网浏览器中的官方设置镜像仍不可持久读取、保存 Host 配置；资源地址仍依赖浏览器对非标准 scheme 的 hostname 解析；文件预览仍等待变更订阅确认后才显示第一帧。这些客户端行为不随 Caddy 登录、DSH cookie 或 `--public-url` 改变。

> 核对日期：2026-10-03。主机代码从当前 DSH 安装加载；本仓设置与工作区文件客户端来源为 `0.1.7-rc.2`，资源客户端来源为 `0.2.1-alpha.1`。经源码比较，相关设置、资源解析和文件订阅实现从 `0.1.7-rc.2` 到 `0.2.1-alpha.1` 没有行为修改。后续版本须重新核对。

## <a id="contents"></a>阅读入口

- [DSH 与本仓的版本历史](#history)
- [官方参数与公告地址](#public-url)
- [请求信任与浏览器会话](#web-trusted-host)
- [SSH、私网 relay 与 Caddy 接入](#remote-access-methods)
- [公网设置限制](#client-isloopback)
- [文件兼容与诊断](#file-compatibility)
- [安全边界](#security-boundaries)
- [安装、升级和卸载](#install)

## <a id="history"></a>DSH 与本仓的版本历史

这里跟踪影响直接远程 Web 的变化，而不是把桌面、模型、Agent 工具等全部发布内容抄进来。完整发布记录见 [DSH releases](https://github.com/deepseek-ai/deepseek-harness/releases)。

| 版本或提交 | 与直接远程 Web 有关的变化 | 对本仓的意义 |
|---|---|---|
| DSH `0.1.1-rc.2` 及更早 | loopback 本身有特权；设置、凭据、宿主文件管理等方法另有仅 loopback 的校验 | 当时单加可信公网主机还不能使用这些管理接口，旧反代教程经常成对改写 Host/Origin |
| DSH `0.1.2-alpha.1` | 引入统一启动 token → 签名 cookie 认证；loopback 请求也需要会话 | 代理改写 loopback 不再绕过认证；客户端设置限制仍保留 |
| DSH `0.1.2-alpha.2` | Settings 改用新 Remote namespace 和 `ctx.remote.$host.isLoopback` | 接线位置变了，公网仍是 `memory` / `unavailable` |
| DSH `0.1.5-alpha.1` 起 | 引入资源 registry 与双面 workspace-files；用 URL hostname 选择 provider，首次 stat 等待订阅确认 | 后来两项文件补丁针对的路径在此形成 |
| DSH `0.1.7-alpha.1` 起 | API/插件资源改用相对文档目录，token 交换重定向为 `./`；改进侧栏自动刷新和 watcher 生命周期 | 支持剥离前缀的反代接入；公网设置限制与确认等待仍保留 |
| DSH `0.1.7-rc.2` | 公网 API 由 `trustedHosts` 放行并要求会话；设置镜像仍按页面是否 loopback 选 `host` / `memory` | 公网登录成功与设置可用是两件事；本仓设置与文件客户端的基线 |
| 本仓 [`3fde359`](https://github.com/TMYTiMidlY/dsh-public-web/commit/3fde359)，2026-09-29 | 聚合公网主机放行、强制 Host 设置持久化、资源 URL 兼容和 800ms 文件读取兜底 | 初始工作区文件客户端超时后只显示一次文件，退出订阅；URL 兼容替换全局 `window.URL` |
| 本仓 [`6b28476`](https://github.com/TMYTiMidlY/dsh-public-web/commit/6b28476)，2026-09-29 | 包名改为 `dsh-public-web`，保留 `0.1.3` | 旧文件名 `dsh-public-*.tgz` 是历史产物 |
| DSH [`0.2.0-rc.1`](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.0-rc.1) | 改善插件管理、配置保存等待和 Office/PDF 预览等体验 | 没有解除公网设置限制，也没有加入文件确认超时兜底 |
| DSH [`0.2.0-rc.2`](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.0-rc.2) | 改善设置预设、文件夹本地打开、模型选择；pi-ai 更新到 `0.87.1` | 文件夹本地打开与浏览器预览不同；公网设置持久化和两个文件补丁仍未被替代 |
| DSH [`0.2.1-alpha.1`](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.1-alpha.1) | 新增 `--public-url`，支持代理路径前缀的公告；改善 Markdown frontmatter 预览与插件依赖管理 | 地址公告归官方能力；本仓只维护尚未覆盖的客户端行为 |
| 本仓当前代码，2026-10-03 | URL 兼容限定到资源解析；慢订阅先显示文件，确认后继续自动更新；增加浏览器诊断和可配置等待预算 | 有条件的兼容补丁取代全局 URL 改写和一次性降级；尚未发布新版本 |

> 来源：[旧 loopback 层](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.1-rc.2/packages/client/connection/src/index.ts)、[`0.1.2-alpha.1` 浏览器认证](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.2-alpha.1/packages/client/connection/src/browser-auth.ts)、[当前 Settings persistence](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-alpha.1/packages/client/ui-settings/src/client/index.ts#L39)、[当前文件订阅等待](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-alpha.1/packages/api/workspace-files/src/client/provider.ts#L68)、[当前资源协议解析](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-alpha.1/packages/client/resources/src/client/resources.ts#L55)。

> 历史提交：[资源 registry](https://github.com/deepseek-ai/deepseek-harness/commit/3a85ac6d81)、[workspace-files 双面 API](https://github.com/deepseek-ai/deepseek-harness/commit/4ce4f0bac4)、[相对目录与前缀反代接线](https://github.com/deepseek-ai/deepseek-harness/commit/eeb9b03465)、[侧栏自动刷新](https://github.com/deepseek-ai/deepseek-harness/commit/c71e907490)、[watcher 生命周期修正](https://github.com/deepseek-ai/deepseek-harness/commit/4f55590aea)。

## <a id="public-url"></a>官方参数与公告地址

典型的根域名部署：

```sh
dsh web --no-open --port 3080 \
  --trusted-host dsh.example.com \
  --public-url https://dsh.example.com/
```

| 参数 | 管理的对象 | 使用条件 |
|---|---|---|
| `--host` / `--port` | DSH 实际监听地址和端口 | 私有上游；默认 loopback；CLI 拒绝 `0.0.0.0` |
| `--trusted-host host[:port]` | RPC/API 和 WebSocket 的 Host 信任栅栏 | 保留公网 Host 的代理需要声明；裸 hostname 匹配任意端口，带端口则精确匹配 |
| `--public-url http(s)://host[/prefix]/` | 公告给人和模型的 Web 应用根 | 希望公告与真实浏览器入口一致时设置；不授予信任，也不配置代理 |
| `--no-open` | 启动时打开浏览器 | systemd 服务通常设置 |

`--public-url` 从 `0.2.1-alpha.1` 起支持，会归一化尾斜杠。只接受无用户名、密码、query、fragment 的绝对 HTTP(S) URL。它影响：

- 启动打印的带 token URL；
- 自动打开浏览器的 URL（`--no-open` 时这一项没有作用）；
- Agent 命令可读取的 `DSH_WEB_URL`，其值是应用根，不含启动 token；
- 模型收到的 Web GUI 定位提示，告诉模型“当前这个 GUI”位于哪里。完整 Agent persona 可抑制该提示，但 Host 提供的命令环境变量仍保留。

它不改变正在打开的页面地址、API 路由、资源地址、cookie 作用域、公网设置限制或文件订阅可靠性。用固定域名访问、无需复制启动日志地址、Agent 也不使用该地址时，可以暂不设置。独立插件名为 `publicUrl` 的字段各有自身语义，不能互相代替。

代理挂载 `https://dsh.example.com/ui/` 时，代理仍须剥离 `/ui/` 后转发、把裸 `/ui` 重定向到 `/ui/`、转发 WebSocket 升级，并把上游 cookie 的 `Path=/` 改成 `/ui/`、在 HTTPS 外链添加 `Secure`。根域名部署无需路径剥离。官方支持的 prefix 行为应按当前版本端到端验证；仅设置公告参数不会建立这些代理行为。

> 来源：[公告地址的实际接线](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-alpha.1/packages/bundle/web-app/src/index.ts#L245-L295)、[参数解析](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-alpha.1/packages/bundle/web-app/src/public-url.ts#L16-L41)、[官方反代部署要求](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-alpha.1/docs/user/guide/public-deployments.zh.md)、[Web bundle 接线与 persona 边界](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-alpha.1/packages/bundle/web-app/cordis.patch.yml#L187-L208)。

## <a id="web-trusted-host"></a>DSH Web 的访问控制

本章说明 DSH Web 的访问控制模型和远程使用方式：浏览器请求经过哪两道校验、会话凭据怎样获取、续期与改寿命、远程接入有哪三条路径，以及远程页面上浏览器端的功能限制。

DSH Web 默认监听 `127.0.0.1:3080`。CLI 把 `--host 0.0.0.0` 视为安全相关的用法错误并退出，使默认服务入口保持在 loopback。RPC/API 与 WebSocket 请求先过 Host/Origin 信任校验，再过浏览器会话认证；自 `0.1.2-alpha.1` 起 **localhost 不再是特权**——没有有效会话时，带 loopback `Host` 的请求同样收到 401。`0.1.1-rc.2` 及更早仍是 loopback 即特权，见本章末尾的[旧版本的 loopback 特权](#loopback-privilege-history)。

> 版本边界按源码 tag 核对：`browser-auth.ts` 在 [`dsh-v0.1.2-alpha.1`](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.2-alpha.1/packages/client/connection/src/browser-auth.ts) 已存在，在 [`dsh-v0.1.1-rc.2`](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.1.1-rc.2/packages/client/connection/src) 尚无。

> 来源：[webserver 的 host 只接受回环与全接口](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.2-alpha.5/packages/host/webserver/README.zh.md#L39)、[`--host 0.0.0.0` 的启动拒绝](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.2-alpha.5/packages/bundle/web-app/src/startup.ts#L74-L75)。

### <a id="browser-session-auth"></a>浏览器请求的准入校验

本节先定义读判定规则所需的 authority 概念，再说明两道校验的通过条件，最后给出信任校验的判定顺序；会话凭据本身的获取、属性与寿命见[浏览器会话凭据的生命周期](#browser-session-lifecycle)。

这里的 authority 专指 URL 解析后的 `host[:port]`，也就是**域名或 IP，加上非默认端口**；不包含 `http://`、`https://` 等 scheme，也不包含路径。请求的 `Host` header 直接携带 authority；`Origin` 则形如 `scheme://authority`，DSH 用 `new URL(origin).host` 取出其中的 authority。

浏览器无论经哪条路径到达 DSH，RPC/API 与 WebSocket 请求都按顺序经过两道校验：先信任，后身份。根路径的 token 兑换与 index 页面走独立的 `authorizeIndex` 会话逻辑，不先经过这道 API 信任栅栏；因此“页面能加载”不等于“API 被放行”。每个 Host RPC 方法与 WebSocket stream 都要求同一个浏览器会话，不存在按方法区分的 loopback 层。

| 阶段 | 通过条件 | 失败结果 | 防御对象 |
|---|---|---|---|
| 信任 | `Host` 是 loopback，或匹配 `trustedHosts` 条目；`Sec-Fetch-Site` 不是显式的 `cross-site`；`Origin` 缺省，或与 `Host` 为同一 authority | 403 | DNS rebinding 与跨站请求；不证明请求者身份 |
| 身份 | 信任通过后，请求携带未过期、签名正确、绑定当前 authority 的会话 cookie | 401 | 未认证访问；伪造 `Host: localhost` 也绕不过这一层 |

DSH 的 `isTrustedApiRequest()` 按以下顺序执行信任校验：

1. 解析 `Host`，接受 loopback 域名/IP及端口或 `trustedHosts` 中的值。
2. 检查 `Sec-Fetch-Site`，值为 `cross-site` 时拒绝请求。
3. 读取可选的 `Origin`，并比较 `new URL(origin).host === hostUrl.host`。

比较对象是两边经 WHATWG URL 解析得到的 `.host`（hostname 加规范化后的端口）。scheme 不直接参与比较，但会决定默认端口是否从 `.host` 中省略。下表假定 `Sec-Fetch-Site` 的值为 `same-origin`、`same-site`、`none` 或缺省：

| DSH 收到的 `Host` | DSH 收到的 `Origin` | 信任校验结果 |
|---|---|---|
| `dsh.example.com` | `http://127.0.0.1:3080` | 公网域名未受信时在 Host 校验拒绝；配置 `--trusted-host dsh.example.com` 后仍因两边 `.host` 不同而拒绝 |
| `127.0.0.1:3080` | `https://dsh.example.com` | Host 校验通过，Origin 的 `.host` 不同，拒绝 |
| `127.0.0.1:3080` | `http://127.0.0.1:3080` | 通过；随后的会话校验决定 401 还是放行 |
| `dsh.example.com` | `https://dsh.example.com` | 配置 `--trusted-host dsh.example.com` 后通过；同样还要会话 |

缺少 `Origin` 的请求仍受 Host fence 约束。WebSocket 和部分 fetch（如 POST）携带 `Origin`，同源 GET fetch 常不携带；代理保留浏览器产生的 `Sec-Fetch-Site`，同一公网页面发往同源 API 时该值符合非 cross-site 条件。

Settings 读写、Credentials、Agent preset 管理、宿主文件操作、端点探测这组方法在 `0.1.1-rc.2` 及更早版本另有只接受 loopback 的第二层校验；统一会话认证取消了这层名单，版本差异见[旧版本的 loopback 特权](#loopback-privilege-history)。

> 来源：[Host fence、cross-site fence 与 Origin/Host 精确相等检查](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.2-alpha.5/packages/client/connection/src/api-request-trust.ts#L91-L118)、[requestRejection](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.2-alpha.5/packages/client/connection/src/rpc-host.ts#L96-L98)、[authorizeIndex](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.2-alpha.5/packages/client/connection/src/browser-auth.ts#L240-L276)、[浏览器认证与请求信任](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.2-alpha.5/packages/client/connection/README.zh.md#L32-L39)。

### <a id="browser-session-lifecycle"></a>浏览器会话凭据的生命周期

本节按凭据的时间线组织：启动 token 怎样兑换成会话 cookie、cookie 的属性与寿命如何配置、凭据怎样失效，以及 systemd 托管时从哪里取 token。

第一次（或没有 cookie）时，必须完成一次 token 交换：

1. 每个进程在启动时生成一个随机 token，`dsh web` 打印（且除非 `--no-open` 或 SSH 抑制，自动打开）应用根的 `?token=...` URL；未设 `--public-url` 时才是 `http://127.0.0.1:<port>/?token=...`；
2. 这个 query token 只在 `GET /` 一个入口被接受；命中后 DSH 写入绑定 authority 的签名 cookie，并 303 重定向到不带 token 的 `./`，保留当前挂载目录；
3. 之后 RPC、WebSocket 和 index 页面都靠这枚 cookie，URL 里不再带 token。根路径交换之外，HTTP 载体不接受 query token，也不接受 Authorization header token。

启动 token 是每个进程唯一的一枚随机值：43 字符 base64url，只存内存、不落盘，也不因兑换而消耗。`GET /?token=X` 的校验只有一步——把 X 与当前进程这一枚做字符串相等比较（常数时间实现，防时序侧信道）。因此 token 的「有效」就是与当前值相等；进程重启换新后，更早打印过的 token 全部随之失效。

已经认证过则：

- cookie 未过期（默认 30 天，`cookieMaxAgeDays`）且签发时的 hostname:port 与签名密钥未变时，重启 dsh 后仍可用，不必再贴 token——签名密钥是 `$DSH_HOME/.credentials.yaml` 中 `client-connection/browser-session` 拥有的持久凭据记录，不随进程重新生成，启动 token 才是逐进程新生成；
- URL 里带了已失效的旧 token 但 cookie 仍有效时，DSH 直接 303 清掉 query 进入页面；token 仍有效时则按普通兑换流程重新签发一枚会话 cookie；
- 非 index 的官方静态资源保持公开；能真正操作 Host 的官方 RPC/API 与 WebSocket 接口都要会话。第三方自注册路由须另外审查。

cookie 本身是 host-only、`Path=/`、`HttpOnly`、`SameSite=Strict`，确定性名称与签名 payload 都绑定规范化的 hostname 和 port；随附服务器使用 loopback HTTP，因此刻意不设置 `Secure`。没有 logout 操作：清除浏览器站点数据只结束这一个浏览器；删除上述凭据记录并重启 dsh 撤销全部会话。

cookie 的期限在兑换那一刻封进签名 payload，之后不再变：`issuedAt` 与 `expiresAt` 按兑换时生效的 `cookieMaxAgeDays` 写定，此后访问不重算也不改写期限。`cookieMaxAgeDays` 的最小取值是 1，没有永不过期；签发时刻与寿命按安全整数校验。每次验证检查已签发的时间区间，要求签发不在未来、尚未过期、过期晚于签发，且「签发→过期」跨度不超过**当前配置**的 maxAge。配置变化不会重签已有 cookie：调大配置不延长旧 cookie，调小配置会让跨度超过新上限的旧 cookie 立即无效。要取得新期限，须重新兑换。兑换时封定的还有 authority——cookie 绑定兑换请求呈现的 `host[:port]`，所以要在实际使用的地址下兑换；经代理部署时按代理最终向 DSH 呈现的 authority 兑换（见[反向代理公网入口](#caddy-public-entry)的代持段）。

> 把一枚已认证的 cookie 手工放进另一个浏览器，只在浏览器以同一 authority 直接访问 DSH 时有效；经反向代理域名访问时，浏览器不会把 loopback 域名的 cookie 发给公网域名。反代部署换浏览器时，要么用当前进程的启动 token 重新兑换，要么由代理层统一附带会话，见[反向代理公网入口](#caddy-public-entry)中的代持段。

#### <a id="cookie-max-age-patch"></a>调整 cookie 寿命的 patch

调整该值通过 patch 覆盖 web-app 已经 insert 的 `connection` 行。insert 与按 id 覆盖的原理见官方 [Loader 配置文档](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-alpha.1/docs/cordis-primer.zh.md#loader-configuration)。文件位置与叠加顺序见[安装与配置](#install)。

覆盖条目写在 Profile patch 的顶层数组里，与 MCP 的 `- insert:` 平级。`config` 整段替换，须把 `trustedHosts` 一并写出：

```yaml
- id: connection
  config:
    cookieMaxAgeDays: 3650
    trustedHosts: !!js ctx.webRuntime.trustedHosts
```

写入正在监视的 live 文件前，用独立进程检查。`--patch` 叠在现有 Profile patch 之上，草稿里不要再 insert 已经存在的行：

```sh
dsh --profile web --patch ./draft.cordis.yml --dump-config
```

核对输出里 `id: connection` 只出现一次，注释含 `patched by`，`config` 同时含 `cookieMaxAgeDays` 与 `trustedHosts`。dump 打印合成树后退出，不占用 Web 端口，也不通知 systemd 那个进程。同一 id 出现两行时 dump 仍以 0 退出；Loader 真正应用时才抛 `duplicate loader entry id`。

要测「整份替换现有 `cordis.patch.yml`」，另拷一份 Harness home，改副本后再 dump：

```sh
cp -a "${DSH_HOME:-$HOME/.dsh}" "${PRIVATE_WORK_DIR:?先选择已创建的私有工作目录}/dsh-check"
DSH_HOME="$PRIVATE_WORK_DIR/dsh-check" dsh --profile web --dump-config
```

dump 看不到 module 导入和 Config schema 错误。需要实跑时用备用端口，避开正在服务的端口：

```sh
dsh --profile web --patch ./draft.cordis.yml --no-open --port <spare-port>
```

检查通过后再把顶层 `- id: connection` 写进 `$DSH_HOME/profiles/web/cordis.patch.yml`。服务仍在运行时，`live` 型 Profile 靠 HMR 热重载生效（机制见 [Patch 热更新的生效机制](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-alpha.1/packages/boot/app-boot/README.zh.md)），不必 restart。

#### <a id="launch-token-journal"></a>启动 token 的转交与 journal

`dsh web` 一般会自己打印并打开带 token 的 URL，本机用户通常感觉不到这次交换；但设计上连本机浏览器也必须完成它。远程部署时，token 由部署者从启动输出转交给远端浏览器。

systemd 托管时，这条 URL 随标准输出进入 journal。用户服务可把 token 读入当前 shell 的普通变量，供后续兑换使用，不回显凭据：

```sh
set +x
DSH_SERVICE_PID="$(systemctl --user show dsh.service -p MainPID --value)"
test "$DSH_SERVICE_PID" -gt 0
DSH_LAUNCH_TOKEN="$(journalctl --user -u dsh.service "_PID=$DSH_SERVICE_PID" -o cat | grep -E '^dsh web: https?://' | grep -oE 'token=[A-Za-z0-9_-]+' | tail -n 1 | cut -d= -f2)"
test -n "$DSH_LAUNCH_TOKEN"
```

系统服务从两个命令去掉 `--user`，并在需要时以有 journal 读取权限的身份运行。模板实例的两个 service 名都换成 `dsh@<user>.service`。不要 `echo` 或导出 token 变量；当前 MainPID 没有打印地址时应停下来检查启动状态，不能回退抓旧进程的 token。兑换命令在同一 shell 中执行，用完后 `unset DSH_LAUNCH_TOKEN DSH_SERVICE_PID`。

筛选同时限定当前 MainPID 和打印行：经由同一 dsh 实例执行运维命令时，sudo 等子进程的审计行也会进入该 unit 的 journal，命令文本里形如 `token=…` 的字面量会污染只按 `token=` 匹配的抓取。

token 只随进程重启更换：它以进程的 root context 为键存于内存，修改 patch 等触发的 Connection 热重载沿用同一 token，journal 里已打印的旧 token 仍可兑换。

> 来源：[cookie 名称与属性](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.2-alpha.5/packages/client/connection/src/browser-auth.ts#L107-L122)；[签名密钥的凭据记录](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.2-alpha.5/packages/client/connection/src/browser-auth.ts#L12-L16)；[无 logout 的边界](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.2-alpha.5/packages/client/connection/README.zh.md#L59-L63)；[web-app 的启动输出](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.2-alpha.5/packages/bundle/web-app/README.zh.md#L37)；[maxAge 的下限与默认值](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.2-rc.1/packages/client/connection/src/index.ts#L88)、[寿命的安全整数校验](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.2-rc.1/packages/client/connection/src/browser-auth.ts#L189-L200)与[跨度不超过当前 maxAge 的验证](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.2-rc.1/packages/client/connection/src/browser-auth.ts#L297-L302)、[启动 token 以 root context 为键、跨 Connection 重载保留](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.2-rc.1/packages/client/connection/src/browser-auth.ts#L202-L209)、[token URL 的 stdout 打印](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.2-rc.1/packages/bundle/web-app/src/index.ts#L271-L284)、[进程唯一启动 token 的惰性生成](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.2-rc.1/packages/client/connection/src/browser-auth.ts#L52-L58)与[`?token=` 的常数时间相等比较](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.2-rc.1/packages/client/connection/src/browser-auth.ts#L100-L104)、[patch 按 id 整段替换 config](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.2-rc.1/docs/architecture.md#L27)与[web bundle 的 `connection` 行](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.2-rc.1/packages/bundle/web-app/cordis.patch.yml#L162-L169)、[applyEntryPatches 对 insert 与 id 覆盖的分流](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.2-rc.1/vendor/include/src/index.ts#L57-L123)、[`duplicate loader entry id`](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.2-rc.1/vendor/loader/src/config/group.ts#L59-L64)、[dump 与 boot 共用 `applyEntryPatches`](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.2-rc.1/packages/boot/app-boot/src/index.ts#L363-L371)。决策记录：[浏览器令牌认证](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.2-alpha.5/.agents/notes/implemented/architecture/2026-08-24-browser-token-authentication.zh.md)、[浏览器请求信任](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.2-alpha.5/.agents/notes/implemented/architecture/2026-07-28-api-browser-trust-boundary.zh.md)。

### <a id="remote-access-methods"></a>远程接入 DSH Web 的方式

远程接入可以由不同层的方法独立完成或按需组合。SSH 本地隧道与受控 TCP relay 在本节展开，反向代理的配置见下一小节。

| 方法 | 建立的路径 | 主要职责 |
|---|---|---|
| SSH 本地隧道 | 浏览器本机 `127.0.0.1:3080` → 服务主机 `127.0.0.1:3080` | 为单个操作者提供临时的端到端 loopback 入口 |
| `socat`、Windows `portproxy` 或 SSH 端口转发 | 受控私网地址 → DSH loopback | 在主机、网络 namespace 或节点之间提供 TCP 接力；绑定地址与来源 ACL 定义可达范围 |
| 反向代理（以 Caddy 为例） | 稳定域名 → 私有上游 | 提供 TLS、身份认证、域名路由，以及按部署模式设置上游 `Host` / `Origin` |

#### <a id="ssh-tunnel"></a>SSH 本地隧道

SSH 本地隧道让远端浏览器通过自己的 loopback authority 访问 DSH：

```sh
ssh -N -L 3080:127.0.0.1:3080 <host>
```

浏览器访问 `http://127.0.0.1:3080`。API 请求携带 loopback `Host` 与 `Origin`，通过信任校验；会话校验仍要完成——把当前启动 token 放到本地转发地址的 `/?token=...` 打开一次，之后凭 cookie 继续使用。如果本地端口改成 13080，就在 `http://127.0.0.1:13080/` 下兑换；cookie 绑定浏览器所用的本地 authority，不能照抄远端监听端口。

#### <a id="tcp-relay"></a>受控 TCP relay

当反向代理与 DSH 分处不同节点或网络 namespace 时，可以先用受控 TCP relay 提供私有上游。例如：

```sh
socat TCP-LISTEN:<relay-port>,bind=<private-address>,fork,reuseaddr TCP:127.0.0.1:3080
```

该 relay 的绑定地址、主机防火墙和来源 ACL 可以只覆盖反向代理节点；上层域名、TLS、认证和 HTTP header 处理继续由反向代理承担。

#### <a id="caddy-public-entry"></a>反向代理公网入口

本节以 Caddy 为例说明 DSH 的 Host / Origin 适配、会话兑换与验证要求。示例的 `authorize with <policy>` 依赖已安装并配置好的 caddy-security policy；它是整个站点的外部门禁。讨论放行或拒绝时，均以 **DSH 实际收到的 authority** 为准，而不是以代理连接了哪个 IP 和端口为准：

| 用语 | 示例 | 指什么 |
|---|---|---|
| 公网域名及端口（公网 authority） | `dsh.example.com`、`dsh.example.com:8443` | 浏览器地址栏所访问的域名及可选非默认端口 |
| 代理上游连接地址 | `127.0.0.1:3080`、`10.x.x.x:13080` | 代理在网络层实际连接的 DSH 或 relay 地址 |
| DSH 收到的 authority | `Host` 与 `Origin` 中最终送到 DSH 的 `host[:port]` | DSH 执行 Host / Origin 校验时真正读取的值 |

后两者不是一回事。例如反向代理可以实际连接 `10.x.x.x:13080`，同时把 DSH 收到的 `Host` 与 `Origin` 改成 `127.0.0.1:3080`。

反向代理公网入口包含四个组成部分：

1. **私有 DSH 上游。** DSH 继续监听 `127.0.0.1:3080`；代理同机时直接访问该地址，跨节点时通过[受控 TCP relay](#tcp-relay) 到达，并用绑定地址、防火墙或来源 ACL 把 relay 限给网关。
2. **TLS 与用户认证。** 代理负责 TLS 终止和面向互联网的用户认证；DSH 的 Host / Origin fence 负责 DNS rebinding 与同源校验，浏览器会话认证独立于代理生效——远端浏览器仍要持有效会话：由使用者完成一次 token 交换，或由代理统一兑换并代持（见下文代持段）。
3. **完整的 HTTP 与 WebSocket 代理。** 同一条代理 route 覆盖整个 DSH 站点，并由代理处理 WebSocket upgrade。
4. **自洽的 Host / Origin。** DSH 读取实际收到的 `Host` 与 `Origin`。部署可以保留公网域名及端口并配置匹配的 `--trusted-host`，也可以把两者成对改成同一个 loopback 域名/IP及端口；`X-Forwarded-Host` 继续承担转发元数据记录。

以下示例用 `authorize with <policy>` 表示已经安装并生效的认证模块与策略。部署时将它替换为实际使用的 `authorize`、`basic_auth`、`forward_auth` 或其他认证配置。

**保留公网 Host / Origin。** 假设浏览器访问 `https://dsh.example.com`，其公网 authority 是 `dsh.example.com`。DSH 启动时声明同一个裸 `host[:port]`；标准 HTTPS 端口 443 由 URL 规范化省略。带端口的 `--trusted-host host:port` 精确匹配；不带端口的 `--trusted-host host` 允许该 hostname 的任意端口：

```sh
dsh web --no-open --trusted-host dsh.example.com
# 公网地址为 https://dsh.example.com:8443 时：
# dsh web --no-open --trusted-host dsh.example.com:8443
```

`--trusted-host` 使用裸 `host[:port]` 格式。对普通 HTTP 上游，Caddy 默认透传浏览器的 `Host` 和其他请求 headers；这一路径保持公网 `Host` 与同源公网 `Origin` 原值：

```caddyfile
https://dsh.example.com {
	authorize with <policy>
	reverse_proxy <private-upstream>:3080
}
```

这里的 `<private-upstream>:3080` 是反向代理的连接地址。DSH 的信任判断使用实际收到的 `Host: dsh.example.com` 和 `Origin: https://dsh.example.com`；匹配的 `--trusted-host dsh.example.com` 让信任校验放行，此后的会话、事件流、普通 API 与 WebSocket 能否使用取决于浏览器会话（见[浏览器请求的准入校验](#browser-session-auth)和[浏览器会话凭据的生命周期](#browser-session-lifecycle)）。

**改写为 loopback Host / Origin。** 当前官方推荐保留公网 Host；以下保留为旧部署兼容方式。反向代理完成强认证后，可以把 DSH 实际收到的 `Host` 与 `Origin` 成对改为相同的 loopback 域名/IP及端口。DSH 在这一路径中直接使用 loopback 校验，无需把公网域名加入 `--trusted-host`：

```caddyfile
https://dsh.example.com {
	authorize with <policy>
	reverse_proxy <private-upstream>:3080 {
		header_up Host 127.0.0.1:3080
		header_up Origin http://127.0.0.1:3080
	}
}
```

Caddy 仍可实际连接任意受控的 `<private-upstream>:3080`；DSH 收到的是 `Host: 127.0.0.1:3080` 与 `Origin: http://127.0.0.1:3080`。这两条 `header_up` 作用于普通请求和由同一 `reverse_proxy` 处理的 WebSocket upgrade；信任校验的判定顺序见[浏览器请求的准入校验](#browser-session-auth)。

成对改写为 loopback 只影响信任校验。会话 cookie 的名称与签名 payload 绑定 DSH 实际收到的 authority；代理一致地改写 authority 时，token 交换与 cookie 回传也按改写后的 authority 进行——这条组合路径未在本库做过端到端实测，部署前应先验证。此路径的安全边界由代理强认证、覆盖完整站点的 route 和私有上游共同构成。

**Caddy 代持会话 cookie。** 会话由浏览器各自持有还是由代理统一代持，与上面的 Host / Origin 选择是两个问题。下面的代持实例保留公网 `Host` / `Origin`，声明匹配的 `--trusted-host`，公网用户不接触 DSH 的启动 token，页面的 `isLoopback` 判定也不受影响。

兑换按「代理最终向 DSH 呈现的 authority」进行；本例是公网 `host[:port]`（HTTPS 默认端口不写）。用 `127.0.0.1:<port>` 兑换得到的 cookie 绑定的是回环 authority，与本例公网 Host 对不上。先按[启动 token 的转交与 journal](#launch-token-journal)把当前 token 读入 `DSH_LAUNCH_TOKEN`，再在同一 Bash shell 中以公网 Host 兑换。根路径兑换不经过 API 信任栅栏，因此兑换成功不能证明 API 已可用；后续 API/WebSocket 仍须有匹配的 `--trusted-host`：

```bash
(
set -euo pipefail
set +x
umask 077
cookie_jar="$(mktemp "${PRIVATE_WORK_DIR:?先选择已创建的私有工作目录}/dsh-cookie.XXXXXX")"
status="$(printf 'url = "http://127.0.0.1:3080/?token=%s"\n' "${DSH_LAUNCH_TOKEN:?先取得当前启动 token}" |
  curl --disable --noproxy '*' --fail --silent --show-error --max-time 10 \
    --config - --header 'Host: dsh.example.com' \
    --cookie-jar "$cookie_jar" --output /dev/null --write-out '%{http_code}')"
test "$status" = 303
printf 'HTTP %s；会话保存在 %s\n' "$status" "$cookie_jar"
)
unset DSH_LAUNCH_TOKEN
```

命令通过标准输入传递带 token 的 URL，不把凭据放进 curl 参数或打印响应头；cookie 保存在新建的 `0600` 文件中。仅在确认输出 `HTTP 303` 后使用该文件，完成凭据转存后按敏感文件流程处理临时文件；不要把内容贴进聊天或普通日志。当前版本兑换响应应为 `303`、`Location: ./`，签发的 cookie 名为 `dsh-auth-<hash>`，值为 `v1.` 起的整段；名称按该 authority 决定。兑换只认启动 token，把 `.credentials.yaml` 里的签名密钥当作 query token 会得到 401。

代理侧要同时使用这枚 cookie 的实际名称和完整值。例如将完整值保存在 Caddy 进程的私有环境变量 `DSH_BROWSER_COOKIE` 中，替换下面的 `<actual-cookie-name>`：

```caddyfile
https://dsh.example.com {
    authorize with <policy>
    reverse_proxy <private-upstream>:3080 {
        header_up Cookie "<actual-cookie-name>={$DSH_BROWSER_COOKIE}"
        header_down -Set-Cookie
    }
}
```

`header_up Cookie` 覆盖整段浏览器 Cookie，对普通请求和 WebSocket upgrade 都生效；入口登录 cookie 留在代理这一层。`header_down -Set-Cookie` 剥离上游全部 cookie，适用于已核对 DSH 无其他依赖 cookie 的功能时。Cookie 名和值都来自实际兑换，不能只替换值而沿用别的 authority 的名称。

私有环境文件只让运维与 Caddy 服务身份读取，例如通过 systemd `EnvironmentFile=` 载入；不要把 cookie 写进仓库。Caddy 的 `{$DSH_BROWSER_COOKIE}` 在配置适配时展开，校验和 reload 进程也必须获得同一环境；从未载入该文件的普通终端直接 reload 会把变量展开为空。替换 cookie 后，以服务约定的同一私有环境校验并重载，再验证实际公网入口。

> 本节所引版本的 DSH 只有 token 兑换会设置 cookie；采用剥离上游 `Set-Cookie` 的代持方式时，升级后应复核这一前提。

片段与命令中的 `3080` 是默认端口；`--port` 改变监听端口时，兑换命令与上游地址要同步调整，公网使用非默认端口时的 authority 也要换成实际值。把用户重定向到 `/?token=…` 的自动兑换做法会让 token 进入浏览器历史与访问日志，也与 DSH 兑换后清空 query 的行为相抵触；上面的本机兑换命令只避免终端回显与进程参数泄露，不会替请求经过的服务禁用日志。

代持不改变[浏览器会话凭据的生命周期](#browser-session-lifecycle)：正常访问不续期，进程重启与热重载对启动 token、会话 cookie 的不同影响，以及 cookie 到期、寿命配置或签名密钥变更后的处置，均按该节判断。需要更新会话时由运维重新兑换，再按代理所选方案更新代持凭据。代理侧还需单独留意：**若域名、端口或 Host 改写的变更使 DSH 实际收到的 authority 改变，cookie 名与已签发会话就会失配**，须按新的 authority 重新兑换，同时更新代理持有的 cookie 名和值。

> 🔬 2026-09-03 本机实测：systemd 托管 dsh、Caddy 公网入口的部署按此模式运行（GitHub 认证 + `header_up Cookie` 注入 + `header_down -Set-Cookie` 剥离，保留公网 Host）；公网过认证后直接进入 DSH，本机直连不带会话 cookie 时返回 401、带注入的会话 cookie 时返回 200，浏览器不产生 DSH cookie。

代持解决的是进入 DSH 这一层的认证；浏览器端的限制不随代持改变；未安装本插件时，远程页面仍无法持久读写 Settings 系页面（见[远程页面的浏览器端限制](#client-isloopback)）。

使用 nginx 等其他反向代理时，仍须满足本节的 Host / Origin 一致性、私有上游和完整 HTTP / WebSocket 覆盖要求，并按所选代理核对 TLS、入口认证和 cookie 处理。

`--trusted-host` 提供 DNS rebinding 与跨站请求防护，反向代理提供 TLS 与面向互联网的用户认证，浏览器会话认证决定谁能操作 Host；三层各守自己的边界。

> 来源：[token 兑换入口与 303/Set-Cookie](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-alpha.1/packages/client/connection/src/browser-auth.ts#L238-L279)、[authority 取自请求 Host](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.2-rc.1/packages/client/connection/src/browser-auth.ts#L69-L78)、[cookie 名由 authority 哈希得出](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.2-rc.1/packages/client/connection/src/browser-auth.ts#L106-L108)、[`?token=` 只与启动 token 做常数时间比较](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.2-rc.1/packages/client/connection/src/browser-auth.ts#L100-L104)、[401 响应](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.2-rc.1/packages/client/connection/src/browser-auth.ts#L304-L312)；[Caddy `reverse_proxy` 的 header 默认值与 WebSocket 支持](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)。

### <a id="client-isloopback"></a>远程页面的浏览器端限制

本节说明浏览器端从页面地址派生的 `isLoopback` 判定，以及它对 Settings 系页面的影响。Host 侧的方法可用性由会话认证统一决定（见[浏览器请求的准入校验](#browser-session-auth)）；本节的限制发生在浏览器自己的代码里，相关 settings 镜像请求在客户端短路。本插件将镜像持久化选择改为 `host`，其请求仍必须通过官方 RPC 信任与会话认证。

浏览器 Client 从页面 hostname 派生 `isLoopback`：页面环境不存在、传输层自持 Host，或 `location.hostname` 是 `localhost`、`127/8`、`[::1]` 之一时为 true。它不只用于页面状态展示：`ui-settings` 用它决定 settings 镜像（`settings.describe` 的共享快照）的 persistence——loopback 页面为 `host`，远程页面为 `memory`；`memory` 在构造时即进入终态 `unavailable`，`load()` 与 `ensure()` 双双短路，连接重置也不会触发补读。Settings 系页面共享这面镜像，远程页面各自降级：

| 页面 | 远程页面（`isLoopback` 为 false）的表现 |
|---|---|
| Models | 加载即报错「加载提供方目录失败: settings are unavailable in this browser」；provider 列表 RPC 本身未被拦，失败的是页面依赖的 settings 视图 |
| General | 进入 `unavailable` 状态 |
| Plugins | 命名空间不可用的卡片不渲染 |
| Permission presets | 整段不显示 |

截至 `dsh-v0.2.1-alpha.1`，这道客户端门禁仍没有随 Host 层统一会话一起拆除：`0.1.1-rc.2` 时代镜像注释写明缘由是「settings RPCs are loopback-only」；`0.1.2` 起注释改为「non-loopback pages may remain process-local」，措辞更新、行为未变。因此未安装本插件的公网页面即便持有效会话也无法持久读写这些设置；需要完整设置能力时可安装本插件，或通过 [SSH 本地隧道](#ssh-tunnel) 让页面落在 loopback 地址（`0.1.2` 系还需先完成一次 token 兑换）。

| 接入方式 | 浏览器端的 `isLoopback` | Settings 系页面 |
|---|---|---|
| SSH 本地隧道，从 `http://127.0.0.1:3080` 打开 | `true` | 可用；`0.1.2` 系先过一次 token 兑换 |
| 反向代理保留公网 Host / Origin | `false` | 按上表降级；会话有效也一样 |
| 反向代理改写为 loopback Host / Origin 或代持 cookie | `false` | 改写与代持只影响 Host 收到的请求；页面仍按地址栏公网域名判定，同样降级 |

> 历史实测（2026-09-03）：`0.1.2-alpha.5` 本机安装树的前端产物中确认 persistence 接线、终态短路与四个页面的降级路径；「加载提供方目录失败: settings are unavailable in this browser」与一份公网部署的用户报告逐字一致。

> 来源：[Client 从页面 hostname 派生 `isLoopback`](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.2-rc.1/packages/client/connection/src/client/index.ts#L228)、[镜像 persistence 由 `isLoopback` 决定](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.2-rc.1/packages/client/ui-settings/src/client/index.ts#L58-L59)、[构造器按 persistence 初始化终态 `unavailable`](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.2-rc.1/packages/client/ui-settings/src/client/settings-mirror.ts#L86-L89)、[`load()` 在 `memory` 下短路](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.2-rc.1/packages/client/ui-settings/src/client/settings-mirror.ts#L115)与[`ensure()` 短路](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.2-rc.1/packages/client/ui-settings/src/client/settings-mirror.ts#L133)、[「terminal non-loopback state」状态注释](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.2-rc.1/packages/client/ui-settings/src/client/settings-mirror.ts#L29-L33)、[Models 页兜底文案](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.2-rc.1/packages/client/ui-settings-models/src/client/store.ts#L190)、[rc.2 注释「settings RPCs are loopback-only」](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.1-rc.2/packages/client/ui-settings/src/client/settings-mirror.ts#L82)与[rc.1 同位置注释](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.2-rc.1/packages/client/ui-settings/src/client/settings-mirror.ts#L82)。

### <a id="loopback-privilege-history"></a>旧版本的 loopback 特权

本节记录 `0.1.1-rc.2` 及更早版本的访问控制差异，供核对旧部署或旧文档时对照。

这些版本没有会话认证：通用校验之后，Settings 读写（`settings.describe` 等读写方法）、Credentials（`credentials.describe/set/unset`）、Agent preset 管理（`agentPreset.read/copy/openDocument/remove`）、宿主文件操作（`host.pickDirectory`、`host.openPath`）、端点探测（`llm.discoverModels`）这组本机管理方法再以空 `trustedHosts` 调用 `isTrustedApiRequest()`，构成只接受 loopback Host / Origin 的第二层。于是 `--trusted-host` 公网路径上这些方法返回 403；反向代理强认证后把 `Host` / `Origin` 成对改写为 loopback 就能让它们通过——loopback 本身即特权，无需任何会话。统一浏览器会话认证在 `0.1.2-alpha.1` 取代了这一层：伪造 loopback `Host` 不再带来任何特权，按方法区分的这层名单随之失效。

> 来源：[旧版本机管理方法清单与空 trust list 二层校验](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/client/connection/src/index.ts#L69-L154)、[对应的 Host / Origin 行为测试](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/client/connection/tests/api-request-trust.host.spec.ts#L19-L68)；现行统一会话模型的来源见[浏览器请求的准入校验](#browser-session-auth)。


## <a id="file-compatibility"></a>文件兼容与诊断

### <a id="resource-url-compatibility"></a>资源 URL 解析

官方 `protocolOf()` 使用 `new URL(address).hostname` 为 `dsh-resource://file/…` 选择 provider。某些浏览器的非标准 scheme 解析给出空 hostname，就会显示“文件资源服务不可用”。本仓旧版按启动探测结果替换全局 `window.URL`；当前代码只在资源客户端自己的解析边界兜底，保留原生 URL 和它的静态方法。

客户端启动时探测原生行为：正常为 `not-needed`，需兼容时为 `enabled`，异常为 `failed`。插件停用由 Cordis 清理 resolver 与诊断入口，状态可记录为 `disposed`。正常浏览器沿用原生解析；只在非标准资源 scheme 的解析缺失时使用受约束的局部解析。它不把普通网站 URL 改写为文件地址，也不向后端增加文件权限。

> 实现：[客户端 helper](lib/client.js)、[资源客户端副本](vendor/resources/lib/client.js)。新增副本是因为官方资源服务没有公开 `protocolOf` 替换入口；相比全局改写，它把兼容影响限定在资源系统，但增加了一份需要跟踪上游的客户端。

### <a id="file-watch-ack"></a>文件订阅确认与首帧

官方客户端先等待 `workspaceFiles.changes` 的订阅确认，才请求 `stat`。代理或连接异常导致确认迟迟不来时，文件预览可以一直停在加载状态。

当前补丁保留原订阅：正常及时确认时按官方流程显示文件；等待超过预算时先读取一次 `stat` 显示文件，继续等待确认。确认晚到后再读取一次以覆盖等待期间的变化，然后恢复实时更新。订阅永不确认时，初次读取仍可显示文件，但此时没有实时更新；关闭预览或取消操作会结束等待并释放订阅。这个补丁不修复代理或连接本身。

等待预算从 Host 配置注入页面，默认 800 毫秒，可在 Profile patch 覆盖本插件条目：

```yaml
- id: dsh-public-web
  config:
    hosts: [] # 由官方 --trusted-host 管理时保持为空
    watchAckTimeoutMs: 800
```

`watchAckTimeoutMs` 必须是 1–60000 的整数；Host 对非法值报错。这里的预算仅决定何时先显示文件，不限制整个文件请求或订阅寿命。修改后重新加载页面以取得新的页面注入配置。

> 实现：[工作区文件客户端副本](vendor/workspace-files/lib/client.js)、[等待与清理 helper](lib/client.js)、[Host 页面配置注入](lib/index.js)。

### <a id="diagnostics"></a>浏览器诊断与证据范围

在 DSH 页面开发者工具的 Console 中执行：

```js
window.__dshPublicWebDiagnostics()
```

结果包含 `urlCompat`、`counters` 和 `events`。`urlCompat: "not-needed"` 表示当前浏览器无需 URL 兼容；`enabled` 表示检测到解析缺失。`url-fallback` 计数说明资源地址确实经过了兜底，仅 `enabled` 本身不证明用户打开过受影响文件。

文件计数的关键关系：

| 事件 | 含义 |
|---|---|
| `watch-ack-on-time` | 订阅在预算内确认，走正常流程 |
| `watch-ack-timeout` | 超过预算，先显示一次文件 |
| `watch-ack-late` | 降级后确认到达，重新读取并恢复实时更新 |
| `watch-ended-before-ack` | 订阅在确认前结束 |
| `watch-aborted` / `watch-closed` | 用户取消或流清理 |

计数每项最多 65535，最近事件最多保留 20 条。事件只含类别、时间和有上限的耗时，不保存路径、session ID、内容、token 或 cookie。同类兼容警告在页面内只输出一次。这些诊断只保存在当前浏览器页面，不写回 Host，不新增 HTTP 路由，也不能代替后端安全审计。

历史服务日志不足以证明这些补丁触发过：2026-10-03 检查作者 timidly 的 journal，保留范围为 9 月 15 日至 10 月 3 日，排除 sudo 命令审计后，未找到 URL 兼容或文件确认降级记录。旧代码本来就没有记录触发；不能由“没有日志”推断“没有问题”。新诊断可用于判断是否需要保留补丁，以及默认预算是否适合实际连接。持续超时时继续检查 HTTP RPC 与 WebSocket/流请求的代理路径；mobile-gateway 控制流错误属于另一条接入链路，不能当作这里的文件兜底证据。

## <a id="security-boundaries"></a>安全边界

本插件允许已经进入 DSH 的远程浏览器使用 Host 设置能力，增加的是远程管理可用性。它不提供公网登录，也不把 DSH 变成多租户系统。

| 边界 | 负责的层 | 本插件的影响 |
|---|---|---|
| 外部 TLS 与登录门禁 | Caddy、caddy-security 或其他入口代理 | 完整覆盖页面、API、插件路由和 WebSocket；本插件依赖部署者维持这层 |
| DNS rebinding / 跨站请求 | 官方 Host/Origin/`Sec-Fetch-Site` 栅栏 | 官方 `--trusted-host` 是主要入口；可选 `hosts` 兼容旧部署 |
| 浏览器操作 Host 的身份 | DSH 启动 token 与签名 cookie | 本插件不跳过、不伪造认证；代理代持时由代理替用户持有这层会话 |
| 公网设置持久化 | 浏览器 Settings 镜像 | 将 `memory` 改为 `host`，允许设置和凭据管理请求真正到达官方后端 |
| 文件可读范围 | 官方文件系统能力与 DSH 运行用户的 OS 权限 | 补丁沿用官方读取；目录列表限制不等于文件读取必须在 workspace 内 |
| 第三方插件自身路由与代码 | 插件作者与部署审查 | 自注册路由不自动继承官方 API 栅栏；Host 插件有进程用户权限 |

**作者的本机部署由 Caddy 门禁保护。** 在这个条件下，保留远程设置能力是合理的部署取舍：把获准进入门禁的人视为能够操作该 DSH 用户账户的操作者。Caddy 身份不会自动变成 DSH 内部逐人 ACL；同一实例的浏览器会话按 operator 权限处理。需要不同用户或权限的数据隔离时，应使用不同 OS 用户/DSH 实例并分别配置入口门禁。

上游监听端口或私网 relay 只应对可信代理与管理网络可达；否则会绕过 Caddy 门禁。代理改写 loopback Host/Origin 或统一注入 cookie 时尤其依赖这个条件。保持 TLS，保护 journal、启动 token、cookie 文件和 `$DSH_HOME/.credentials.yaml`。静态官方客户端公开与 Host 操作权限是不同边界：静态资源可加载不代表通过 RPC 认证。

官方 `workspaceFiles` 的 regular file 读取允许 workspace 外路径，沿部署的 filesystem read 权限执行；本插件不会把这个范围收窄。Agent 工具沙箱和审批也不约束 Host 插件直接执行的代码。把“预览”当成只读工作区沙箱是不准确的。

> 来源：[当前 RPC operator 与准入校验](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-alpha.1/packages/client/connection/src/rpc-host.ts#L96-L117)、[文件服务读取范围](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-alpha.1/packages/api/workspace-files/src/index.ts#L1-L14)、[浏览器 cookie 和身份边界](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-alpha.1/packages/client/connection/README.zh.md#L37-L43)、[官方根路径认证调用](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-alpha.1/packages/host/frontend-static/src/index.ts#L131-L136)。

## <a id="install"></a>安装、升级和卸载

### 安装与配置

使用本插件前先完成 Caddy/TLS/入口门禁与私有上游配置。只需要远程聊天、官方文件客户端在目标浏览器也正常时，可以直接使用官方 DSH；需要公网完整设置能力或已复现文件兼容问题时再安装。

本仓是私有、预构建的本地包。Host 转发入口通过当前 `dsh` executable 定位官方安装包；只支持实际 `dsh` profile 启动方式。将本仓打包到新建的任务产物目录，避免把历史 tarball 当成当前源码：

```sh
npm pack --pack-destination <private-package-directory>
dsh plugin --profile web add <private-package-directory>/dsh-public-web-0.1.3.tgz
```

重启目标 profile 的 DSH 服务，然后完整刷新浏览器页面。旧版没有撤销全局 URL 包装的 cleanup，单纯热重载无法保证移除旧页面中的包装；完整刷新才会重新取得浏览器原生 URL。仓库提交不会自动更新已安装 tarball 或正在运行的服务。当前改进仍保留 `0.1.3`，没有创建新 tag 或发布新版本；用相同版本替换代码也需要明确重装和重启。

官方 `--trusted-host` 优先管理当前部署的公网主机，本仓默认 `hosts: []`。旧部署也可继续用插件条目声明自己的裸 `host[:port]`：

```yaml
- id: dsh-public-web
  config:
    hosts:
      - dsh.example.com
    watchAckTimeoutMs: 800
```

Profile 的 `config` 整段替换，所以按实际部署保留所需字段。公网根参数配置在 `dsh web` 启动命令或 systemd `ExecStart` 中，不写到本插件的 `hosts`。该插件只用于 Web profile，没有自己的设置页。

### 官方包与客户端副本

[cordis.patch.yml](cordis.patch.yml) 禁用官方 `resources`、`ui-settings`、`workspace-files` 条目，插入本仓对应的 `*-public` 条目；原 specifier 是覆盖 guard，官方拓扑变化时必须重新核对。替换后的 Host 入口仍通过 [lib/official.js](lib/official.js) 加载当前 DSH 的官方 package，浏览器客户端则由本仓提供修改后的副本。

| 副本 | 上游来源 | 本仓修改 |
|---|---|---|
| `vendor/ui-settings` | DSH `0.1.7-rc.2` | Settings persistence 选择 `host` |
| `vendor/workspace-files` | DSH `0.1.7-rc.2` | 订阅确认等待与诊断 |
| `vendor/resources` | DSH `0.2.1-alpha.1` | 局部资源协议解析兼容 |

这意味着插件可以沿用当前官方 Host，而客户端接口仍受副本来源限制。DSH 更新后，优先比较以上包的 upstream source、client module id、依赖清单与 bundle row id；有变化时基于新客户端重做小补丁，而不是继续覆盖旧整包。打包文件应保留上游许可；插件的 metadata/locale exports 供官方插件页读取。

### 验证与维护

本仓使用 Node 自带测试 runner，运行 `npm test`。测试覆盖正常订阅、超时首帧、迟到确认后自动更新、取消与清理、原生和兼容 URL 解析及实际客户端注册；不需要真实模型请求。

部署验收还需要使用目标浏览器：通过实际公网入口登录，检查 Models/General 设置能够读取和保存；打开一个文件，改变该文件，确认预览自动更新；查看诊断计数区分正常确认与降级恢复；关闭预览再打开，确认没有残留订阅。代理路由、实际浏览器兼容和账户权限不能由 helper 单元测试替代。

升级 DSH 前备份实际 `$DSH_HOME`，核对 release/upgrade guide 和 Session 格式。升级会重建官方安装树：单独加在该树中的 pi-ai `overrides` 可能被覆盖，应重新检查依赖树和模型目录，再启动服务；这与本插件安装在 Web profile 中的副本是两项维护工作。pi-ai `0.99.1` 的入口 `models.generated.js` 导入 provider JSON，查模型应使用实际目录接口或 `dist/providers/data/openai-codex.json`，不能只搜索入口文件。

### 卸载

```sh
dsh plugin --profile web remove dsh-public-web
```

重启目标 profile 并刷新页面，确认最终合成配置不再含本仓 `*-public` 替换。官方客户端恢复；如果 systemd 仍保留正确的 `--trusted-host`、代理和会话，公网仍可访问。公网设置恢复官方的客户端限制，文件兼容与诊断也随插件移除。卸载插件不删除 DSH 会话、配置或凭据。
