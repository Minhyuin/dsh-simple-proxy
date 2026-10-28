# dsh-simple-proxy

在 DSH 的设置里填写代理地址和端口，用开关决定 DSH 自己的网络请求走不走代理。

**不需要**在启动 DSH 之前设置 `http_proxy` / `https_proxy`，**也不需要**打开 TUN。
只有 DSH 这个进程的出站 HTTP(S) 请求被接管，本机其他程序的流量不受影响。

## 为什么需要它

有些模型节点（例如某些中转 provider）只有从境外出口才能访问，直连会超时。
以前的办法有两个：在已经设好代理环境变量的终端里启动 DSH（麻烦），或者开 TUN
（副作用是全机流量都被代理）。这个插件把代理变成 DSH 里的一项设置：
填地址、点开关，保存即生效，关掉即恢复。

## 使用

设置 → 插件 → 网络代理：

| 项 | 说明 |
| --- | --- |
| 启用代理 | 保存后立即安装；关闭后恢复为原来的网络设置 |
| 代理地址 | `127.0.0.1`，也接受 `host:port`、`http://host:port`、带方括号的 IPv6 |
| 端口 | 地址里没写端口时用这个，默认 `7890` |
| 直连域名 | 这些域名及其子域不走代理，逗号分隔，默认 `deepseek.com`；留空表示全部走代理 |
| 测试地址 | 「测试连接」请求的 URL，默认 Cloudflare 的 `cdn-cgi/trace` |

- **保存**写入本插件的设置文档，宿主端随即安装或恢复网络设置，不用重启 DSH。
- **测试连接**用表单里当前（可以未保存）的地址发一次请求，不经过正在生效的代理，
  所以代理还关着也能先测通不通。
- 页面下方显示宿主端的真实状态：代理是否生效、生效的是哪个地址、上次测试结果。
- 本机地址（`localhost`、`127.0.0.1`、`::1`）永远直连，避免把自己代理绕进死循环。
- 默认让 `deepseek.com` 直连：它在国内本来就能访问，绕一圈反而更慢，还多一个故障点。
  只有真正需要出海的 provider 才进隧道。
- 保存时宿主端会用**一次真实请求**验收新装上的 dispatcher（不是只看协议对不对）：
  代理不通、需要登录、节点重置连接，都会显示成一行「未能通过实际请求验证」，而不是
  假装安装成功。

只支持 `http://` 与 `https://`（即 HTTP CONNECT 隧道）代理，不支持 `socks5://`。
绝大多数本机代理软件（Clash、v2rayN 等）的 HTTP 端口都可用。

## 实现

宿主端在配置变化时替换 undici 的全局 dispatcher：

```js
const dispatcher = new Agent({
  factory(origin, options) {
    return isDirectTarget(origin.hostname)
      ? new Pool(origin, options)
      : new ProxyAgent({ ...options, uri: proxyUrl });
  },
});
setGlobalDispatcher(dispatcher);
```

Node 内置 `fetch` 解析的就是这个全局 dispatcher，所以 DSH 的模型调用、
MCP HTTP 传输、web fetch 工具都会走代理，而 `process.env` 完全不动 ——
这也正是「不污染子进程」的原因。

关闭时把安装前捕获的 dispatcher 原样装回去（按引用比较，只还原自己装的那个），
所以如果启动器本身已经装了环境变量代理，关掉本插件只会退回那层，而不会清空它。

### 模型流量走的是 billion-context 的中转

装了 `billion-context` 的 profile 里，模型的请求根本不出 DSH 进程：bili 把每个 provider
的 base URL 改写成 `http://127.0.0.1:<port>/bili/<原地址>`，真正发出去的请求由它自己
派生的**子进程**完成（本机实测：`node.exe ... billion-context/dist/index.js start --host
127.0.0.1 --port 18790`，父进程是 DSH）。进程内的 dispatcher 管不到它，于是会出现
「本插件的测试按钮 200、模型调用却 502 `acp-proxy failure`」这种分裂。

bili 自带上游代理开关（`upstreamProxy` + `upstreamProxyMode: "manual"`，就是它 Web 面板
代理编辑器写的两个键）。所以启用代理时本插件也会把那两个键写进
`~/.config/billion-context/billion-context.json`（可用 `relay: false` 关闭），并在一份
旁挂文件 `~/.dsh/.dsh-simple-proxy-relay.json` 里记下原值；关闭代理时原样还原。

bili 只在它的守护进程**启动**时读配置，所以这一项要下次启动 DSH 才生效 —— 面板会写明
这一点（「billion-context 的中转也已指向这条代理；…需要重启 DSH 才生效」）。

重启后第一次模型调用仍报 `502 "acp-proxy failure"` 的话，多半是 bili 自己的熔断器：同一个
上游连续 3 次「收到响应前就失败」就会短路一段时间，短路状态在它的进程内存里，重启即清空。
判断方法是看错误体里的 `upstream circuit open — failing fast without contacting …`。

`apply` 里的协调函数是幂等的：设置写入会重启插件 fiber，重跑 `apply` 时如果代理
地址没变就什么都不做；另有一个 1 秒的看门狗兜住「配置被别处改写、事件没到本 fiber」
的情况。

### 两个 undici

桌面运行时自带 undici 8，profile 里装的是 undici 7，而 dispatcher 只接受同一代的
handler。但两条路径的结果并不一样：

