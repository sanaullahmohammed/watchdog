import { randomUUID } from 'node:crypto';
import { assertTransition } from '@/modules/incident/domain/incident.state-machine';
import type {
  IncidentImpact,
  IncidentStatus,
} from '@/modules/incident/domain/incident.types';

export interface CreateIncidentProps {
  title: string;
  impact: IncidentImpact;
  affectedServices?: { serviceId: string; impact: IncidentImpact }[];
  startedAt?: Date;
}

export interface UpdateIncidentProps {
  title?: string;
  impact?: IncidentImpact;
}

export interface IncidentEntity {
  id: string;
  orgId: string;
  title: string;
  status: IncidentStatus;
  impact: IncidentImpact;
  startedAt: Date;
  resolvedAt: Date | null;
  createdByUserId: string | null;
  originMonitorId: string | null;
  source: 'manual' | 'monitoring' | 'ai_assisted';
  createdAt: Date;
  updatedAt: Date;
  affectedServices: { serviceId: string; impact: IncidentImpact }[];
}

export default function incidentDomain() {
  return {
    declareIncident: (
      orgId: string,
      createdByUserId: string | null,
      create: CreateIncidentProps,
    ): IncidentEntity => {
      const now = new Date();

      // DOMAIN.md allows exactly two starting statuses: `draft` for a
      // monitor-born incident and `investigating` for a declared one. Running
      // it through the state machine means the rule is enforced in one place
      // rather than assumed here.
      const status: IncidentStatus = 'investigating';
      assertTransition(null, status);

      return {
        id: randomUUID(),
        orgId,
        title: create.title,
        status,
        impact: create.impact,
        startedAt: create.startedAt ?? now,
        resolvedAt: null,
        createdByUserId,
        originMonitorId: null,
        source: 'manual',
        createdAt: now,
        updatedAt: now,
        affectedServices: create.affectedServices ?? [],
      };
    },
  };
}
