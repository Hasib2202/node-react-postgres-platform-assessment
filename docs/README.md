# Evidence

Add the screenshots here after running the stack (file names referenced from the main README):

| File | How to capture |
|---|---|
| `kubectl-get-all-dev.png` | `kubectl get all -n dev` |
| `app-node-react-local.png` | browser at http://node-react.local |
| `grafana-backend-overview.png` | Grafana → Platform → Backend Overview (run `./scripts/load-test.sh hpa` first so replicas move) |
| `loki-queries.png` | Grafana → Explore → Loki: `{namespace="dev", app="backend"} \| json \| level="error"` |
| `rate-limit.png` | output of `./scripts/load-test.sh ratelimit` |
| `github-actions-run.png` | Actions tab, a green `ci-cd` run |