- **全局安装**（`setGlobalDispatcher`）跨代也能用。undici 8 在设置全局 dispatcher 时，
  会同时往 v7 用的旧符号（`Symbol.for("undici.globalDispatcher.1")`）里放一个
  `Dispatcher1Wrapper`，把 v8 的 dispatcher 适配成 v7 handler 能接受的样子 —— 所以进程
  里那份 v6/v7 时代的 `fetch` 拿到的是适配器，请求正常。
- **按请求传**（`fetch(url, { dispatcher })`）跨代必失败：v8 的 dispatcher 直接收到 v7
  的 handler，报 `UND_ERR_INVALID_ARG: invalid onRequestStart method`（方向反过来是
  `invalid onConnect method`）。这正是「面板显示已安装、测试按钮却报错」的原因。

所以插件**只走全局安装**，测试按钮也一样（必要时临时装一个、请求完还原，绝不按请求传
dispatcher）。安装时仍会把能解析到的几份 undici 都试一遍（loader、DSH 安装目录、profile、
插件自己），用一次回环请求确认真正能被驱动：探测地址是 `http://127.0.0.1:45123/`（合法
但没人监听）—— handler 不匹配在建立连接之前就抛错，而 `ECONNREFUSED` 恰恰说明协议是对
的。**别用 1、9、25、587 这类端口**：`fetch` 会在到达 dispatcher 之前就以 `bad port`
拒绝，探测就什么也证明不了。选中的来源显示在设置页的「undici 模块来源」一行（`host` /
`dsh` / `profile` / `plugin`）。

协议对不对只是第一关：装上去之后还要用**该 dispatcher 实际发一个 HTTPS 请求**（默认
`https://www.cloudflare.com/cdn-cgi/trace`，6 秒超时）。只有真的通了才记为已验证；
所有副本都通不过时，仍然装上协议兼容的那一份，并在面板上标注「未能通过实际请求验证」
—— 装上但没验证，和装不上，是两件不同的事，面板不该混为一谈。

设置页需要几个只有宿主端知道的事实（现在是否生效、某个地址通不通、这个进程里的
undici 到底是哪一份），通过四条仅限回环地址的普通路由提供：

- `GET /dsh-simple-proxy/status` — 当前期望配置、解析结果、实际安装状态、上次测试结果
- `POST /dsh-simple-proxy/test` — body `{host?, port?, url?}`，用专用 dispatcher 实测一次
- `GET /dsh-simple-proxy/diag` — 排障用：`process.versions`、每份 undici 副本（来源 / 版本 /
  协议是否兼容）、每份副本对几个目标 URL 的实测结果，以及本进程最近 40 次 `fetch()`
  和每个 origin 被判定为 direct / proxy 的记录
- `POST /dsh-simple-proxy/provider` — body `{url, model?, apiKeyEnv?, mode?, proxyUrl?, timeoutMs?}`，
  用宿主进程自己的凭据复放一次模型调用；`mode` 取 `current` / `proxy` / `direct`，
  分别表示「按当前安装」「强制走代理（忽略直连名单）」「直连」。返回状态、耗时和
  响应体前缀，凭据本身绝不出现在结果里

`GET /dsh-simple-proxy/diag?provider=<url>&model=<id>` 会在同一份报告里附上三种 `mode` 的
复放结果——「隧道好但该域名被直连」和「这条出口不被网关接受」的区别只有这三份答案
放在一起才看得出来。

四条路由只接受来自 `127.0.0.1` / `::1` 的请求，其他来源直接 403。

## 安装

插件包本身就是一个 DSH bundle（`dsh.bundle.patch` 指向 `cordis.patch.yml`），
用插件管理器装，或者手工挂进 profile：

```bash
# 从 npm 装
dsh plugin --profile <你的 profile> add dsh-simple-proxy
```

手工挂进 profile：

```bash
# 1. 让 profile 能解析到包（仓库根目录执行；Windows 用 junction 免管理员，
#    别在 MSYS 里用 mklink —— 参数会被改写）
node tools/link.mjs "E:\agent\DSH\dsh-proxy\plugin" "%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-simple-proxy"

# 2. profile 的 package.json
#    dependencies: "dsh-simple-proxy": "link:E:/agent/DSH/dsh-proxy/plugin"
#    dsh.profile.bundles: 追加 "dsh-simple-proxy"

# 3. profile 的 cordis.patch.yml 末尾
# - id: dsh-simple-proxy
#   name: dsh-simple-proxy
```

然后重启 DSH。默认 `enabled: false`：装上不等于同意把流量送进某个端口。

## 开发

宿主端与客户端都不需要构建，改完即可测：

```bash
npm test           # 宿主端 25 项 + 客户端 9 项
npm run test:host  # 只跑宿主端（会真的走一次本机 7890 代理）
npm run test:client
```

测试用假的 Cordis 上下文、假的 `document` 与 React hooks 运行时渲染真实页面，
不需要浏览器。宿主端测试还会真装一次代理、验证直连回环地址不受影响、
验证关掉后 dispatcher 按引用还原。

## 限制

- 只接管 DSH 自己的 Node `fetch`。worker 线程有自己的 dispatcher，不受影响。
- 不代理原生模块自己建的连接（例如某些 HTTP 客户端直接调 libcurl/socket）。
- 不代理子进程；子进程是否走代理由它自己的配置决定。唯一的例外是显式互操作：
  `billion-context` 的中转会按上面的方式被写进它自己的上游代理配置。
- 代理是进程级设置：DSH 里所有走 `fetch` 的请求都会经过它，包括 web 搜索和文档抓取。
