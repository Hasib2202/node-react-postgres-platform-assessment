# node-react-postgres-platform-assessment

A small **React + Node.js + PostgreSQL** todo app turned into a production-style platform:
Docker Compose, Kubernetes (kind), Ingress/API gateway, CI/CD with branch-per-environment
deploys, platform services (Redis, BullMQ, OpenSearch, read/write DB split) and an
observability stack (Prometheus, Grafana, Fluent Bit, Loki, HPA, rate limiting).

I built my own app instead of forking the base repo so every piece (health endpoints,
metrics, queue, read/write pools) exists *for a reason* in the platform story.

```
.
├── backend/                 Express API + BullMQ worker (src/app.js, src/worker.js)
├── frontend/                React (Vite) SPA served by unprivileged nginx
├── db/init.sql              schema + seed row
├── Dockerfile.backend       multi-stage, non-root
├── Dockerfile.frontend      multi-stage, non-root, runtime-configurable API URL
├── .dockerignore
├── docker-compose.yml       whole stack, one command
├── k8s/                     manifests for namespace `dev` (+ kustomization.yaml)
├── observability/           Prometheus, Grafana, Loki, Fluent Bit, kube-state-metrics
├── scripts/                 kind-up.sh (one-command cluster), load-test.sh
├── .github/workflows/ci-cd.yml
├── docs/                    screenshots / evidence
└── README.md
```

---

## 1. Prerequisites and one-command startup

### Docker Compose (Task 1 + 5)

Prerequisites: Docker with Compose v2 (about 2 GB free RAM; OpenSearch is the heavy part).

```bash
cp .env.example .env          # set POSTGRES_PASSWORD; .env is git-ignored
docker compose up --build
```

| URL | What |
|---|---|
| http://localhost:3000 | frontend |
| http://localhost:4000/api/health | backend (published for the browser, see note) |

* Postgres, Redis and OpenSearch are **not published** – only reachable on the internal `backend-net` network.
* The data survives restarts: `docker compose down && docker compose up` keeps your todos
  (named volume `pgdata`). `docker compose down -v` wipes it.
* The browser calls the backend directly (`API_BASE_URL=http://localhost:4000/api`), hence
  the `CORS_ORIGIN` setting. In Kubernetes the Ingress makes everything same-origin and CORS is off.

### Kubernetes with kind (Tasks 2, 3, 5, 6)

