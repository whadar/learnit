#!/bin/sh
V="$1"; O="${2:-shots/buildings}"; W="${3:-40}"
i=0
while [ $i -lt 8 ]; do
  i=$((i+1))
  if SHOOT_URL=http://127.0.0.1:5203/preview/buildings.html SHOOT_OUT="$O" SHOOT_VIEWS="$V" SHOOT_WARM="$W" node tools/shoot.mjs > /tmp/claude-0/-home-user-learnit/8f6205af-22db-552b-aca3-2d3962bb4285/scratchpad/shoot.out 2>&1; then
    tail -20 /tmp/claude-0/-home-user-learnit/8f6205af-22db-552b-aca3-2d3962bb4285/scratchpad/shoot.out; exit 0
  fi
  echo "attempt $i failed:"; tail -6 /tmp/claude-0/-home-user-learnit/8f6205af-22db-552b-aca3-2d3962bb4285/scratchpad/shoot.out
  sleep 4
done
exit 1
