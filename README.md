# dsh-simple-proxy 工作区

`dsh-simple-proxy` 插件的开发工作区。可发布的包在 `plugin/`，根目录只放宿主端需要的依赖
—— 因为 profile 用 `link:` 挂载插件时，裸模块名是从插件的真实路径解析的，
`plugin/lib/index.js` 里的 `import z from "@deepseek-ai/schemastery"` 和
`import("undici")` 都得在 `E:\agent\DSH\dsh-proxy\node_modules` 里找得到。

## 快速开始

```bash
npm install     # 只为根目录装上 schemastery 与 undici
npm test        # 宿主端 25 项 + 客户端 9 项
npm run check:submission   # 按 dsh.so 的提交闸门体检将要发布的 tarball
```

装进 desktop profile 里（已发布版本直接装）：

```bash
dsh plugin --profile <你的 profile> add dsh-simple-proxy
```

没有 `dsh` 命令行时，直接改 profile（等价于插件管理器做的事）：

```bash
node tools/link.mjs "E:/agent/DSH/dsh-proxy/plugin" "C:/Users/User/.dsh/profiles/desktop/node_modules/dsh-simple-proxy"
```

`C:\Users\User\.dsh\profiles\desktop\package.json`：

```jsonc
{
  "dependencies": { "dsh-simple-proxy": "link:E:/agent/DSH/dsh-proxy/plugin" },
  "dsh": { "profile": { "bundles": [ /* … 追加 "dsh-simple-proxy" */ ] } }
}
```

`C:\Users\User\.dsh\profiles\desktop\cordis.patch.yml` 末尾追加：

```yaml
- id: dsh-simple-proxy
  name: dsh-simple-proxy
```

重启 DSH 后，设置 → 插件 里多出一个「网络代理」标签页。`enabled` 默认 `false`，
装好不改变任何网络行为，要用时在面板里打开。

> 必须重启：profile 的 patch 文件不会被文件监听器拾取，手工改完 `cordis.patch.yml`
> 后新条目要下一次启动才挂载。改了插件代码同理，宿主端只在 DSH 启动时加载。
