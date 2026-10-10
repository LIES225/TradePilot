#!/bin/bash
set -e

# Default to owner-only creation. Rootless mode switches to 0007 after its
# owner-root/group-node bridge is ready; no mode grants access to "other".
umask 0077

# This root-owned helper accepts no runtime-configurable path.
# shellcheck source=session-permissions.sh
source /app/session-permissions.sh
miniclaw_configure_node_identity

# Prepare only explicit writable roots. Direct mode touches roots and performs
# a separate one-time legacy migration below; rootless defers to its verified
# bridge; host-root/Desktop preserve owner-only modes.
miniclaw_prepare_mounted_paths
miniclaw_migrate_direct_managed_paths

# Mark mounted directories as safe for git (CVE-2022-24765 ownership check).
# Host uid may differ from container node user, causing git to refuse operations.
# 使用通配符 '*' 因为挂载路径动态（extra mounts、customCwd），无法枚举具体目录。
runuser -u node -- env HOME=/home/node /usr/bin/git \
  config --global --add safe.directory '*'

# Source ordinary runtime variables while locally shadowing every root-control
# variable, including stale values persisted before the host-side denylist.
miniclaw_source_runtime_env

# Make the Pi runner's local tools (including agent-browser) available to the
# selected runtime and to commands launched by capability tools.
export PATH="/app/node_modules/.bin:${PATH}"

# Keep the historical config location as a writable compatibility surface for
# Skills and provider settings; Pi stores its own sessions below this root.
export CLAUDE_CONFIG_DIR=/home/node/.claude

# Persist Agent's `npm install -g <pkg>` to per-user mounted extra dir.
# 容器是 docker run --rm 模式，每次结束销毁。如果 Agent 在容器里跑
# `npm install -g lark-cli`、`@fanfanv5/feishu-cli`、各类 MCP server 包等，
# 默认会装到镜像内层 /usr/local/lib/node_modules，下次新容器又得重装。
# 把 npm prefix 指向已挂载的 /workspace/extra/.npm-global（host 端
# data/extra/{folder}/.npm-global/，per-user 隔离）即可让全局包持久化。
NPM_GLOBAL_DIR=/workspace/extra/.npm-global
/usr/local/bin/node /app/session-generated-paths.mjs --ensure-npm-global
miniclaw_prepare_generated_path npm-global
# 写到 node user 的 ~/.npmrc 让 npm 全局命令默认走该 prefix。
# 镜像每次启动重置 /home/node，所以 entrypoint 每次都重写一遍是稳妥做法。
cat > /home/node/.npmrc <<EOF
prefix=$NPM_GLOBAL_DIR
EOF
chown node:node /home/node/.npmrc 2>/dev/null || true
# Keep the persistent user-global bin after the image's runtime tools so the
# bundled capability tooling remains the first resolution candidate.
export PATH="$PATH:$NPM_GLOBAL_DIR/bin"

