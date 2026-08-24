#!/bin/bash
# 重启 dsh web，使 mira_qqbot 插件加载进运行中的 DSH 进程。
# 用法：在插件目录下运行  bash scripts/restart-dsh-web.sh
#
# 可选环境变量：
#   PORT             dsh web 监听端口，默认 3080
#   DSH_BIN          dsh 可执行文件路径；默认用 PATH 中自动探测到的 dsh
#   TRUSTED_HOSTS   空格分隔的额外 trusted-host 列表（例如远程访问时需要）
set -euo pipefail

PORT="${PORT:-3080}"

# 探测 dsh 可执行文件
DSH_BIN="${DSH_BIN:-$(command -v dsh || true)}"
if [ -z "$DSH_BIN" ]; then
  echo "错误：未找到 dsh 命令。请设置环境变量 DSH_BIN 指向 dsh 可执行文件。"
  exit 1
fi

ARGS=(web --port "$PORT")
if [ -n "${TRUSTED_HOSTS:-}" ]; then
  for h in $TRUSTED_HOSTS; do
    ARGS+=(--trusted-host "$h")
  done
fi

echo "==> 停止当前 dsh web（优雅停机，等待会话 flush）"
# 用端口定位 PID 更可靠（macOS 的 pkill -f 可能匹配不到带参数的 node 进程）
OLDPID=$(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | head -1)
if [ -n "$OLDPID" ]; then
  kill "$OLDPID" 2>/dev/null && echo "    已发送 SIGTERM 到 PID $OLDPID" || echo "    发送 SIGTERM 失败（PID $OLDPID）"
  # 最多等 20s 让进程优雅退出：正在进行的 turn 需要时间落盘，
  # 过早强制结束会把会话留成 live/半开（重启后 resume 报 while it is live 的主因）。
  for _ in $(seq 1 20); do
    if ! kill -0 "$OLDPID" 2>/dev/null; then
      echo "    已优雅退出 PID $OLDPID"
      break
    fi
    sleep 1
  done
  # 超时仍未退出才强制结束；残留 live 会话风险由插件 resume 退避重试兜底
  if kill -0 "$OLDPID" 2>/dev/null; then
    echo "    超时未退出，强制结束 PID $OLDPID"
    kill -9 "$OLDPID" 2>/dev/null || true
    sleep 1
  fi
else
  echo "    没有运行中的 dsh web"
fi
sleep 1

echo "==> 启动 dsh web（后台，日志 /tmp/dsh-web.log）"
nohup "$DSH_BIN" "${ARGS[@]}" > /tmp/dsh-web.log 2>&1 &
echo "    已启动，PID $!"

sleep 3
echo "==> 检查端口 $PORT"
lsof -iTCP:"$PORT" -sTCP:LISTEN -P -n 2>/dev/null | tail -1 || echo "    （端口尚未就绪，稍等几秒再看）"

echo "完成。回到浏览器刷新页面，然后说「继续」让 AI 验收。"
