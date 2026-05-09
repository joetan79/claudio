# Claudio — AI 电台 SaaS

## 项目概述
Claudio 是一个多用户个人 AI 电台平台。每个用户注册后拥有自己的电台，由 AI 自动生成播客内容并通过 TTS 播出。

## 技术栈
- **运行时**: Node.js v22+ (ES Modules)
- **框架**: Express
- **数据库**: SQLite (better-sqlite3)，每用户独立数据库文件存于 data/
- **AI**: Anthropic API (claude-haiku-4-5 默认)，使用 API Key 方案
- **认证**: JWT (jsonwebtoken) + bcryptjs
- **实时**: WebSocket (ws)
- **TTS**: Fish Audio（FISH_TTS_KEY）
- **音乐**: NCM API（NCM_API_URL）

## 端口
- **3001**（开发和生产均使用 :3001）

## 目录结构
```
src/
  server.js        # 入口，Express + WebSocket 服务器
  routes/          # Express 路由模块
  modules/         # 业务逻辑模块（AI、TTS、DB 等）
data/              # 用户 SQLite 数据库文件（gitignored）
prompts/           # AI prompt 模板
```

## 环境变量
见 .env.example。生产环境必须设置 ANTHROPIC_API_KEY、JWT_SECRET、FISH_TTS_KEY。

## 开发约定
- 全部使用 ES Modules（import/export），不用 require
- 路由文件导出 Express Router
- 数据库操作封装在 modules/ 中，不在路由里直接写 SQL
- 错误统一以 `{ error: "message" }` 格式返回

## 调度器
- 每天 **08:00** 自动为所有用户生成早间播单（存入 `plan_morning`）
- 每天 **22:00** 自动为所有用户生成夜间播单（存入 `plan_night`）
- 实现在 `src/modules/scheduler.js`，服务启动时自动注册

## 运行方式
- **开发**：`npm run dev`
- **生产**：在 screen claudio 里跑 `npm start`
- **日志**：`tail -f logs/app.log`
- **端口**：3001，由 Nginx 反代到 claudio.abai.cloud
