import type { MonitorEntity } from '@/modules/monitoring/domain/monitor.types';
import type { MonitorResponseDto } from '@/modules/monitoring/dtos/monitor.response.dto';

/**
 * One presenter for both surfaces. `config` always carries both keys, null
 * when absent, so a stored `{}` reads the same over REST and GraphQL.
 */
export function toMonitorResponse(monitor: MonitorEntity): MonitorResponseDto {
  return {
    id: monitor.id,
    serviceId: monitor.serviceId,
    type: monitor.type,
    name: monitor.name,
    target: monitor.target,
    intervalSeconds: monitor.intervalSeconds,
    timeoutSeconds: monitor.timeoutSeconds,
    failureThreshold: monitor.failureThreshold,
    enabled: monitor.enabled,
    config: {
      keyword: monitor.config.keyword ?? null,
      warnDays: monitor.config.warnDays ?? null,
    },
    consecutiveFailures: monitor.consecutiveFailures,
    lastCheckedAt: monitor.lastCheckedAt?.toISOString() ?? null,
  };
}
