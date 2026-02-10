#!/bin/bash
# Debug script to check session status

SESSION_NAME="${1:-cw-67551f1d}"

echo "=== Checking tmux session: $SESSION_NAME ==="
echo ""

# 1. Check if session exists
if tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
    echo "✓ Session exists"
else
    echo "✗ Session does not exist"
    exit 1
fi

# 2. Check session info
echo ""
echo "Session info:"
tmux display-message -t "$SESSION_NAME" -p "Created: #{session_created} | Activity: #{session_activity}"

# 3. Check pane status
echo ""
echo "Pane info:"
tmux list-panes -t "$SESSION_NAME" -F "Pane: #{pane_id} | PID: #{pane_pid} | Active: #{pane_active} | Dead: #{pane_dead}"

# 4. Check if any tmux attach process exists for this session
echo ""
echo "Attach processes:"
ps aux | grep "tmux attach.*$SESSION_NAME" | grep -v grep || echo "No attach processes found"

# 5. Get the shell PID in the pane
PANE_PID=$(tmux list-panes -t "$SESSION_NAME" -F "#{pane_pid}" | head -1)
echo ""
echo "Pane shell PID: $PANE_PID"

# 6. Check process tree
if [ -n "$PANE_PID" ]; then
    echo ""
    echo "Process tree:"
    pstree -p -a "$PANE_PID" 2>/dev/null || ps -f --ppid "$PANE_PID" 2>/dev/null

    # 7. Check for suspended processes
    echo ""
    echo "Process states (looking for T=stopped):"
    ps -o pid,stat,command --ppid "$PANE_PID" 2>/dev/null
    ps -o pid,stat,command -p "$PANE_PID" 2>/dev/null
fi

# 8. Capture last output
echo ""
echo "Last 10 lines of output:"
tmux capture-pane -t "$SESSION_NAME" -p -e -S -10 2>/dev/null || echo "Failed to capture pane"