# Materialize the canonical Skill manifest resolved by the host. Each selected
# Skill is mounted read-only below /workspace/effective-skills. Completely
# rebuilding the directory prevents a real Skill directory created by an
# earlier Agent run from surviving a container restart.
/usr/local/bin/node /app/session-generated-paths.mjs --reset-skills
if [ -d /workspace/effective-skills ]; then
  for skill in /workspace/effective-skills/*/; do
    if [ -f "${skill}SKILL.md" ]; then
      name=$(basename "$skill")
      /usr/local/bin/node /app/session-generated-paths.mjs \
        "--link-skill=$name"
    fi
  done
fi
miniclaw_prepare_generated_path skills

# Compile TypeScript (agent-runner source may be hot-mounted from host). The
# image build leaves /app/dist/.tsbuildinfo behind; disable incremental mode so
# changing only outDir cannot incorrectly reuse that cache and emit no files.
cd /app && npx tsc --outDir /tmp/dist --incremental false 2>&1 >&2
miniclaw_prepare_generated_path dist
ln -s /app/node_modules /tmp/dist/node_modules
/usr/local/bin/node /app/session-prompts-copy.mjs

# Fix permissions on exit: Claude Code creates some files with mode 0600
# (e.g. settings.json), which the host backend (agent user) cannot read.
# The trap runs as root after the node process exits. It also stops the managed
# Chromium process so no browser child survives a cancelled run.
CHROMIUM_PID=
cleanup() {
  local cleanup_status=0
  miniclaw_stop_session_permission_watcher || cleanup_status=$?
  if [ -n "$CHROMIUM_PID" ] && kill -0 "$CHROMIUM_PID" 2>/dev/null; then
    kill "$CHROMIUM_PID" 2>/dev/null || true
    for ((attempt = 0; attempt < 20; attempt++)); do
      kill -0 "$CHROMIUM_PID" 2>/dev/null || break
      sleep 0.1
    done
    if kill -0 "$CHROMIUM_PID" 2>/dev/null; then
      kill -KILL "$CHROMIUM_PID" 2>/dev/null || true
    fi
    wait "$CHROMIUM_PID" 2>/dev/null || true
  fi
  return "$cleanup_status"
}
trap cleanup EXIT

# Rootless bind mounts require a live owner-root/group-node bridge for files
# that applications explicitly create as 0600. Other modes need no watcher.
miniclaw_start_session_permission_watcher
if [ "$MINICLAW_INTERNAL_IDENTITY_MODE" = rootless ]; then
  umask 0007
fi

# Start one deterministic browser for this task container. Binding to loopback
# keeps the raw Chrome DevTools Protocol private to the container; a future Web
# browser panel must proxy the authenticated agent-browser dashboard/stream,
# never publish this port directly.
MINICLAW_CHROMIUM_CDP_HOST="${MINICLAW_CHROMIUM_CDP_HOST:-127.0.0.1}"
MINICLAW_CHROMIUM_CDP_PORT="${MINICLAW_CHROMIUM_CDP_PORT:-9222}"
CHROMIUM_PROFILE_DIR=/tmp/miniclaw-chromium-profile
CHROMIUM_LOG=/tmp/miniclaw-chromium.log
mkdir -p "$CHROMIUM_PROFILE_DIR"
miniclaw_prepare_generated_path chromium

# agent-browser reads this value when its daemon starts, so it attaches to the
# managed browser instead of creating another Chromium with a random CDP port.
export AGENT_BROWSER_CDP="$MINICLAW_CHROMIUM_CDP_PORT"

HOME=/home/node setpriv --reuid=node --regid=node --init-groups -- \
  "${AGENT_BROWSER_EXECUTABLE_PATH:-/usr/bin/chromium}" \
  --headless=new \
  --no-sandbox \
  --disable-dev-shm-usage \
  --no-first-run \
  --no-default-browser-check \
  --remote-debugging-address="$MINICLAW_CHROMIUM_CDP_HOST" \
  --remote-debugging-port="$MINICLAW_CHROMIUM_CDP_PORT" \
  --user-data-dir="$CHROMIUM_PROFILE_DIR" \
  about:blank >"$CHROMIUM_LOG" 2>&1 &
CHROMIUM_PID=$!

CHROMIUM_READY=false
for ((attempt = 0; attempt < 100; attempt++)); do
  if curl --noproxy '*' -fsS \
    "http://127.0.0.1:${MINICLAW_CHROMIUM_CDP_PORT}/json/version" \
    >/dev/null 2>&1; then
    CHROMIUM_READY=true
    break
  fi
  if ! kill -0 "$CHROMIUM_PID" 2>/dev/null; then
    break
  fi
  sleep 0.1
done

if [ "$CHROMIUM_READY" != true ]; then
  echo "Chromium failed to listen on container-local CDP port ${MINICLAW_CHROMIUM_CDP_PORT}" >&2
  cat "$CHROMIUM_LOG" >&2 2>/dev/null || true
  exit 1
fi

# Buffer stdin to file (container requires EOF to flush stdin pipe)
cat > /tmp/input.json
chmod 644 /tmp/input.json

# Drop privileges and execute agent-runner as node user
runuser -u node -- node /tmp/dist/pi-index.js < /tmp/input.json
