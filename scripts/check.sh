#!/usr/bin/env bash
# 全量门禁 —— 一条命令跑完 AGENTS.md §2 要求的全部验证。
#
#   bash scripts/check.sh            # 全部
#   bash scripts/check.sh sidecar    # 单测 + 覆盖率
#   bash scripts/check.sh contract   # 契约（跑真实 CLI 再校验产物）
#   bash scripts/check.sh boundaries # 外部字段名 / provider 分支 / 零依赖
#   bash scripts/check.sh secrets    # 凭据与内网域名
#   bash scripts/check.sh size       # 单文件行数
#   bash scripts/check.sh rust       # cargo build + test
#
# 跳过（尚未落地的目录）不算失败，但汇总里单列——跳过 ≠ 通过。
# 退出码：0 通过（本地可能含跳过）/ 1 有失败 / 2 用法错误
#
# 兼容 macOS 自带的 bash 3.2：空数组不能直接 "${a[@]}"，统一用 ${a[@]+"${a[@]}"}

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# shellcheck source=gates.env
. "$ROOT/scripts/gates.env"

# 让 cargo 在非登录 shell 里也能找到（rustup 装在 ~/.cargo）
if [ -f "$HOME/.cargo/env" ]; then . "$HOME/.cargo/env"; fi

ONLY="${1:-all}"
FAILED=()
PASSED=()
SKIPPED=()

step() {
  local name="$1"; shift
  printf '\n\033[1m▶ %s\033[0m\n' "$name"
  if "$@"; then
    PASSED+=("$name")
  else
    FAILED+=("$name")
    printf '\033[31m✘ %s 失败\033[0m\n' "$name"
  fi
}

skip() {
  local name="$1" reason="$2"
  printf '\033[33m⚠ 跳过 %s：%s\033[0m\n' "$name" "$reason"
  # 定界必须用 ${name}：bash 3.2 会把紧跟其后的全角字符字节吞进变量名
  SKIPPED+=("${name}（${reason}）")
}

run_sidecar() {
  ( cd sidecar && node --test \
      --experimental-test-coverage \
      --test-coverage-exclude='test/**' \
      --test-coverage-include='**/*.mjs' \
      --test-coverage-lines="$SIDECAR_LINES" \
      --test-coverage-functions="$SIDECAR_FUNCTIONS" \
      --test-coverage-branches="$SIDECAR_BRANCHES" )
}

run_contract() { node scripts/check-contract.mjs; }
run_boundaries() { node scripts/check-boundaries.mjs; }
run_secrets() { node scripts/check-secrets.mjs; }
run_size() { node scripts/check-size.mjs; }

run_rust() {
  local log rc
  log="$(mktemp "${TMPDIR:-/tmp}/pgh-rust.XXXXXX")" || return 1
  ( cd GovernanceHub && cargo build --workspace > "$log" 2>&1 )
  rc=$?
  if [ $rc -ne 0 ]; then
    tail -40 "$log"
    printf '\033[31mcargo build 失败，完整日志：%s\033[0m\n' "$log"
    return 1
  fi
  ( cd GovernanceHub && cargo test --workspace >> "$log" 2>&1 )
  rc=$?
  if [ $rc -ne 0 ]; then
    tail -40 "$log"
    printf '\033[31mcargo test 失败，完整日志：%s\033[0m\n' "$log"
    return 1
  fi
  grep -E "^test result|Finished" "$log" | tail -3
  rm -f "$log"
}

sidecar_gate() { step "sidecar 单测 + 覆盖率（行 ${SIDECAR_LINES} / 函数 ${SIDECAR_FUNCTIONS} / 分支 ${SIDECAR_BRANCHES}）" run_sidecar; }
contract_gate() { step "契约（真实 CLI 产物 + 权限 + 字节一致）" run_contract; }
boundaries_gate() { step "边界（外部字段名 / provider 分支 / 零依赖）" run_boundaries; }
secrets_gate() { step "敏感信息（凭据形态 / 内网词表）" run_secrets; }
size_gate() { step "产品代码行数（≤500）" run_size; }

rust_gate() {
  if [ ! -f "GovernanceHub/Cargo.toml" ]; then
    skip "Rust 编译与单测" "GovernanceHub 尚未落地（M0 进行中）"
    return 0
  fi
  if ! command -v cargo >/dev/null 2>&1; then
    skip "Rust 编译与单测" "找不到 cargo（先装 rustup）"
    return 0
  fi
  step "Rust 编译 + 单测" run_rust
}

js_gate() {
  sidecar_gate
  contract_gate
  boundaries_gate
  secrets_gate
  size_gate
}

case "$ONLY" in
  all)        js_gate; rust_gate ;;
  js)         js_gate ;;
  rust)       rust_gate ;;
  sidecar)    sidecar_gate ;;
  contract)   contract_gate ;;
  boundaries) boundaries_gate ;;
  secrets)    secrets_gate ;;
  size)       size_gate ;;
  *)          echo "用法: bash scripts/check.sh [all|js|sidecar|contract|boundaries|secrets|size|rust]" >&2; exit 2 ;;
esac

printf '\n────────────────────────────\n'
if [ ${#SKIPPED[@]} -gt 0 ]; then
  printf '\033[33m⚠ 跳过 %d 项（没验证，不等于通过）：\033[0m\n' "${#SKIPPED[@]}"
  for s in ${SKIPPED[@]+"${SKIPPED[@]}"}; do printf '  · %s\n' "$s"; done
fi
if [ ${#FAILED[@]} -eq 0 ]; then
  if [ ${#SKIPPED[@]} -eq 0 ]; then
    printf '\033[32m✔ 全部通过\033[0m（%d 项）\n' "${#PASSED[@]}"
  else
    printf '\033[33m✔ 已跑 %d 项通过，另有 %d 项跳过\033[0m\n' "${#PASSED[@]}" "${#SKIPPED[@]}"
  fi
  exit 0
fi
printf '\033[31m✘ %d 项失败\033[0m，%d 项通过，%d 项跳过：\n' "${#FAILED[@]}" "${#PASSED[@]}" "${#SKIPPED[@]}"
for f in ${FAILED[@]+"${FAILED[@]}"}; do printf '  · %s\n' "$f"; done
exit 1
