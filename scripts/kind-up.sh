#!/usr/bin/env bash
# One-command local Kubernetes environment:  ./scripts/kind-up.sh
# Creates a kind cluster, installs ingress-nginx + metrics-server, builds and loads
# the images, deploys the app (namespace `dev`) and the observability stack
# (namespace `monitoring`).
set -euo pipefail

CLUSTER="${CLUSTER:-platform}"
INGRESS_VERSION="controller-v1.11.2"
METRICS_SERVER_VERSION="v0.7.2"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

for bin in docker kind kubectl; do
  command -v "$bin" >/dev/null || { echo "missing prerequisite: $bin" >&2; exit 1; }
done

echo "==> 1/7 kind cluster '$CLUSTER'"
if ! kind get clusters | grep -qx "$CLUSTER"; then
  kind create cluster --name "$CLUSTER" --config k8s/kind-config.yaml
fi
kubectl config use-context "kind-$CLUSTER" >/dev/null

echo "==> 2/7 ingress-nginx ($INGRESS_VERSION)"
kubectl apply -f "https://raw.githubusercontent.com/kubernetes/ingress-nginx/${INGRESS_VERSION}/deploy/static/provider/kind/deploy.yaml"
# Rate-limited requests should answer 429 (default is 503).
kubectl -n ingress-nginx patch configmap ingress-nginx-controller --type merge \
  -p '{"data":{"limit-req-status-code":"429","limit-conn-status-code":"429"}}'
kubectl -n ingress-nginx wait --for=condition=ready pod \
  -l app.kubernetes.io/component=controller --timeout=180s

echo "==> 3/7 metrics-server ($METRICS_SERVER_VERSION) for the HPA"
kubectl apply -f "https://github.com/kubernetes-sigs/metrics-server/releases/download/${METRICS_SERVER_VERSION}/components.yaml"
# kind kubelets use self-signed certs.
kubectl -n kube-system patch deployment metrics-server --type json \
  -p '[{"op":"add","path":"/spec/template/spec/containers/0/args/-","value":"--kubelet-insecure-tls"}]' || true

echo "==> 4/7 build + load images"
docker build -f Dockerfile.backend  -t platform-backend:dev  .
docker build -f Dockerfile.frontend -t platform-frontend:dev .
kind load docker-image platform-backend:dev platform-frontend:dev --name "$CLUSTER"

echo "==> 5/7 application (namespace dev)"
kubectl apply -f k8s/namespace-dev.yaml
kubectl apply -f k8s/app-secrets.yaml          # dev-only secret, not in kustomization
kubectl apply -k k8s
kubectl -n dev rollout status deployment/postgres  --timeout=180s
kubectl -n dev rollout status deployment/backend   --timeout=180s
kubectl -n dev rollout status deployment/frontend  --timeout=180s

echo "==> 6/7 observability (namespace monitoring)"
kubectl apply -f observability/namespace-monitoring.yaml
if ! kubectl -n monitoring get secret grafana-admin >/dev/null 2>&1; then
  GRAFANA_PASSWORD="$(head -c 18 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 16)"
  kubectl -n monitoring create secret generic grafana-admin \
    --from-literal=user=admin --from-literal=password="$GRAFANA_PASSWORD"
  echo "    Grafana login: admin / $GRAFANA_PASSWORD   (stored in secret monitoring/grafana-admin)"
fi
kubectl -n monitoring create configmap grafana-dashboards \
  --from-file=observability/dashboards/ --dry-run=client -o yaml | kubectl apply -f -
kubectl apply -f observability/kube-state-metrics.yaml
kubectl apply -f observability/prometheus.yaml
kubectl apply -f observability/loki.yaml
kubectl apply -f observability/fluentbit-daemonset.yaml
kubectl apply -f observability/grafana.yaml

echo "==> 7/7 done"
cat <<'EOF'

Add this line to your hosts file (Windows: C:\Windows\System32\drivers\etc\hosts, run as admin):
    127.0.0.1 node-react.local

Then open:   http://node-react.local
Grafana:     kubectl -n monitoring port-forward svc/grafana 3000:3000   -> http://localhost:3000
Prometheus:  kubectl -n monitoring port-forward svc/prometheus 9090:9090
Status:      kubectl get all -n dev
EOF
