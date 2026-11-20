# 镜析 ColorLens

镜析是面向科研和教学实验的记录与数据分析工作台。这个仓库提供 Web 应用、服务端、数据库迁移、Windows 本机采集助手源码、测试和模拟样例。

| 实验工作 | 功能 |
| --- | --- |
| 实验记录 | 实验笔记、模板、附件、团队评阅与离线草稿 |
| 样本与设备 | 样本冻存、库存、采购与设备预约 |
| 数据分析 | 显色图像比较、酶标仪读数与 ELISA 曲线、qPCR 多内参 |
| 采集与导出 | Windows 本机采集、图像回填、离线 HTML 报告和 ZIP 导出 |
| AI 复盘 | 配置 DeepSeek 后，用户可预览拟发送内容并授权发起分析 |

本次源码版本为 `0.10.0-preview.19`。正式网站为 [ly070326.cn](https://ly070326.cn/)。

## 本地开发

需要 Node.js 24.10 或更高版本。

```sh
npm ci
npm test
npm run build
```

本机调试入口使用独立 SQLite 文件 `.local/preview.sqlite3`，启动时应用迁移。先生成两个独立随机值，每个至少 32 字节。可以分别执行两次以下命令。

```sh
node -p "require('node:crypto').randomBytes(32).toString('hex')"
```

将生成的值分别赋给环境变量 `AUTH_PEPPER` 和 `BOOTSTRAP_KEY`。也可以将它们保存进私密环境文件并设置 `COLORLENS_ENV_FILE` 指向该文件。AI 功能可另外设置 `DEEPSEEK_API_KEY` 和 `DEEPSEEK_MODEL`。

```sh
npm run dev
```

打开 `http://127.0.0.1:64829/`。首次初始化时，在本机浏览器的 URL 后添加 `/#setup/<BOOTSTRAP_KEY>` 并完成管理员设置。请妥善保存本机密钥。

## Windows 本机采集演示

构建后运行 `npm run preview:v10`。预览在 `127.0.0.1:49185` 打开，采集助手默认使用端口 `49186`。此预览的数据在 `.local/capture-preview`。首次启动生成两个 `example.test` 模拟账号，随机密码保存在该目录的 `settings.json` 中。

若要试用真实媒体采集，请自行获取 Windows 版 MediaMTX 和 FFmpeg，将 `COLORLENS_RUNTIME` 指向存放 `mediamtx.exe`、`ffmpeg.exe` 的目录。离线语音还需要兼容的 whisper.cpp、同发行版所需 DLL 与模型，分别放在该目录下的 `whisper/Release/whisper-cli.exe` 和 `whisper/ggml-base-q5_1.bin`。媒体组件安装和真机接入需按本机设备环境进行验证。

## 自行部署

构建目录为 `dist/pages`。Cloudflare Pages 的 D1 绑定名为 `DB`。使用自己的 D1 数据库，在部署前按文件名顺序应用 `migrations/`，并在服务端配置 `AUTH_PEPPER`、`BOOTSTRAP_KEY` 和所需的邮件或 AI 服务密钥。`wrangler.json` 可作为起点。

## 示例与许可证

`samples/` 提供模拟数据与演示图。显色图像用于比较拍摄条件下的颜色指标，仪器定量使用独立的仪器读数和标准曲线。

镜析源码采用 [MIT 许可证](LICENSE)。第三方组件的署名与许可见 [第三方声明](THIRD_PARTY_NOTICES.md)。
