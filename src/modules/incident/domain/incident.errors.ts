import { ArgumentInvalidException } from '@/shared/exceptions';

export class UnknownAffectedServiceError extends ArgumentInvalidException {
  constructor(cause?: Error) {
    super(
      'One or more affected services do not exist in this organization.',
      cause,
    );
  }
}
