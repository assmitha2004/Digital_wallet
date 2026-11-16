// Prometheus metrics, read from GET /api/metrics by a monitoring system (Prometheus, Grafana Agent...).
import client from 'prom-client';

export const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry, prefix: 'payledger_' }); // CPU, memory, event-loop lag

export const httpDuration = new client.Histogram({
  name: 'payledger_http_request_duration_seconds',
  help: 'HTTP request duration, by route pattern and status code',
  labelNames: ['method', 'route', 'status'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [registry],
});

export const paymentsTotal = new client.Counter({
  name: 'payledger_payments_total',
  help: 'Money-moving requests processed (replays not counted), by kind and outcome',
  labelNames: ['kind', 'outcome'],
  registers: [registry],
});

/**
 * Times every request. The label is the route PATTERN ("/transactions/:id/refunds"), never the
 * raw URL, so ids do not create millions of label values.
 */
export function metricsMiddleware(req, res, next) {
  const end = httpDuration.startTimer({ method: req.method });
  res.on('finish', () => {
    const route = req.route?.path ? `${req.baseUrl}${req.route.path}` : 'unmatched';
    end({ route, status: res.statusCode });
  });
  next();
}
