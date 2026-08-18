# nx-cache-server Helm chart

Helm chart for deploying [nx-cache-server](https://github.com/IKatsuba/nx-cache-server)
— a self-hosted Nx remote cache backed by S3-compatible storage — to Kubernetes.

## Install

Charts are published as OCI artifacts to GHCR.

```bash
helm install nx-cache oci://ghcr.io/ikatsuba/charts/nx-cache-server \
  --version 0.1.0 \
  --namespace nx-cache --create-namespace \
  --set secrets.nxCacheAccessToken=<token> \
  --set secrets.awsAccessKeyId=<key> \
  --set secrets.awsSecretAccessKey=<secret> \
  --set config.s3.bucketName=nx-cloud \
  --set config.s3.endpointUrl=https://s3.amazonaws.com
```

## Using an externally managed Secret

Create a Secret with the three required keys and reference it via
`secrets.existingSecret`:

```bash
kubectl create secret generic nx-cache-creds \
  --from-literal=nx-cache-access-token=<token> \
  --from-literal=aws-access-key-id=<key> \
  --from-literal=aws-secret-access-key=<secret>

helm install nx-cache oci://ghcr.io/ikatsuba/charts/nx-cache-server \
  --version 0.1.0 \
  --set secrets.existingSecret=nx-cache-creds \
  --set config.s3.endpointUrl=https://s3.amazonaws.com
```

## IRSA / Workload Identity (no static AWS keys)

Set `secrets.staticAwsCredentials: false` and annotate the ServiceAccount. The
AWS key env vars are then omitted from the pod entirely, so the AWS SDK falls
through to its default credential chain and picks up the projected web-identity
token. With IRSA on EKS:

```yaml
serviceAccount:
  annotations:
    eks.amazonaws.com/role-arn: arn:aws:iam::123456789012:role/nx-cache-server

secrets:
  staticAwsCredentials: false
  existingSecret: nx-cache-token-only  # holding only nx-cache-access-token
```

The Secret then only needs `nx-cache-access-token`. Do not set the AWS keys to
empty strings instead: empty credentials are still an explicit credentials
object, so the SDK signs with them and S3 rejects the request with a 400.

## Serving over HTTPS

TLS is usually terminated at the Ingress. If you instead want the pod itself to
serve HTTPS, point `tls.secretName` at an existing `kubernetes.io/tls` Secret
(e.g. one issued by cert-manager) and enable TLS. The cert/key are mounted
read-only and the probes switch to the HTTPS scheme automatically.

```bash
helm install nx-cache oci://ghcr.io/ikatsuba/charts/nx-cache-server \
  --set config.s3.endpointUrl=https://s3.amazonaws.com \
  --set tls.enabled=true \
  --set tls.secretName=nx-cache-tls
```

> **Certificate rotation.** The server reads the cert/key once at startup, so a
> renewed certificate is not picked up until the pod restarts. When cert-manager
> rotates the Secret, trigger a rollout (`kubectl rollout restart deployment/...`)
> or use a controller such as [Reloader](https://github.com/stakater/Reloader) to
> restart the pods automatically.

## Values

| Key | Default | Description |
| --- | --- | --- |
| `image.repository` | `ghcr.io/ikatsuba/nx-cache-server` | Container image |
| `image.tag` | `""` (Chart.AppVersion) | Image tag |
| `image.pullPolicy` | `IfNotPresent` | |
| `imagePullSecrets` | `[]` | |
| `replicaCount` | `1` | |
| `service.type` | `ClusterIP` | |
| `service.port` | `3000` | |
| `serviceAccount.create` | `true` | |
| `serviceAccount.name` | `""` | |
| `serviceAccount.annotations` | `{}` | IRSA / Workload Identity annotations |
| `probes.liveness.enabled` | `true` | Liveness probe on `/health` |
| `probes.readiness.enabled` | `true` | Readiness probe on `/health` |
| `config.port` | `3000` | Container `PORT` |
| `config.awsRegion` | `us-east-1` | `AWS_REGION` |
| `config.s3.bucketName` | `nx-cloud` | `S3_BUCKET_NAME` |
| `config.s3.endpointUrl` | `""` | **Required.** `S3_ENDPOINT_URL` |
| `secrets.existingSecret` | `""` | If set, skip Secret creation and use this one |
| `secrets.nxCacheAccessToken` | `""` | Required if `existingSecret` is empty |
| `secrets.staticAwsCredentials` | `true` | Mount `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`. Set `false` for IRSA / Workload Identity |
| `secrets.awsAccessKeyId` | `""` | Required if `existingSecret` is empty and `staticAwsCredentials` is `true` |
| `secrets.awsSecretAccessKey` | `""` | Required if `existingSecret` is empty and `staticAwsCredentials` is `true` |
| `tls.enabled` | `false` | Serve over HTTPS using a mounted cert/key |
| `tls.secretName` | `""` | Existing Secret holding the PEM cert/key. Required when `tls.enabled` |
| `tls.certKey` | `tls.crt` | Key in the Secret holding the PEM cert |
| `tls.keyKey` | `tls.key` | Key in the Secret holding the PEM key |
| `tls.mountPath` | `/etc/nx-cache-server/tls` | Mount path for the cert/key |
| `extraEnv` | `[]` | Extra env vars appended to the container |
| `resources` | `{}` | |
| `nodeSelector` | `{}` | |
| `tolerations` | `[]` | |
| `affinity` | `{}` | |
| `podAnnotations` | `{}` | |
| `podLabels` | `{}` | |
| `podSecurityContext` | `{}` | |
| `securityContext` | `{}` | |

When using `secrets.existingSecret`, the Secret must contain
`nx-cache-access-token`, plus `aws-access-key-id` and `aws-secret-access-key`
unless `secrets.staticAwsCredentials` is `false`.
