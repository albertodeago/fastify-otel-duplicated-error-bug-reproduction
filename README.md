# Fastify OpenTelemetry duplicate-exception reproduction

One synthetic Fastify handler throws one `Error`. `@fastify/otel` records it on both the **handler** span and its parent **request** span.

This project proves duplicate **exception events**, not duplicate HTTP requests or SERVER spans. It does not reproduce any particular backend's error-document conversion.

## Requirements

- Node.js 24 or newer (`.nvmrc` selects 24).
- npm.
- Optional: Docker with Compose for the local Jaeger UI.

Verified with Node.js **24.21.0**, Fastify **5.12.5**, `@fastify/otel` **0.21.2**, and Jaeger **2.22.0**. Dependencies are pinned in `package-lock.json`.

## Reproduce without Docker

```sh
npm ci
npm run repro
```

The command configures tracing before loading Fastify, calls `/failure` once using Fastify's in-process `inject()`, then prints the exported exception events. No HTTP server is opened and no spans leave the process.

Expected summary:

```json
{
  "statusCode": 500,
  "thrownErrors": 1,
  "exceptionEvents": 2,
  "sameTrace": true,
  "sameStack": true
}
```

The two events are on `handler - failure` and `request`, with the same newly generated trace ID. The handler's parent ID equals the request span's ID.

**`npm run repro` exits 0 when the current bug is reproduced.** It asserts the two events, their parent/child relationship, and matching synthetic exception metadata.

To assert the desired single-occurrence behavior instead:

```sh
npm run verify:single
```

**This command intentionally exits 1 while the bug exists**, reporting `2 !== 1`. It should pass once automatic recording emits only one event for this throw.

## See both events in local Jaeger

Prometheus is for metrics; Jaeger lets us inspect the actual span events.

```sh
npm run jaeger:up
npm run repro:jaeger
```

The command prints a direct trace link. Open it, or visit **http://127.0.0.1:16686**, select `fastify-otel-bug-repro`, and search for traces.

Expand both `handler - failure` and `request`, then inspect their **Logs / Events**. Each has an `exception` event containing:

- `exception.type`: `Error`
- `exception.message`: `synthetic failure`
- The same synthetic `exception.stacktrace`.

Re-run `npm run repro:jaeger` to generate another independent synthetic trace. There is no live application server or curl request to configure.

Jaeger stores traces in memory; they disappear when it stops:

```sh
npm run jaeger:down
```

Only the UI (`16686`) and OTLP/HTTP receiver (`4318`) are published, both on `127.0.0.1`. No hosted tracing service or credentials are needed. If export fails, check that Docker is running and these ports are available. Wait for Jaeger's UI to respond before retrying.

### Optional: Jaeger without Docker

The same configuration works with the standalone Jaeger **2.22.0** binary from its [official release](https://github.com/jaegertracing/jaeger/releases/tag/v2.22.0). Download the binary for your OS/architecture and verify its published checksum, then run:

```sh
jaeger --config=jaeger.yaml \
  --set=receivers.otlp.protocols.http.endpoint=127.0.0.1:4318 \
  --set=extensions.jaeger_query.http.endpoint=127.0.0.1:16686
```

In another terminal, run `npm run repro:jaeger`. Stop the binary with Ctrl+C. Do not run it alongside the Compose instance on the same ports.

## Why it happens

In the pinned upstream source, the [handler wrapper](https://github.com/fastify/otel/blob/a7894895684282b1c29f81fe795e03a524a72930/index.js#L697-L722) records the exception and propagates the error. The [internal onError hook](https://github.com/fastify/otel/blob/a7894895684282b1c29f81fe795e03a524a72930/index.js#L500-L515) records it again on the request span.

The application has no manual `recordException()` call, custom error handler, additional instrumentation, or logger. Jaeger is optional and does not cause the duplication.
