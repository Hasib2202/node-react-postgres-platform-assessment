#!/usr/bin/env bash
# Demonstrates (a) the HPA scaling out and (b) ingress rate limiting.
#   ./scripts/load-test.sh hpa        # in-cluster load -> backend scales 2 -> up to 6
#   ./scripts/load-test.sh ratelimit  # burst through the Ingress -> HTTP 429s
#   ./scripts/load-test.sh stop       # remove the load generators
set -euo pipefail

case "${1:-}" in
  hpa)
    # Hits the Service directly (bypasses the ingress limiter) from 6 parallel loops.
    kubectl -n dev run load-gen --image=busybox:1.36 --restart=Never -- /bin/sh -c '
      for i in 1 2 3 4 5 6; do
        ( while true; do wget -q -O /dev/null http://backend-service/api/todos; done ) &
      done; wait'
    echo "Watch scaling with:  kubectl -n dev get hpa backend-hpa -w"
    ;;
  ratelimit)
    # 300 requests as fast as possible through the ingress; limit is 20 rps (+burst).
    for i in $(seq 1 300); do
      curl -s -o /dev/null -w '%{http_code}\n' -H 'Host: node-react.local' http://127.0.0.1/api/health
    done | sort | uniq -c
    ;;
  stop)
    kubectl -n dev delete pod load-gen --ignore-not-found
    ;;
  *)
    echo "usage: $0 {hpa|ratelimit|stop}" >&2; exit 1 ;;
esac
