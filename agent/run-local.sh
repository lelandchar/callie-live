#!/usr/bin/env bash
# Run Grace's agent on this Mac (it registers with LiveKit Cloud as "callie-customer").
# Usage: ./run-local.sh          start in the background, log to agent.log
#        ./run-local.sh stop     stop it
cd "$(dirname "$0")"
if [ -f .agent.pid ] && kill -0 "$(cat .agent.pid)" 2>/dev/null; then
  kill "$(cat .agent.pid)"; sleep 2
fi
rm -f .agent.pid
[ "$1" = "stop" ] && exit 0
[ -d .venv ] || uv sync -q
# A laptop is busy during a demo (browser, Zoom); accept calls regardless of CPU load.
CALLIE_AGENT_LOAD_THRESHOLD="${CALLIE_AGENT_LOAD_THRESHOLD:-2}" nohup .venv/bin/python agent.py start > agent.log 2>&1 &
echo $! > .agent.pid
echo "Grace's agent is starting (pid $(cat .agent.pid)); log: agent/agent.log"
