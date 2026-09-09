import { check } from 'k6';
import http from 'k6/http';

// Smoke: prove the service answers under trivial load. CI gate, not a benchmark.
export const options = {
  vus: 1,
  duration: '10s',
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<500'],
  },
};

const BASE_URL = __ENV.BASE_URL || 'http://127.0.0.1:3000';
// TODO: confirm against the running app - @gquittet/graceful-server exposes
// /live and /ready; ARCHITECTURE.md 8 currently writes /health.
const HEALTH_PATH = __ENV.HEALTH_PATH || '/live';

export default function () {
  const res = http.get(`${BASE_URL}${HEALTH_PATH}`);
  check(res, { 'status is 200': (r) => r.status === 200 });
}
