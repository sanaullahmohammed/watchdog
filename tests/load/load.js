import { check } from 'k6';
import http from 'k6/http';

// Sustained load profile. Kept out of the default CI gate; run on demand.
export const options = {
  stages: [
    { duration: '30s', target: 20 },
    { duration: '1m', target: 20 },
    { duration: '30s', target: 0 },
  ],
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<800'],
  },
};

const BASE_URL = __ENV.BASE_URL || 'http://127.0.0.1:3000';
const HEALTH_PATH = __ENV.HEALTH_PATH || '/live';

export default function () {
  const res = http.get(`${BASE_URL}${HEALTH_PATH}`);
  check(res, { 'status is 200': (r) => r.status === 200 });
}
