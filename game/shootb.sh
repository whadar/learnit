#!/bin/sh
S=/tmp/claude-0/-home-user-learnit/8f6205af-22db-552b-aca3-2d3962bb4285/scratchpad
G=/home/user/learnit/game
[ -f $S/vite.pid ] && kill "$(cat $S/vite.pid)" 2>/dev/null
sleep 1
rm -rf $S/snap/src $S/snap/preview
cp -r $G/src $G/preview $S/snap/
setsid $S/serve.sh &
n=0; while [ $n -lt 40 ]; do
  code=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:5203/preview/buildings.html)
  [ "$code" = "200" ] && break
  n=$((n+1)); sleep 1
done
[ "$code" = "200" ] || { echo "server did not come up"; exit 1; }
V="$1"; O="${2:-shots/buildings}"; W="${3:-40}"
i=0
while [ $i -lt 3 ]; do
  i=$((i+1))
  if SHOOT_URL=http://127.0.0.1:5203/preview/buildings.html SHOOT_OUT="$O" SHOOT_VIEWS="$V" SHOOT_WARM="$W" node $G/tools/shoot.mjs > $S/shoot.out 2>&1; then
    tail -6 $S/shoot.out; exit 0
  fi
  echo "attempt $i failed:"; tail -4 $S/shoot.out
  sleep 3
done
exit 1
