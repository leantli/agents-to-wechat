# agents-to-wechat

[English](README_EN.md) | 简体中文

将 Codex 连接到微信私聊的 Node.js 桥接工具。

## 状态

- 当前版本为 `0.x` 预览版
- 仅支持文本消息
- 需要本地安装并可用的 `codex`
- 仅支持微信私聊

## 安装

```bash
npm install -g agents-to-wechat
```

```bash
npx agents-to-wechat start
```

从源码安装：

```bash
git clone https://github.com/leantli/agents-to-wechat.git
cd agents-to-wechat
npm install
npm run build
npm link
```

## 使用

```bash
agents-to-wechat doctor
agents-to-wechat login
agents-to-wechat start
```

登录后，向机器人发送微信私聊消息即可开始对话。

## 命令

- `login`: 登录微信并保存凭证
- `start`: 启动桥接服务
- `doctor`: 检查环境和配置
- `logout`: 删除本地登录和同步状态

## 目录

默认状态目录为 `~/.agents-to-wechat/`：

- `wechat-auth.json` - 登录凭证
- `wechat-sync.json` - 同步状态
- `agents-to-wechat.log` - 运行日志

## 依赖

- Node.js >= 22
- `codex` 已安装并在 PATH 中可用

## 故障排除

- `codex` 不在 PATH 中时，先确认本地安装是否正确
- 登录失败时，先执行 `agents-to-wechat logout` 再重新登录
- 没有回复时，先确认 `agents-to-wechat start` 正在运行，并查看日志文件

## 开发

```bash
npm test
npm run check
npm run lint
```

## 许可证

MIT
