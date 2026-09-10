import { ArgumentInvalidException } from '@/shared/exceptions';

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
