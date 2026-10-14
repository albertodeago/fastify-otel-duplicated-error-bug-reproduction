'use strict';

// The exporter merges environment headers even when headers: {} is supplied.
// Ignore ambient telemetry/debug settings before imports. No user requests are accepted.
for (const key of Object.keys(process.env)) {
  if (key.startsWith('OTEL_') || ['DEBUG', 'NODE_DEBUG', 'NODE_DEBUG_NATIVE'].includes(key)) {
    delete process.env[key];
  }
}

const assert = require('node:assert/strict');
const { resourceFromAttributes } = require('@opentelemetry/resources');
const { NodeTracerProvider } = require('@opentelemetry/sdk-trace-node');
const { InMemorySpanExporter, SimpleSpanProcessor } = require('@opentelemetry/sdk-trace-base');
const FastifyOtelInstrumentation = require('@fastify/otel');

const args = new Set(process.argv.slice(2));
for (const arg of args) {
  if (!['--jaeger', '--expect-single'].includes(arg)) {
    console.error('Unknown option. Use --jaeger or --expect-single.');
    process.exit(1);
  }
}

const memory = new InMemorySpanExporter();
const processors = [new SimpleSpanProcessor(memory)];
let exportError = false;

if (args.has('--jaeger')) {
  const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');
  const exporter = new OTLPTraceExporter({
    url: 'http://127.0.0.1:4318/v1/traces',
    headers: {},
    timeoutMillis: 3000,
  });
  // Capture export failure without printing transport errors or environment details.
  processors.push(new SimpleSpanProcessor({
    export(spans, done) {
      exporter.export(spans, result => {
        if (result.code !== 0) exportError = true;
        done({ code: result.code });
      });
    },
    shutdown: () => exporter.shutdown(),
  }));
}

// No NodeSDK/resource detectors: no hostname, process, Kubernetes or company metadata.
const provider = new NodeTracerProvider({
  resource: resourceFromAttributes({ 'service.name': 'fastify-otel-bug-repro' }),
  spanProcessors: processors,
});
provider.register();
const instrumentation = new FastifyOtelInstrumentation({
  registerOnInitialization: true,
  recordExceptions: true,
});
instrumentation.setTracerProvider(provider);

// Configure instrumentation before importing Fastify. No other instrumentation is needed.
const Fastify = require('fastify');
const app = Fastify({ logger: false });
let throws = 0;

app.get('/failure', async function failure() {
  throws += 1;
  const error = new Error('synthetic failure');
  // Only replace stack metadata, not error flow. Never export real local filesystem paths.
  error.stack = 'Error: synthetic failure\n    at failure (/synthetic/repro.cjs:1:1)';
  throw error;
});

function report(statusCode) {
  const spans = memory.getFinishedSpans();
  const exceptions = spans.flatMap(span =>
    span.events.filter(event => event.name === 'exception').map(event => ({ span, event }))
  );
  for (const span of spans) {
    assert.deepEqual(span.resource.attributes, { 'service.name': 'fastify-otel-bug-repro' });
  }
  const stacks = exceptions.map(({ event }) => event.attributes['exception.stacktrace']);
  assert.ok(stacks.every(stack => stack === 'Error: synthetic failure\n    at failure (/synthetic/repro.cjs:1:1)'));
  const traceIds = new Set(exceptions.map(({ span }) => span.spanContext().traceId));
  const summary = {
    versions: {
      node: process.version,
      fastify: require('fastify/package.json').version,
      fastifyOtel: require('@fastify/otel/package.json').version,
    },
    statusCode,
    thrownErrors: throws,
    exceptionEvents: exceptions.length,
    sameTrace: exceptions.length > 0 && traceIds.size === 1,
    sameStack: stacks.length > 0 && stacks.every(stack => stack === stacks[0]),
    events: exceptions.map(({ span, event }) => ({
      span: span.name,
      traceId: span.spanContext().traceId,
      spanId: span.spanContext().spanId,
      parentSpanId: span.parentSpanContext?.spanId ?? null,
      exceptionType: event.attributes['exception.type'],
      exceptionMessage: event.attributes['exception.message'],
    })),
  };
  console.log(JSON.stringify(summary, null, 2));
  return { summary, exceptions };
}

async function main() {
  try {
    const response = await app.inject({ method: 'GET', url: '/failure' });
    await app.close();
    await provider.forceFlush();
    const { summary, exceptions } = report(response.statusCode);
    if (args.has('--jaeger')) {
      if (exportError) throw new Error('Local Jaeger export failed. Start Jaeger on 127.0.0.1:4318.');
      console.log(`Jaeger trace: http://127.0.0.1:16686/trace/${summary.events[0]?.traceId}`);
    }
    assert.equal(response.statusCode, 500);
    assert.equal(throws, 1);
    if (args.has('--expect-single')) {
      assert.equal(exceptions.length, 1, 'One thrown Error should produce one exception event');
    } else {
      // Green means the CURRENT bug was reproduced, not that the bug is fixed.
      assert.equal(exceptions.length, 2, 'Expected the current duplicate-recording behavior');
      assert.equal(summary.sameTrace, true);
      assert.equal(summary.sameStack, true);
      for (const event of summary.events) {
        assert.equal(event.exceptionType, 'Error');
        assert.equal(event.exceptionMessage, 'synthetic failure');
      }
      assert.deepEqual(summary.events.map(event => event.span).sort(), ['handler - failure', 'request']);
      const handler = summary.events.find(event => event.span === 'handler - failure');
      const request = summary.events.find(event => event.span === 'request');
      assert.equal(handler.parentSpanId, request.spanId);
      console.log('REPRODUCED: one thrown Error generated two exception events.');
    }
  } finally {
    await provider.shutdown();
    instrumentation.disable();
  }
}

main().catch(error => {
  // No real stack/path output, even when the assertion intentionally fails.
  console.error(error.message);
  process.exitCode = 1;
});
