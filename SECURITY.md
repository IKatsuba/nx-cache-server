# Security Policy

## Supported versions

Only the latest published release receives security fixes. Images are published
to `ghcr.io/ikatsuba/nx-cache-server`; older tags are not patched.

## Reporting a vulnerability

Please do not open a public issue, a pull request, or a discussion for a
suspected vulnerability.

Report it through
[GitHub private vulnerability reporting](https://github.com/IKatsuba/nx-cache-server/security/advisories/new),
which is enabled for this repository. If that is not available to you, email
<igor@katsuba.dev> instead.

Helpful things to include, as far as you have them:

- what an attacker can do, and what access they need to do it
- the affected image tag, chart version, or commit
- steps to reproduce, or the command output that shows the problem
- any workaround you already found

## What to expect

- An acknowledgement within 5 days.
- An assessment — whether the report is confirmed, and the severity — within 14
  days.
- A fix released before any public disclosure, coordinated with you on timing.
- Credit in the advisory and the release notes, unless you prefer otherwise.

This is a small project maintained in spare time, so these are honest targets
rather than a contractual SLA. If a report goes unanswered past those windows, a
nudge by email is welcome.

## Scope

In scope: this server, its Docker image, the Helm chart in `charts/`, and the
release workflow.

Out of scope: vulnerabilities in Nx itself, in your S3 provider, or in
deployments that expose the server without `NX_CACHE_ACCESS_TOKEN` set.
