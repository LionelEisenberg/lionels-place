#!/bin/bash
# Restore .claude.json from backup if missing (suppresses CLI warning / stale-auth issues)
if [ ! -f /root/.claude.json ] && ls /root/.claude/backups/.claude.json.backup.* 1>/dev/null 2>&1; then
  cp "$(ls -t /root/.claude/backups/.claude.json.backup.* | head -1)" /root/.claude.json
fi
exec "$@"