Prerequisites: Docker, [kind](https://kind.sigs.k8s.io/), kubectl, bash (Git Bash/WSL on Windows).
Free ports 80/443. Allow ~5 GB RAM for Docker.

```bash
./scripts/kind-up.sh
```

The script: creates the kind cluster (`k8s/kind-config.yaml`, maps host 80/443 into the node),
installs ingress-nginx and metrics-server, builds and `kind load`s both images, applies
everything in `k8s/` (namespace `dev`) and `observability/` (namespace `monitoring`),
and prints a random Grafana password.

Then add the hostname (Windows: `C:\Windows\System32\drivers\etc\hosts`, as admin):

```
127.0.0.1 node-react.local
```

→ http://node-react.local

```bash
kubectl get all -n dev
kubectl -n monitoring port-forward svc/grafana 3000:3000        # Grafana
kubectl -n monitoring port-forward svc/prometheus 9090:9090     # Prometheus
kind delete cluster --name platform                             # cleanup
```

> Status note: I authored this on a machine without a running kind cluster. The manifests are
> written to be applied as-is, but check the **Evidence** section of `docs/` for the runs I captured.

---

## 2. Request path and Kubernetes DNS (Task 3)

```
Browser  http://node-react.local/api/todos
   │  DNS (hosts file) node-react.local -> 127.0.0.1
   ▼
kind node :80  (extraPortMappings)          <- host port forwarded into the node container
   ▼
ingress-nginx controller pod                <- watches Ingress objects; this is the "API gateway"
   │  matches host + path:  /api -> backend-service,  / -> frontend-service
   │  applies rate limit (backend-ingress annotations)
   ▼
Service  backend-service (ClusterIP, :80)   <- stable virtual IP + DNS name, load-balances
   │  kube-proxy picks one *ready* endpoint (readiness probe gates membership)
   ▼
Pod  backend-xxxxx (:4000)                  <- Node/Express
   │  DB_READ_URL / DB_WRITE_URL
   ▼
Service  postgres-read-service / postgres-service (ClusterIP, :5432)
   ▼
Pod  postgres-xxxxx  <- data on PVC postgres-pvc -> PV postgres-pv (hostPath)
```

**Ingress vs Service vs Pod**

* **Pod** – ephemeral, IP changes on every restart; never addressed directly.
* **Service** – stable name/virtual IP in front of a *label-selected set* of pods; only ready pods receive traffic. Layer 4.
* **Ingress** – layer-7 routing *rules* (host/path) for HTTP from outside the cluster; it only does something because a controller (ingress-nginx) implements it.

**How DNS resolves services.** CoreDNS (the `kube-dns` Service in `kube-system`) gives every Service an A record:

```
<service>.<namespace>.svc.<cluster-domain>     e.g. backend-service.dev.svc.cluster.local
```

Pods get `search dev.svc.cluster.local svc.cluster.local cluster.local` in `/etc/resolv.conf`, so inside namespace
`dev` the short name `postgres-service` resolves to the same thing. That is why the ConfigMap only contains
short names – and why the *same manifests* work unchanged in `preprod` or `release`. To reach another namespace
use the `<service>.<namespace>` form, e.g. `prometheus.monitoring`.

Verify it yourself:

```bash
kubectl -n dev run dnsutils --rm -it --restart=Never --image=busybox:1.36 -- \
  nslookup backend-service.dev.svc.cluster.local
```

---

## 3. Debugging scenarios (Task 3)

### (a) Ingress is reachable but the backend is not

Symptom: `http://node-react.local/` loads, `/api/*` returns 502/503/404.

Work from the edge inward:

1. **Is the rule there?** `kubectl -n dev describe ingress backend-ingress` – check host/path, backend
   `backend-service:80`, and *Events*. A 404 from nginx (the default backend) = no rule matched
   (wrong host header, wrong path, wrong `ingressClassName`).
2. **Does the Service have endpoints?** `kubectl -n dev get endpoints backend-service`. Empty ⇒ either the
   selector doesn't match the pod labels or **no pod is Ready**. 503 from nginx with no endpoints is the classic sign.
3. **Why aren't pods ready?** `kubectl -n dev get pods -l app=backend`, then `kubectl -n dev describe pod <pod>` (probe failures)
   and `kubectl -n dev logs <pod>`. Here `/api/ready` checks Postgres, so a DB outage shows up as *Ready 0/1* – that is by design.
4. **Bypass the Ingress**: `kubectl -n dev port-forward svc/backend-service 8080:80` then `curl localhost:8080/api/health`.
   Works ⇒ the problem is Ingress config; fails ⇒ the app/Service.
5. **Check the controller**: `kubectl -n ingress-nginx logs deploy/ingress-nginx-controller | tail` – upstream errors
   (`connect() failed`, `no live upstreams`) name the failing endpoint.
6. **Dependencies**: `kubectl -n dev get pods` for postgres, `kubectl -n dev logs deploy/postgres`.

### (b) The frontend cannot talk to the backend

Symptom: page loads, UI shows "API error".

1. **Browser devtools → Network tab.** What URL is it calling? Status? A `config.js` returning an unexpected `API_BASE_URL`
   (it is generated at container start from the ConfigMap) is the #1 culprit: `curl http://node-react.local/config.js`.
   It must be `/api` behind the Ingress.
2. **CORS vs routing.** A red CORS error in the console on Compose means `CORS_ORIGIN` ≠ the page's origin. On Kubernetes
   the call is same-origin, so a CORS error would mean the browser is calling a different host than expected.
3. **Is `/api` routed?** `curl -i -H 'Host: node-react.local' http://127.0.0.1/api/health` – if it returns the SPA's HTML,
   the `/api` Ingress path isn't matching (the frontend Ingress `/` caught it).
4. **Rate limited?** HTTP 429 in the Network tab ⇒ the limiter in `backend-ingress` fired (see §6).
5. **In-cluster DNS / connectivity** (rules out network policy or DNS):
   `kubectl -n dev run t --rm -it --restart=Never --image=busybox:1.36 -- wget -qO- http://backend-service/api/health`
6. Then continue with scenario (a) from step 2.

---

## 4. CI/CD, secrets and rollback (Task 4)

Workflow: [`.github/workflows/ci-cd.yml`](.github/workflows/ci-cd.yml)

| Branch | Namespace / GitHub Environment |
|---|---|
| `master` | `dev` |
| `pre-release/v*` | `preprod` |
| `release/v*` | `release` |

Pipeline: **test** (install backend + frontend deps, run backend tests, build the frontend, render the kustomization) →
**images** (build both Dockerfiles, tag `<branch with / → ->-<short sha>`, e.g. `pre-release-v1.2-3f9c2ab`, push to GHCR) →
**deploy** (kustomize sets namespace + image tags, `kubectl apply`, wait for rollout, **auto `rollout undo` on failure**).
Pull requests run only the test job. Tags are immutable (branch+SHA) – there is no `latest`.

**Secrets.**

* Registry: GHCR is pushed to with the workflow's built-in short-lived `GITHUB_TOKEN` (`packages: write`), so no long-lived registry credential exists.
  For Docker Hub I would add `DOCKERHUB_USERNAME` / `DOCKERHUB_TOKEN` as repo secrets (an access token, never a password).
* Cluster access: a base64 kubeconfig stored as the **environment secret** `KUBE_CONFIG_B64`, one per GitHub Environment
  (`dev`, `preprod`, `release`) so a `dev` job can never see the prod kubeconfig. Use a ServiceAccount-scoped kubeconfig limited to that namespace, not cluster-admin. `release` can have required reviewers (manual approval).
* App secrets: `POSTGRES_USER` / `POSTGRES_PASSWORD` are environment secrets; the job creates the Kubernetes `Secret/app-secrets`
  with `kubectl create secret --dry-run | apply`. `k8s/app-secrets.yaml` (throwaway local values) is deliberately **not** in `kustomization.yaml`.
* Secrets are only referenced as `${{ secrets.X }}` (masked in logs), never echoed, and never baked into images (they are read from env at runtime).
* Better with more time: External Secrets Operator / Sealed Secrets, and OIDC federation to the cloud instead of a static kubeconfig.

**Rollback strategy.**

1. *Automatic*: a failed `rollout status` triggers `kubectl rollout undo` in the pipeline (rolling update with `maxUnavailable: 0` means the old pods kept serving the whole time).
2. *Manual, fast*: `kubectl -n <ns> rollout history deploy/backend` then `kubectl -n <ns> rollout undo deploy/backend [--to-revision=N]`.
3. *Declarative, auditable*: re-run the workflow for an older commit (or `git revert` and push) – the old image tag is still in the registry, so redeploying is just re-applying with that tag.
4. DB migrations must be backward compatible (expand → migrate → contract) so an app rollback never needs a DB rollback.

---

## 5. Platform services, read/write routing (Task 5)

| Service | Compose | Kubernetes | Used for |
|---|---|---|---|
| Redis 7 | `redis` | `redis-deployment/service.yaml` | BullMQ backing store |
| Queue | `worker` | `bullmq-worker-deployment.yaml` | Consumes `todo-created` jobs, writes `processed_at` (shown as “worker ✓” in the UI) |
| Search | OpenSearch 2.15 single-node, security off (dev mode) | `search-deployment/service.yaml` | Health call from `/api/platform/status` |
| DB cluster sim | `DB_WRITE_URL` / `DB_READ_URL` | same, from Secret; separate `postgres-service` and `postgres-read-service` | Two connection pools in the app |

* **Wiring:** all addresses come from environment/ConfigMap. The UI's status pills (`/api/platform/status`) show live connectivity for DB-write, DB-read, Redis and search.
* **Isolation:** all four are `ClusterIP`/unpublished. Only the Ingress is exposed, and it only routes `/` and `/api`; `/metrics` is deliberately **not** reachable from outside.
  With more time: NetworkPolicies (default-deny in `dev`, allow backend→postgres/redis/search only).
* **Graceful degradation:** readiness depends on Postgres only. If Redis/search go down, todos can still be created (enqueue failure is logged, not fatal) and the pod stays in rotation.

**Where read/write routing lives.** I put it in **application code**: two pools (`backend/src/db.js`), reads (`GET /api/todos`) use `reader`, all writes use `writer`.
It's explicit and needs no extra component, but every service must implement it. Alternatives: a DB proxy
(PgBouncer + pgpool-II / **PgCat** / RDS Proxy) which splits by statement type and centralises pooling and failover, or a framework-level replica router. At scale I'd use a proxy for failover/pooling and keep a per-request “force primary” hint in the app.

**Replication lag.** Replicas apply WAL asynchronously, so they trail the primary by milliseconds to seconds (or minutes under load). Implications:

* *Read-your-writes breaks*: after `POST /todos`, an immediate list from a lagging replica may not contain the row. This app avoids the problem for the create path by `RETURNING` the row from the writer instead of re-reading.
* **Always hit the writer for:** every INSERT/UPDATE/DELETE; reads that immediately follow a write by the same user (post-signup/post-payment pages); reads that gate a write (check-then-act: balance, inventory, uniqueness); uniqueness/idempotency checks; the queue worker's read-modify-write (`UPDATE ... processed_at`); anything inside a transaction that writes.
* Replica reads are fine for lists, dashboards, search-like queries, reports – anything tolerant of stale data.
* Operational: monitor `pg_stat_replication` / `replay_lag`; fall back to the primary (or fail readiness of the reader) past a lag threshold; sticky "read from primary for N seconds after a write" is a cheap session-level mitigation.

---

## 6. Observability, scaling, rate limiting (Task 6)

Everything lives in `observability/` (namespace `monitoring`) plus `k8s/hpa-backend.yaml`.

| Component | File | Notes |
|---|---|---|
| Prometheus | `prometheus.yaml` | scrapes backend pods (annotations), ingress-nginx (`:10254`), cAdvisor (container CPU/mem), kube-state-metrics; includes alert rules |
| kube-state-metrics | `kube-state-metrics.yaml` | replica counts, HPA state, restarts |
| Grafana | `grafana.yaml` + `dashboards/backend-overview.json` | provisioned datasources + dashboard: CPU, memory, request rate, error rate, replicas over time, latency, logs |
| Fluent Bit | `fluentbit-daemonset.yaml` | DaemonSet tailing `/var/log/containers/*_dev_*.log`, k8s metadata enrichment, JSON parse |
| Loki | `loki.yaml` | single binary, filesystem storage |
| HPA | `k8s/hpa-backend.yaml` | CPU 60% of request, 2–6 replicas, fast up / slow down |

**Searching logs** (Grafana → Explore → Loki):

```
{namespace="dev", app="backend"}                                  # all backend logs
{namespace="dev", app="backend"} | json | level="error"           # only errors
{namespace="dev", app="backend"} | json | status >= 500
{namespace="dev", app="backend"} | json | msg="request" | path=~"/api/todos.*" | ms > 100
```

The API writes one JSON line per request (`ts, level, method, path, status, ms`), which is what makes label/field filtering cheap.

**Demonstrate scaling and rate limiting**

```bash
./scripts/load-test.sh hpa        # then: kubectl -n dev get hpa backend-hpa -w
./scripts/load-test.sh ratelimit  # prints a histogram of HTTP status codes (200s and 429s)
./scripts/load-test.sh stop
```

**Rate limiting – where and why.** At the ingress (`backend-ingress` annotations), per client IP, API path only:
`limit-rps: 20`, `limit-burst-multiplier: 5` (bursts up to 100), `limit-connections: 30`, status code 429.
Rationale: a single browser tab with polling (this UI polls every 5 s) is ≪ 1 req/s, and a page load fires a handful of calls, so 20 rps/IP leaves
large headroom for real users (and NAT’d offices) but stops a single scripted client from saturating the 2–6 backend pods and the DB.
The limiter sits at the edge so excess traffic never consumes backend CPU. The static frontend is not limited.
Caveats/next steps: per-IP limits are weak behind shared NAT or a CDN (use `X-Forwarded-For`/API-key based limits at that point); in-process limits are
per ingress replica; for per-user/per-key quotas use an API gateway or a Redis-backed limiter.

### Metrics I would alert on, and why

| Alert (see `prometheus.yaml`) | Signal | Why |
|---|---|---|
| **High error rate** – 5xx > 5% for 5 m | `http_requests_total{status=~"5.."}` ratio | Direct user impact; the primary SLO symptom. Ratio, not count, so it scales with traffic. |
| **High latency** – p95 > 500 ms for 10 m | `http_request_duration_seconds` histogram | Slowness usually precedes errors (DB saturation, GC, noisy neighbour). p95 avoids hiding the tail behind averages. |
| **High CPU** – > 80% of limit for 10 m | cAdvisor CPU vs limits | If HPA is at max or too slow, you're about to throttle and add latency. Sustained, to ignore the spikes the HPA handles. |
| **Memory near limit** – > 90% for 10 m | working set vs limit | Predicts OOMKills (a steady climb = leak). |
| **Replicas unavailable** | `kube_deployment_status_replicas_available < spec_replicas` | Lost capacity / failed rollout/ readiness failing (e.g. DB down). |
| **Crash looping** – > 2 restarts in 15 m | `kube_pod_container_status_restarts_total` | Failing liveness, OOMKill or bad release. |
| *Also (not implemented)* | Postgres replication lag, Redis memory/queue depth (BullMQ waiting jobs), ingress 429 rate, disk on PV | Dependency saturation and capacity signals; growing queue depth = the worker is behind. |

Alertmanager (routing to Slack/PagerDuty) is not deployed; rules are evaluated and visible at Prometheus `/alerts`.

---

## 7. Design decisions, trade-offs, and next steps

**Decisions**

* **Own app** rather than the base repo: lets health/readiness, metrics, structured logs, queue and read/write pools exist deliberately.
* **Runtime config for the frontend** (`config.js` generated at container start): one immutable image for every environment; the API URL is an env var as required, without rebuilds.
* **Liveness ≠ readiness.** Liveness never touches dependencies (avoids restart storms); readiness checks Postgres only so Redis/search issues don't remove the API from rotation.
* **Unprivileged containers**: `node` user, `nginx-unprivileged`, dropped capabilities in k8s, no shell secrets in images; `.dockerignore` keeps `.env`, `.git` out of the context.
* **Deployment (not StatefulSet) for Postgres with `Recreate`**: simplest correct choice for a single RWO volume; documented as dev-grade.
* **Kustomize for multi-env**: one set of manifests, namespace and image tag injected by CI instead of copy-pasted overlays.
* **Two Ingress objects** so rate limiting is scoped to `/api`.
* **Observability without Helm**: plain YAML is longer but each component and its config is reviewable in the repo.

**Trade-offs / known limitations**

* The “replica” is the same Postgres instance – the app-side split is real, replication is simulated.
* hostPath PV, `emptyDir` for Prometheus/Loki/OpenSearch: data is lost with the cluster (fine for local).
* Single replicas of Postgres/Redis/OpenSearch are single points of failure; secrets in `app-secrets.yaml` are throwaway dev values.
* No TLS on the local ingress; no NetworkPolicies; Alertmanager not deployed.
* Backend tests are minimal (liveness route); the frontend's “test” is the production build.
* The CI deploy job needs a reachable cluster + `KUBE_CONFIG_B64`; a local kind cluster is not reachable from GitHub-hosted runners (use a self-hosted runner, or point at a cloud cluster). The CI run for the `dev` branch rule is what the evidence screenshot shows when a target exists.

**With more time**

* Real Postgres streaming replication (CloudNativePG / Zalando operator) with PgBouncer; automated backups.
* Helm chart or Argo CD (GitOps) instead of `kubectl apply` in CI; progressive delivery (Argo Rollouts canary with Prometheus analysis).
* Terraform for the cluster + registry + namespaces (optional task skipped).
* cert-manager + TLS, NetworkPolicies, Pod Security Admission `restricted`, image scanning (Trivy) and SBOM in CI, External Secrets.
* Alertmanager + SLO burn-rate alerts; distributed tracing (OpenTelemetry → Tempo).
* Integration tests in CI using a kind cluster (smoke test through the Ingress before promoting).
* Microservice evolution – see below.

### Evolution into microservices behind an API gateway (Task 3 note)

Today one Ingress splits `/` and `/api`. To grow: add a path (or host) per service –
`/api/users → users-service`, `/api/orders → orders-service`, `/api/search → search-service` – each a Deployment with its own Service,
HPA, data store and release cadence. The Ingress (or the Gateway API `HTTPRoute`, or a dedicated gateway such as Kong/Envoy Gateway/APISIX) stays the single public entry point and takes over
cross-cutting concerns: TLS, authentication (JWT validation), per-route/per-consumer rate limits, request IDs and CORS.
Services talk to each other over cluster DNS (`orders-service.dev.svc.cluster.local`), asynchronously where possible via the queue (BullMQ → RabbitMQ/Kafka for durability), with
NetworkPolicies enforcing who may call whom. This repo's worker is already the first step: the same codebase is deployed twice (API + consumer) and scaled independently.
A service mesh (Linkerd/Istio) adds mTLS, retries and per-hop metrics when the number of services justifies it.

---

## Evidence (`docs/`)

See [`docs/README.md`](docs/README.md) for the checklist of screenshots to capture
(`kubectl get all -n dev`, the app at `http://node-react.local`, Grafana, Loki queries, a passing Actions run).
