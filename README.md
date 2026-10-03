# dsh-public-web

这个仓库补齐官方 DeepSeek Harness Web 在远程浏览器中的设置与文件预览能力，并维护直接访问官方 Web 的部署指南。浏览器通过公网 HTTPS 域名连接正在运行的 `dsh web`，设置、文件读取与会话继续使用官方后端。

截至 `dsh-v0.2.1-alpha.1`，官方已经具备公网主机放行、浏览器会话认证和公网地址公告。这个插件解决的是另外三个浏览器端问题：

- **远程设置。** 公网域名下的官方设置镜像进入不可用状态；插件让它读取、保存 Host 配置，因此 Models、General、Plugins 和权限预设可以正常使用。
- **文件资源地址。** 当浏览器无法正确解析 `dsh-resource://file/…` 时，插件在资源客户端内补上解析。
- **文件首次加载。** 文件变更订阅确认迟迟不来时，插件先读取文件供用户查看；确认到达后继续自动更新。

> 核对日期：2026-10-03。下文的官方行为按本地 `dsh-v0.2.1-alpha.1` 源码核实。安装与复用官方组件的方式见[安装与配置](#install)。

## <a id="contents"></a>阅读入口

- [DSH 与本仓的版本历史](#history)
- [Caddy 公网部署](#remote-access-methods)
- [官方参数：trusted-host 与 public-url](#public-url)
- [请求校验与浏览器会话](#web-trusted-host)
- [远程设置为何需要插件](#client-isloopback)
- [文件兼容与诊断](#file-compatibility)
- [安全边界](#security-boundaries)
- [安装、升级和卸载](#install)

## <a id="history"></a>DSH 与本仓的版本历史

以下记录与直接远程 Web 有关的变化。各版本完整发布记录见 [DSH releases](https://github.com/deepseek-ai/deepseek-harness/releases)。

| 版本或提交 | 相关变化 | 对远程 Web 的影响 |
|---|---|---|
| DSH `0.1.1-rc.2` 及更早 | 本机管理接口另有只接受 loopback 的校验；尚无统一浏览器会话 | 当时的反代教程常改写 Host/Origin，适用边界见[旧版本的 loopback 特权](#loopback-privilege-history) |
| DSH `0.1.2-alpha.1` | 启动 token 兑换签名 cookie；本机与远程请求统一认证 | 可信主机与有效会话成为两项独立条件 |
| DSH `0.1.2-alpha.2` | Settings 接入新 Remote namespace，继续按浏览器页面的 loopback 判定选择持久化方式 | 远程设置限制保留 |
| DSH `0.1.5-alpha.1` 起 | 引入资源 registry 与双面 workspace-files | 资源 provider 选择依赖 URL hostname，首次文件读取等待变更订阅确认 |
| DSH `0.1.7-alpha.1` 起 | API/插件资源使用相对文档目录；token 兑换重定向为 `./`；改进侧栏刷新和 watcher 生命周期 | 为带路径前缀的代理提供基础；远程设置及两个文件兼容问题仍保留 |
| DSH `0.1.7-rc.2` | 可信公网 Host 与有效会话可以使用官方 API | 远程页面的设置镜像仍选择 `memory` 并进入 `unavailable` |
| 本仓 [`3fde359`](https://github.com/TMYTiMidlY/dsh-public-web/commit/3fde359)，2026-09-29 | 加入远程 Host 设置、资源 URL 兼容与 800ms 文件读取兜底 | 当时附带客户端副本；文件超时后只显示一次，URL 兼容作用于全局 |
| 本仓 [`6b28476`](https://github.com/TMYTiMidlY/dsh-public-web/commit/6b28476)，2026-09-29 | 包名改为 `dsh-public-web`，版本保留 `0.1.3` | 旧 `dsh-public-*.tgz` 文件名属于历史产物 |
| DSH [`0.2.0-rc.1`](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.0-rc.1) | 改善插件管理、配置保存等待和 Office/PDF 预览 | 这些更新改善了日常使用；远程设置判定和订阅确认等待的实现延续 |
| DSH [`0.2.0-rc.2`](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.0-rc.2) | 改善设置预设、文件夹本地打开与模型选择 | 打开本机文件夹与浏览器文件预览属于不同路径；本仓针对的客户端行为延续 |
| DSH [`0.2.1-alpha.1`](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.1-alpha.1) | 新增 `--public-url`，改善 Markdown frontmatter 与插件依赖管理 | 公网地址公告使用官方能力；设置与文件兼容仍由本仓补齐 |
| 本仓当前代码，2026-10-04 | 直接复用已安装的官方组件，按需施加局部补丁；文件确认晚到后继续更新；增加配置和诊断 | 插件包只维护兼容逻辑，官方组件随 DSH 安装更新 |

相关实现可核对：[当前设置持久化选择](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-alpha.1/packages/client/ui-settings/src/client/index.ts)、[当前文件订阅等待](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-alpha.1/packages/api/workspace-files/src/client/provider.ts)、[当前资源协议解析](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-alpha.1/packages/client/resources/src/client/resources.ts)。历史接线见[相对目录与前缀反代](https://github.com/deepseek-ai/deepseek-harness/commit/eeb9b03465)、[侧栏刷新](https://github.com/deepseek-ai/deepseek-harness/commit/c71e907490)和[watcher 生命周期](https://github.com/deepseek-ai/deepseek-harness/commit/4f55590aea)。

### <a id="loopback-privilege-history"></a>旧版本的 loopback 特权

`0.1.1-rc.2` 及更早版本的 Settings、Credentials、Agent preset、宿主文件管理与模型发现接口还要求 loopback Host/Origin。旧部署把两者成对改写到 loopback，是为了通过那时的本机管理限制。`0.1.2-alpha.1` 引入统一会话后，这组接口也按会话认证处理。当前部署按[官方反代指南](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-alpha.1/docs/user/guide/public-deployments.zh.md)保留公网 Host，并声明匹配的可信主机。

历史依据：[旧版本机管理接口校验](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/client/connection/src/index.ts#L69-L154)、[`0.1.2-alpha.1` 浏览器认证](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.2-alpha.1/packages/client/connection/src/browser-auth.ts)。

## <a id="remote-access-methods"></a>直接远程访问官方 Web

长期使用的路径是：

```text
浏览器 https://dsh.example.com/
  → Caddy：TLS 与用户登录门禁
  → 私有 HTTP 上游 127.0.0.1:3080
  → 官方 DSH Web：可信主机校验与会话认证
```

同机 Caddy 直接连接 DSH 的 loopback 端口。跨节点时，把 Caddy 到 DSH 的那一段放在受控私网或隧道内。SSH 本地转发可用于临时管理；TCP relay 只是跨节点连接的组成部分。公网部署先按下面的 Caddy 路径配置。

### <a id="caddy-public-entry"></a>Caddy 公网部署

这里采用已有 Caddy 登录门禁、由 Caddy 代持 DSH 会话的部署方式。公网用户通过门禁后直接使用 DSH；Caddy 向上游附带有效会话 cookie。

1. **启动私有 DSH 上游。** 例中使用默认端口 `3080`；systemd 的 `ExecStart` 也使用同样参数：

   ```sh
   dsh web --no-open --port 3080 --trusted-host dsh.example.com
   ```

   希望启动输出与 Agent 得知的地址也是公网根时，加上 `--public-url https://dsh.example.com/`，详见[公告地址](#public-url)。

2. **按公网 Host 兑换 DSH 会话。** 先从当前进程启动输出取得 token，再按[会话兑换](#launch-token-journal)生成 cookie。例中的兑换请求虽然连接 `127.0.0.1:3080`，仍发送 `Host: dsh.example.com`，使会话与后续代理请求一致。

3. **让 Caddy 注入会话。** `authorize with <policy>` 表示已经配置好的 caddy-security 访问策略。将实际 cookie 名与完整值保存到服务的私有环境文件，下面用 `DSH_BROWSER_COOKIE` 表示值：

   ```caddyfile
   dsh.example.com {
       authorize with <policy>
       reverse_proxy 127.0.0.1:3080 {
           header_up Cookie "<actual-cookie-name>={$DSH_BROWSER_COOKIE}"
           header_down -Set-Cookie
       }
   }
   ```

   对这个 HTTP 上游，Caddy 保留浏览器的公网 `Host` 与同源 `Origin`，并处理 WebSocket 升级。`header_up Cookie` 覆盖发往上游的 Cookie，登录门禁的 cookie 留在 Caddy 这一层；`header_down -Set-Cookie` 将 DSH 的 cookie 留给代理代持。实际 cookie 名与值均从兑换结果取得。

4. **应用配置并验收。** 以 Caddy 服务约定的私有环境执行配置校验和 reload，随后从实际公网域名登录，验证页面、设置、HTTP API 与 WebSocket。门禁应覆盖整个站点，上游端口只供可信代理和管理入口访问。

`{$DSH_BROWSER_COOKIE}` 在 Caddyfile 适配时从执行适配的进程环境取值。用 systemd `EnvironmentFile=` 管理时，执行 `caddy validate` / `reload` 的进程也须取得同一环境。若实际 `ExecReload` 会启动继承该文件的适配进程，更新文件后可以 reload；使用运行期 `{env.*}` 时，常驻进程的环境通常需要 restart 才更新。通用配置方法见 [Caddy 服务凭据与环境变量](https://github.com/TMYTiMidlY/skills/blob/main/skills/.curated/network/references/caddy.md#service-environment)。

会话过期、签名密钥撤销或公网 Host/端口变化时，按新的实际 authority 重新兑换，并更新代理持有的名称和值。正常页面访问沿用现有 cookie 的期限。

也可以让每个浏览器自行兑换和保存 DSH 会话：Caddy 保留原请求 Cookie，部署者给获准用户转交当前启动 URL；HTTPS 入口须为后端 cookie 添加 `Secure`。这是相同的官方认证能力，区别在于凭据由浏览器还是由代理持有。

> 历史实测：2026-09-03 本机的 Caddy 门禁、保留公网 Host、cookie 注入与剥离组合已验证：公网登录后可直接进入 DSH；同一上游不带会话为 401、带正确会话为 200。本文示例仍须按实际域名、端口与策略替换。

Caddy 的转发行为见 [reverse_proxy 官方文档](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)；DSH 的入口要求见[官方公网部署指南](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-alpha.1/docs/user/guide/public-deployments.zh.md)。

### 挂载到路径前缀

根域名入口最直接。如果入口是 `https://dsh.example.com/ui/`，代理需剥离 `/ui/` 再转发，裸 `/ui` 重定向到 `/ui/`，所有页面请求和 WebSocket 也经过同一挂载。浏览器自行持有 DSH cookie 时，还需把上游 `Path=/` 改成 `/ui/` 并添加 `Secure`；Caddy 代持时按上节保留会话于代理即可。`--public-url https://dsh.example.com/ui/` 公告这个入口，实际路由由代理配置。

### <a id="ssh-tunnel"></a>临时 SSH 本地入口

从浏览器所在机器建立转发：

```sh
ssh -N -L 13080:127.0.0.1:3080 <host>
```

然后在 `http://127.0.0.1:13080/?token=…` 下用当前启动 token 兑换一次。浏览器的 loopback Host 已受信，cookie 绑定的是浏览器所用的 `127.0.0.1:13080`。该入口下官方设置镜像也会选择 Host 持久化。

### <a id="tcp-relay"></a>跨节点的私有上游

Caddy 与 DSH 分处不同节点或网络 namespace 时，先让网关通过受控私网或隧道连接 DSH，再使用同一套 HTTP 代理配置。例如需要 TCP relay 时：

```sh
socat TCP-LISTEN:<relay-port>,bind=<private-address>,fork,reuseaddr TCP:127.0.0.1:3080
```

绑定地址、防火墙和来源 ACL 将它限制给可信网关。DSH 继续看到浏览器的公网 Host；公网 TLS、门禁与 cookie 注入仍由 Caddy 负责。

## <a id="public-url"></a>官方参数：trusted-host 与 public-url

| 参数 | 作用 | 在上述部署中的选择 |
|---|---|---|
| `--host` / `--port` | 设置 DSH 监听地址与端口 | 默认 `127.0.0.1:3080`；CLI 拒绝 `--host 0.0.0.0` |
| `--trusted-host host[:port]` | 声明官方 API 接受的公网 Host | Caddy 保留公网 Host 时填写实际域名；无端口条目匹配该 hostname 的任意端口，带端口则精确匹配 |
| `--public-url http(s)://host[/prefix]/` | 公告浏览器使用的应用根 | 按需填写真实 HTTPS 根 |
| `--no-open` | 抑制启动时打开浏览器 | systemd 服务通常使用 |

`--public-url` 在 `0.2.1-alpha.1` 加入，接受绝对 HTTP(S) 根并补齐尾斜杠。它更新启动打印的带 token URL、默认浏览器打开地址、Agent 命令环境的 `DSH_WEB_URL`，以及模型收到的 Web GUI 定位提示。`DSH_WEB_URL` 本身只含应用根。

它是地址公告参数。已经使用固定公网域名、服务带 `--no-open`、也无需从日志或 Agent 获取这个地址时，日常使用可以保持现状。公网放行使用 `--trusted-host`；代理路由和会话由各自配置负责。

源码依据：[参数接线](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-alpha.1/packages/bundle/web-app/src/index.ts#L245-L295)、[URL 格式校验](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-alpha.1/packages/bundle/web-app/src/public-url.ts)、[persona 与环境变量接线](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-alpha.1/packages/bundle/web-app/cordis.patch.yml#L187-L208)。

## <a id="web-trusted-host"></a>请求校验与浏览器会话

### <a id="browser-session-auth"></a>请求怎样被接受

DSH 使用请求实际携带的 `Host` 做判断。`dsh.example.com` 是公网 Host；`127.0.0.1:3080` 是 Caddy 连接的上游地址。两个值分别承担 HTTP 身份和网络连接的职责。

API 与 WebSocket 按顺序检查：

| 检查 | 通过条件 | 失败结果 |
|---|---|---|
| 主机与浏览器来源 | Host 为 loopback 或匹配可信条目；`Sec-Fetch-Site` 为非 `cross-site`；如有 Origin，其 URL 的 `.host` 与请求 Host 相同 | 403 |
| 会话 | Cookie 签名正确、未过期，并与当前请求的 `host[:port]` 绑定 | 401 |

这里的 `host[:port]` 称为 authority，表示域名/IP 与可选端口。Origin 比较使用 URL 规范化后的 `.host`，同源 GET 有时不带 Origin，仍执行 Host 校验。根页面与 token 兑换另走 index 认证逻辑，因此页面可以加载时，还要检查 API 与 WebSocket 是否也成功。

当前依据：[API 请求信任判定](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-alpha.1/packages/client/connection/src/api-request-trust.ts)、[RPC 准入](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-alpha.1/packages/client/connection/src/rpc-host.ts#L96-L117)、[index 与会话认证](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-alpha.1/packages/client/connection/src/browser-auth.ts#L238-L312)。

### <a id="browser-session-lifecycle"></a>会话如何取得和失效

DSH 每个进程生成一枚启动 token，并打印应用根的 `?token=…` URL。应用根收到有效 token 后签发 cookie，303 重定向到干净的 `./`。后续页面、API 与 WebSocket 使用 cookie。

cookie 名为 `dsh-auth-<hash>`，签名中记录兑换请求的 authority、签发时间与到期时间。属性为 host-only、`Path=/`、`HttpOnly`、`SameSite=Strict`，默认寿命 30 天。官方 loopback HTTP 上游签发的 cookie 由 HTTPS 代理按实际部署处理其 `Secure` 和路径。

| 变化 | 结果 |
|---|---|
| DSH 进程重启 | 启动 token 换新；签名密钥保存在 `$DSH_HOME/.credentials.yaml`，原有效 cookie 可继续使用 |
| Connection 热重载 | 当前进程 token 保留；会话继续按现有签名与期限验证 |
| Cookie 到期 | 用当前启动 token 重新兑换 |
| Cookie 寿命调大 | 已签发 cookie 保持原到期时间 |
| Cookie 寿命调小 | 已签发跨度超过新上限的 cookie 立即无效，重新兑换获得新期限 |
| 请求 Host 或端口变化 | 按新的 authority 重新兑换，Caddy 同时更新 cookie 名与值 |
| 删除 `client-connection/browser-session` 凭据记录并重启 | 撤销现有全部会话 |

token 可在当前进程内多次兑换；普通访问沿用 cookie 已封定的期限。清除浏览器站点数据只结束该浏览器自行持有的会话，代理代持的会话按代理凭据更新流程处理。

源码依据：[token、cookie 与签名密钥](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-alpha.1/packages/client/connection/src/browser-auth.ts)、[寿命默认值](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-alpha.1/packages/client/connection/src/index.ts#L92-L113)。

### <a id="launch-token-journal"></a>从当前进程取得 token 并兑换

systemd 托管时，先限定当前 MainPID 读取启动 URL。以下以系统模板服务为例；用户服务在两个命令中加 `--user` 并使用其实际 unit 名：

```bash
set +x
DSH_SERVICE_UNIT='dsh@<user>.service'
DSH_SERVICE_PID="$(systemctl show "$DSH_SERVICE_UNIT" -p MainPID --value)"
test "$DSH_SERVICE_PID" -gt 0
DSH_LAUNCH_TOKEN="$(journalctl -u "$DSH_SERVICE_UNIT" "_PID=$DSH_SERVICE_PID" -o cat |
  rg '^dsh web: https?://' | rg -o 'token=[A-Za-z0-9_-]+' | tail -n 1 | cut -d= -f2)"
test -n "$DSH_LAUNCH_TOKEN"
```

当前进程尚未打印 URL 时，检查其启动状态后再继续。限定 MainPID 和启动行，可排除旧进程输出与进入 journal 的运维命令文本。

Caddy 代持方式按公网 Host 在同一 shell 兑换：

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
unset DSH_LAUNCH_TOKEN DSH_SERVICE_PID DSH_SERVICE_UNIT
```

命令通过标准输入提供带 token 的 URL，把 cookie 写进权限为 `0600` 的新文件。确认 HTTP 303 后，将 jar 中的实际 cookie 名与完整 `v1.…` 值转存到 Caddy 私有凭据文件。连接端口、Host 与后续代理配置保持一致。cookie jar 与启动 token 均按凭据管理，避免进入聊天、仓库或普通日志。

兑换成功证明 cookie 已签发；配置正确的 `--trusted-host` 后，再验收实际 API 与 WebSocket。

### <a id="cookie-max-age-patch"></a>配置会话寿命

在 Web profile 的 `cordis.patch.yml` 顶层按 id 覆盖官方 `connection` 条目。例如将寿命改成 90 天：

```yaml
- id: connection
  config:
    cookieMaxAgeDays: 90
    trustedHosts: !!js ctx.webRuntime.trustedHosts
```

`config` 整段替换，因此一并保留 `trustedHosts`。先把该条目存成独立草稿，用 `dsh --profile web --patch ./draft.cordis.yml --dump-config` 检查合成树里只有一个 `id: connection`，且包含两个字段，再写入目标 profile。live profile 会按官方 Loader 生命周期重载；配置检查与真实入口验收分别完成。

## <a id="client-isloopback"></a>远程设置为何需要插件

官方浏览器 Client 按页面 hostname 计算 `isLoopback`。公网域名页面得到 false；Caddy 如何连接上游、是否代持 cookie，都保持地址栏中的公网域名。

截至 `0.2.1-alpha.1`，官方 `ui-settings` 按这个值选择持久化方式：loopback 页面使用 `host`，远程页面使用 `memory`。后者的设置镜像初始化为 `unavailable`，读取与补读在客户端短路。因此远程页面虽已通过认证，Models 仍可出现“settings are unavailable in this browser”，General 显示不可用，部分 Plugins 与权限预设内容缺失。

本插件使设置镜像使用 Host 持久化，保留官方设置表单、后端接口与认证。设置管理请求由实际部署中的门禁与 DSH 会话保护。[临时 SSH 入口](#ssh-tunnel)下，页面本身是 loopback，官方组件也会选择 Host 持久化。

源码依据：[页面 loopback 判定](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-alpha.1/packages/client/connection/src/client/index.ts#L247-L249)、[设置 persistence 选择](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-alpha.1/packages/client/ui-settings/src/client/index.ts)、[设置镜像的 memory 行为](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-alpha.1/packages/client/ui-settings/src/client/settings-mirror.ts)。

## <a id="file-compatibility"></a>文件兼容与诊断

### <a id="resource-url-compatibility"></a>资源 URL 解析

官方 `protocolOf()` 使用 `new URL(address).hostname` 为 `dsh-resource://file/…` 选择 provider。某些浏览器的非标准 scheme 解析给出空 hostname，就会显示“文件资源服务不可用”。本仓旧版按启动探测结果替换全局 `window.URL`；当前代码只在资源客户端自己的解析边界兜底，保留原生 URL 和它的静态方法。

客户端启动时探测原生行为：正常为 `not-needed`，需兼容时为 `enabled`，异常为 `failed`。正常浏览器沿用原生解析；需兼容时，插件在官方资源 registry 的创建入口补齐尚未识别的资源协议。官方已经正确识别的地址继续使用原结果。该补丁随资源服务的生命周期恢复原入口，页面原生 `window.URL` 始终保留。

实现见[浏览器兼容层](lib/client.js)。资源客户端与文件地址解析器直接使用当前 DSH 安装提供的代码。

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

实现见[浏览器兼容层](lib/client.js)与[Host 页面注入](lib/index.js)。官方文件客户端继续完成文件读取与刷新，插件只为慢订阅提供提前读取的时机。

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
| `settings-host` | 官方设置客户端已使用 Host 持久化 |
| `*-unsupported` | 对应兼容入口与当前客户端接口不匹配，沿用官方行为 |

计数每项最多 65535，最近事件最多保留 20 条。事件只含类别、时间和有上限的耗时。同类兼容警告在页面内只输出一次。诊断保存在当前浏览器页面，可用于判断实际触发情况；文件路径、内容、会话 ID 与认证凭据均不进入记录。

历史服务日志的证据有限：2026-10-03 检查作者 timidly 的 journal，保留范围为 9 月 15 日至 10 月 3 日，排除 sudo 命令审计后，未找到 URL 兼容或文件确认降级记录；旧代码也没有记录这些触发。新诊断可判断实际需要哪些补丁，以及等待预算是否适合当前连接。持续超时时继续检查 HTTP RPC 与 WebSocket/流请求的代理路径。

## <a id="security-boundaries"></a>安全边界

本插件让通过认证的远程浏览器使用 Host 设置管理能力。部署者应把获准进入 Caddy 门禁的人视为该 DSH 账户的操作者。

| 边界 | 负责的层 | 本插件的影响 |
|---|---|---|
| 外部 TLS 与登录门禁 | Caddy、caddy-security 或其他入口代理 | 完整覆盖页面、API、插件路由和 WebSocket；本插件依赖部署者维持这层 |
| DNS rebinding / 跨站请求 | 官方 Host/Origin/`Sec-Fetch-Site` 栅栏 | 官方 `--trusted-host` 是主要入口；可选 `hosts` 兼容旧部署 |
| 浏览器操作 Host 的身份 | DSH 启动 token 与签名 cookie | 继续由官方认证；代理代持时由代理替用户持有这层会话 |
| 公网设置持久化 | 浏览器 Settings 镜像 | 将 `memory` 改为 `host`，允许设置和凭据管理请求真正到达官方后端 |
| 文件可读范围 | 官方文件系统能力与 DSH 运行用户的 OS 权限 | 补丁沿用官方读取；目录列表限制不等于文件读取必须在 workspace 内 |
| 第三方插件自身路由与代码 | 插件作者与部署审查 | 自注册路由不自动继承官方 API 栅栏；Host 插件有进程用户权限 |

**作者的本机部署由 Caddy 门禁保护。** 在这个条件下，保留远程设置能力是合理的部署取舍：把获准进入门禁的人视为能够操作该 DSH 用户账户的操作者。Caddy 身份不会自动变成 DSH 内部逐人 ACL；同一实例的浏览器会话按 operator 权限处理。需要不同用户或权限的数据隔离时，应使用不同 OS 用户/DSH 实例并分别配置入口门禁。

上游监听端口或私网 relay 只供可信代理与管理网络访问，使公网请求统一经过 Caddy 门禁。保持外部 TLS，保护 journal、启动 token、cookie 文件和 `$DSH_HOME/.credentials.yaml`。官方静态资源可以公开加载，Host 操作另由 RPC 认证决定。

官方 `workspaceFiles` 的 regular file 读取允许 workspace 外路径，沿部署的 filesystem read 权限执行；预览的文件边界由该能力和运行账户的 OS 权限决定。Host 插件代码也以进程用户权限运行，独立于 Agent 工具的沙箱和审批。

> 来源：[当前 RPC operator 与准入校验](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-alpha.1/packages/client/connection/src/rpc-host.ts#L96-L117)、[文件服务读取范围](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-alpha.1/packages/api/workspace-files/src/index.ts#L1-L14)、[浏览器 cookie 和身份边界](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-alpha.1/packages/client/connection/README.zh.md#L37-L43)、[官方根路径认证调用](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-alpha.1/packages/host/frontend-static/src/index.ts#L131-L136)。

## <a id="install"></a>安装、升级和卸载

### 安装与配置

先按[Caddy 公网部署](#caddy-public-entry)完成 TLS、登录门禁、可信主机与会话配置。需要远程设置管理或文件兼容时，在对应用户的 Web profile 安装本插件。

将当前插件代码打包到新建的私有产物目录，再安装这个产物：

```sh
npm pack --pack-destination <private-package-directory>
dsh plugin --profile web add <private-package-directory>/dsh-public-web-0.1.3.tgz
```

这个 tarball 装入的是本仓的兼容逻辑；官方客户端由运行中的 DSH 安装提供。安装或替换插件后，重启目标 profile 的 DSH 服务并完整刷新浏览器页面，让页面加载新的前置脚本。旧版全局 URL 包装也会在完整刷新时清除。当前包版本保留 `0.1.3`，替换同版本代码时使用新产物路径并确认实际安装内容。

当前部署优先使用官方 `--trusted-host`，本仓默认 `hosts: []`。已有部署也可继续用本插件声明自己的可信主机：

```yaml
- id: dsh-public-web
  config:
    hosts:
      - dsh.example.com
    watchAckTimeoutMs: 800
```

Profile 的 `config` 整段替换，覆盖时保留实际需要的字段。`--public-url` 配置在 `dsh web` 命令或 systemd `ExecStart` 中。`watchAckTimeoutMs` 的行为见[文件订阅确认](#file-watch-ack)。

### 怎样复用官方组件

[cordis.patch.yml](cordis.patch.yml) 只插入本插件自己的 Host 条目。官方设置、资源与工作区文件条目保持启用，服务端和浏览器端都由当前 DSH 安装提供；本包只包含页面兼容脚本、配置与说明。

[Host 入口](lib/index.js) 在官方客户端注册前注入[页面兼容层](lib/client.js)。兼容层保留官方模块的导出、依赖与主体实现，只为三个入口提供局部适配：

| 官方组件 | 兼容层提供什么 |
|---|---|
| 设置 | 该设置组件初始化时使用 Host 持久化；其他组件继续看到实际连接信息 |
| 资源 | 浏览器解析探测失败时，补齐官方资源创建结果中缺失的协议 |
| 文件 | 订阅超时先触发官方读取，保留原订阅；实际确认到达后继续使用官方刷新与文件解析 |

升级 DSH 后，官方组件直接来自新安装，正常继承上游更新。官方已正确解析的资源沿用其结果。若上游改变某个适配入口的接口，兼容层记录该项 `*-unsupported` 并继续使用官方行为；根据这个具体变化维护相应补丁即可。

### 验证与维护

运行 `npm test`，检查官方模块接入、正常与迟到订阅、取消清理、原生与兼容 URL 解析、诊断边界。合成配置检查可用 `dsh --profile web --dump-config`：确认官方 `resources`、`ui-settings`、`workspace-files` 仍启用，同时存在 `dsh-public-web` 条目。

部署后通过真实公网入口验证 Models/General 设置读取和保存，打开文件并改变内容，确认预览随之更新；查看[诊断](#diagnostics)判断是否触发超时或接口未适配。关闭预览再打开，检查订阅可正常结束和重新建立。升级 DSH 后完成同样的入口检查，即可判断当前官方组件与兼容层的实际组合是否正常。

### 卸载

```sh
dsh plugin --profile web remove dsh-public-web
```

重启目标 profile 并完整刷新页面。页面继续使用官方客户端；现有可信主机、Caddy 代理与 DSH 会话维持公网访问。设置和文件表现恢复当前官方实现，DSH 会话、配置与凭据保留。
