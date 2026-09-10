/** The status ladder from DOMAIN.md. Ordered worst-last by SERVICE_STATUS_RANK. */
export const SERVICE_STATUSES = [
  'operational',
  'degraded',
  'partial_outage',
  'major_outage',
  'maintenance',
] as const;

export type ServiceStatus = (typeof SERVICE_STATUSES)[number];

/** What a caller supplies to create a service. `orgId` is never among them. */
export interface CreateServiceProps {
  name: string;
  slug: string;
  description?: string | null;
  isPublic?: boolean;
  displayOrder?: number;
  serviceGroupId?: string | null;
}

/** The mutable subset. Absent keys are left alone rather than nulled. */
export interface UpdateServiceProps {
  name?: string;
  description?: string | null;
  isPublic?: boolean;
  displayOrder?: number;
  serviceGroupId?: string | null;
}

export interface ServiceEntity {
  id: string;
  orgId: string;
  serviceGroupId: string | null;
  name: string;
  slug: string;
  description: string | null;
  manualStatusOverride: ServiceStatus | null;
  isPublic: boolean;
  displayOrder: number;
  archivedAt: Date | null;
  lastKnownStatus: ServiceStatus;
  createdAt: Date;
  updatedAt: Date;
}
