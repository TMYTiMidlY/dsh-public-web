# dsh-public-web

让官方安装的 DeepSeek Harness 在公网域名上能用。装上这个包之后，把 `dsh web` 打印的 token 地址里的主机名换成你的域名，设置页和侧边栏文件预览都走官方界面。

这个包只做三件事：

- 把配置的公网主机名加进 Web 的 Host 信任列表，这样 `https://你的域名/?token=...` 能过 `/api` 的 Host 检查。
- 设置页在公网主机名上写入 Host 配置，不再停在仅本机内存的模式。没有桌面时的那条提示保持原样。
- 侧边栏预览：给旧浏览器补上 `dsh-resource://` 的 hostname，并在工作区变更流迟迟不确认时改为直接读取文件。

## 安装

先改 `cordis.patch.yml` 里的 `hosts`，写成你要换成的域名（不要带 `https://`）。然后在官方 DSH 的 Web profile 上安装打好的 tarball，并重启该 profile：

```bash
pnpm pack
dsh plugin --profile web add ./dsh-public-web-0.1.3.tgz
```

`hosts` 是 `host` 或 `host:port`。换域名时改插件配置里的这一项；后写的 profile patch 会整段替换 `dsh-public-web` 的 config，所以要保留 `hosts`。

同一个 tarball 可以装到别的 Web profile。无界面的 profile 不要装：它依赖 Web 运行时。

## 插件页

插件列表上名称下面的那一行来自 `package.json` 的 `description`。中文界面用 `locale/zh.json` 的 `meta.description`。这两处必须能从包名解析到，所以 `exports` 要导出 `./package.json` 和 `./locale/*.json`。这个包没有自己的设置页。

## 升级 DSH 之后

Host 侧仍调用当前安装里的官方包。浏览器里的设置页和工作区文件客户端是按 0.1.7-rc.2 打的包。官方客户端接口变了就要重新基于新版本打这个包。卸掉插件后，官方入口会自己回来。
