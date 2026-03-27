# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.1] - 2026-03-27

### 更新

- 新增 `/resume`，支持在微信里查看并恢复最近的 Codex ACP 历史会话
- `doctor`、README 和 Node.js 版本约束统一到实际受支持的工具链范围

## [0.1.0] - 2026-03-24

### 首次公开发布

`agents-to-wechat` 的第一个公开版本，提供将 Codex 连接到微信私聊的基础桥接能力。

#### 功能

- 通过 ACP 协议连接本地 Codex agent
- 将微信私聊消息转发给 Codex，并把回复发送回微信
- 支持 `/model` 等 Codex 原生命令
- 为每个微信用户维护独立会话
- 提供 `doctor`、`login`、`logout`、`start` CLI 命令

#### 限制

- 仅支持文本消息
- 需要本地可用的 `codex`
- 仅支持微信私聊

#### 技术栈

- Node.js >= 22
- TypeScript
- 微信 HTTP API
- Codex ACP 协议

[0.1.0]: https://github.com/leantli/agents-to-wechat/releases/tag/v0.1.0
[0.1.1]: https://github.com/leantli/agents-to-wechat/releases/tag/v0.1.1
