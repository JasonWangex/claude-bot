#!/usr/bin/env bash
# 将项目 skills/ 下的所有技能安装（符号链接）到 ~/.claude/skills/
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
SKILLS_SRC="$PROJECT_DIR/skills"
SKILLS_DST="$HOME/.claude/skills"

if [ ! -d "$SKILLS_SRC" ]; then
  echo "No skills/ directory found in project"
  exit 0
fi

mkdir -p "$SKILLS_DST"

# 清理指向本项目但源目录已不存在的旧符号链接
for link in "$SKILLS_DST"/*/; do
  [ -L "${link%/}" ] || continue
  link_target="$(readlink -f "${link%/}" 2>/dev/null || true)"
  # 只清理指向本项目 skills/ 的链接
  if [[ "$link_target" == "$SKILLS_SRC"/* ]] && [ ! -d "$link_target" ]; then
    rm -f "${link%/}"
    echo "  $(basename "${link%/}"): removed (source deleted)"
  fi
done

installed=0
for skill_dir in "$SKILLS_SRC"/*/; do
  [ -d "$skill_dir" ] || continue
  [ -f "$skill_dir/SKILL.md" ] || continue

  skill_name="$(basename "$skill_dir")"
  target="$SKILLS_DST/$skill_name"

  # 如果已经是正确的符号链接，跳过
  if [ -L "$target" ] && [ "$(readlink -f "$target")" = "$(readlink -f "$skill_dir")" ]; then
    echo "  $skill_name: already linked"
    installed=$((installed + 1))
    continue
  fi

  # 移除旧的链接或目录
  rm -rf "$target"
  ln -s "$(readlink -f "$skill_dir")" "$target"
  echo "  $skill_name: installed -> $target"
  installed=$((installed + 1))
done

echo "Skills installed: $installed"
