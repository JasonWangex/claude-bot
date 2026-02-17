#!/usr/bin/env node
/**
 * 检查 running tasks 的 Claude session 是否真的在执行
 *
 * 用法: node scripts/check-running-tasks.mjs
 */

import Database from 'better-sqlite3';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');

// 检查进程是否存活
function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// 检查 active-processes.json 注册表
function checkActiveProcesses() {
  const registryFile = join(projectRoot, 'data/active-processes.json');
  if (!existsSync(registryFile)) {
    return [];
  }

  try {
    const registry = JSON.parse(readFileSync(registryFile, 'utf-8'));
    return registry.map(entry => ({
      ...entry,
      isAlive: isProcessAlive(entry.pid),
    }));
  } catch (e) {
    console.error('Failed to read process registry:', e.message);
    return [];
  }
}

// 主函数
function main() {
  const db = new Database(join(projectRoot, 'data/bot.db'), { readonly: true });

  // 1. 查询所有 running 状态的 tasks
  const runningTasks = db.prepare(`
    SELECT
      t.id, t.goal_id, t.description, t.status, t.pipeline_phase,
      t.channel_id, t.dispatched_at,
      g.seq as goal_seq, g.name as goal_name, g.drive_status
    FROM tasks t
    JOIN goals g ON t.goal_id = g.id
    WHERE t.status = 'running'
    ORDER BY t.dispatched_at DESC
  `).all();

  if (runningTasks.length === 0) {
    console.log('✅ 没有 running 状态的任务');
    db.close();
    return;
  }

  console.log(`\n🔍 发现 ${runningTasks.length} 个 running 状态的任务\n`);

  // 2. 检查 active processes registry
  const activeProcesses = checkActiveProcesses();
  const activeChannels = new Set(activeProcesses.map(p => p.channelId));

  // 3. 分析每个 running task
  runningTasks.forEach((task, idx) => {
    console.log(`\n--- Task #${idx + 1} ---`);
    console.log(`Goal: #${task.goal_seq} ${task.goal_name}`);
    console.log(`Task: ${task.id} - ${task.description}`);
    console.log(`Pipeline 阶段: ${task.pipeline_phase || 'N/A'}`);
    console.log(`Channel ID: ${task.channel_id || 'N/A'}`);

    const runtimeMinutes = task.dispatched_at
      ? Math.floor((Date.now() - task.dispatched_at) / 1000 / 60)
      : 0;
    console.log(`运行时长: ${runtimeMinutes} 分钟`);

    // 检查是否有活跃进程
    if (task.channel_id && activeChannels.has(task.channel_id)) {
      const proc = activeProcesses.find(p => p.channelId === task.channel_id);
      console.log(`\n✅ Claude 进程正在运行:`);
      console.log(`   PID: ${proc.pid}`);
      console.log(`   存活: ${proc.isAlive ? 'Yes' : 'No'}`);
      console.log(`   Lock Key: ${proc.lockKey}`);

      if (!proc.isAlive) {
        console.log(`   ⚠️  警告: 进程已死亡但状态未更新!`);
      }
    } else {
      console.log(`\n❌ 没有活跃的 Claude 进程`);
      console.log(`   ⚠️  警告: 任务状态为 running，但 Claude 进程不存在!`);
      console.log(`   建议: 手动检查或重启 Bot`);
    }
  });

  // 4. 总结
  console.log(`\n\n=== 总结 ===`);
  const zombieTasks = runningTasks.filter(t =>
    !t.channel_id || !activeChannels.has(t.channel_id)
  );

  if (zombieTasks.length > 0) {
    console.log(`\n⚠️  发现 ${zombieTasks.length} 个僵尸任务（状态 running 但无活跃进程）:`);
    zombieTasks.forEach(t => {
      console.log(`   - Goal #${t.goal_seq} / Task ${t.id}: ${t.description}`);
    });
    console.log(`\n建议操作:`);
    console.log(`1. 重启 Bot: systemctl --user restart claude-discord.service`);
    console.log(`2. 手动修复状态（参考 check-running-tasks.mjs）`);
  } else {
    console.log(`\n✅ 所有 running 任务都有对应的活跃 Claude 进程`);
  }

  // 5. 显示活跃进程信息
  if (activeProcesses.length > 0) {
    console.log(`\n\n=== 活跃的 Claude 进程 (共 ${activeProcesses.length} 个) ===`);
    activeProcesses.forEach(proc => {
      console.log(`\nPID: ${proc.pid} | ${proc.isAlive ? '✅ Alive' : '❌ Dead'}`);
      console.log(`  Channel: ${proc.channelId}`);
      console.log(`  Lock Key: ${proc.lockKey}`);
      console.log(`  Session: ${proc.claudeSessionId || 'N/A'}`);
      console.log(`  Output: ${proc.outputFile}`);
    });
  }

  db.close();
}

main();
