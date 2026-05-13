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

Annotate the ServiceAccount so the pod uses cloud-native credentials. With
IRSA on EKS:

```yaml
serviceAccount:
  annotations:
    eks.amazonaws.com/role-arn: arn:aws:iam::123456789012:role/nx-cache-server

secrets:
  existingSecret: nx-cache-token-only  # holding only nx-cache-access-token
```

When using IRSA you still need `aws-access-key-id` / `aws-secret-access-key`
keys in the Secret because the server reads them from env vars. To opt fully
out of static keys, fork the chart or set them to empty placeholders if your
S3 client picks up the IAM role from the metadata service.

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
| `secrets.awsAccessKeyId` | `""` | Required if `existingSecret` is empty |
| `secrets.awsSecretAccessKey` | `""` | Required if `existingSecret` is empty |
| `extraEnv` | `[]` | Extra env vars appended to the container |
| `resources` | `{}` | |
| `nodeSelector` | `{}` | |
| `tolerations` | `[]` | |
| `affinity` | `{}` | |
| `podAnnotations` | `{}` | |
| `podLabels` | `{}` | |
| `podSecurityContext` | `{}` | |
| `securityContext` | `{}` | |

When using `secrets.existingSecret`, the Secret must contain the keys
`nx-cache-access-token`, `aws-access-key-id`, `aws-secret-access-key`.
