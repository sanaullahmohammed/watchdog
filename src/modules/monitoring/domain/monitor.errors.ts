import { ArgumentInvalidException } from '@/shared/exceptions';

/**
 * A refusal in the message format the 9.11 registry matches,
 * `Invalid input. <field>: <reason>`, the same one `assertMatchesSchema` throws,
 * so both surfaces name the field the same way.
 */
export class InvalidMonitorInputError extends ArgumentInvalidException {
  constructor(problems: Array<{ field: string; message: string }>) {
    super(
      `Invalid input. ${problems
        .map(({ field, message }) => `${field}: ${message}`)
        .join('; ')}`,
    );
  }
}

export class MonitorServiceNotFoundError extends ArgumentInvalidException {
  constructor(serviceId: string, cause?: Error) {
    super(
      `Invalid input. serviceId: service ${serviceId} does not exist in this organization`,
      cause,
    );
  }
}
