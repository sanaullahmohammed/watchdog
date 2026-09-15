// The ladder lives in shared/domain: the public status payload names it too,
// and modules may not import one another. Re-exported so every caller here
// keeps importing it from the module that owns services.
import type { ServiceStatus } from '@/shared/domain/status-inputs';

export {
  SERVICE_STATUSES,
  type ServiceStatus,
} from '@/shared/domain/status-inputs';

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
