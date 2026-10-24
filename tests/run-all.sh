#!/bin/sh
# Runs every headless suite against docs/ with real food photos. Usage: sh tests/run-all.sh
IMGDIR="${PLATE_IMGS:-C:/Users/Perry/Desktop/PersonalProjects/calorie-tracker/data/images}"
set -- $(ls "$IMGDIR"/*.jpg | head -4)
cd "$(dirname "$0")"
status=0
for t in *.cjs; do
  echo "== $t"
  out=$(node "$t" "$@" 2>&1); code=$?
  echo "$out" | grep -E "^(FAIL|[0-9]+ passed|.*passed)" ; echo "$out" | grep -c "^PASS" | sed 's/^/PASS count: /'
  if [ $code -ne 0 ] || echo "$out" | grep -q "^FAIL"; then status=1; echo "$out" | tail -20; fi
done
exit $status
