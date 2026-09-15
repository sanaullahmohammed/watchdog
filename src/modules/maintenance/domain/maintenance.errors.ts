import {
  ArgumentInvalidException,
  ConflictException,
} from '@/shared/exceptions';

export class InvalidMaintenanceWindowError extends ArgumentInvalidException {
  constructor(start: Date, end: Date) {
    super(
      `A maintenance window must end after it starts; got ${start.toISOString()} to ${end.toISOString()}.`,
    );
  }
}

export class UnknownMaintenanceServiceError extends ArgumentInvalidException {
  constructor(cause?: Error) {
    super(
      'One or more affected services do not exist in this organization.',
      cause,
    );
  }
}

/**
 * Deleting is for work that never happened. These are 409s rather than 400s:
 * the request is well formed, the window is simply in a status that does not
 * allow it. Epic 2 retrospective, R-8.
 */
export class MaintenanceNotDeletableError extends ConflictException {
  constructor(status: string) {
    super(
      `A ${status} window cannot be deleted. Deleting is for work that never happened; complete it instead, so the record survives.`,
    );
  }
}

export class CompletedMaintenanceImmutableError extends ConflictException {
  constructor() {
    super(
      'A completed window records work that happened and cannot be changed.',
    );
  }
}

export class RunningMaintenanceFieldsError extends ConflictException {
  constructor(fields: readonly string[]) {
    super(
      `A window in progress accepts only a new end time or a change of affected services; ${fields.join(', ')} cannot change once it has started.`,
    );
  }
}
