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
  originFailureEpisode: number | null;
  source: 'manual' | 'monitoring' | 'ai_assisted';
  createdAt: Date;
  updatedAt: Date;
  affectedServices: { serviceId: string; impact: IncidentImpact }[];
}

export interface ProposeDraftProps {
  monitorId: string;
  serviceId: string;
  monitorName: string;
  failureEpisode: number;
}

export default function incidentDomain() {
  return {
    /**
     * A monitor-born draft: the other starting status DOMAIN.md allows. It has
     * no author, and it is `critical` on the monitor's service until a human
     * says otherwise.
     */
    proposeDraft: (orgId: string, props: ProposeDraftProps): IncidentEntity => {
      const now = new Date();
      const status: IncidentStatus = 'draft';
      assertTransition(null, status);

      return {
        id: randomUUID(),
        orgId,
        title: `Monitor failure: ${props.monitorName}`,
        status,
        impact: 'critical',
        startedAt: now,
        resolvedAt: null,
        createdByUserId: null,
        originMonitorId: props.monitorId,
        originFailureEpisode: props.failureEpisode,
        source: 'monitoring',
        createdAt: now,
        updatedAt: now,
        affectedServices: [{ serviceId: props.serviceId, impact: 'critical' }],
      };
    },

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
        originFailureEpisode: null,
        source: 'manual',
        createdAt: now,
        updatedAt: now,
        affectedServices: create.affectedServices ?? [],
      };
    },
  };
}
