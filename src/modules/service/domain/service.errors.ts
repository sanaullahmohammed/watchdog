import {
  ArgumentInvalidException,
  ConflictException,
} from '@/shared/exceptions';

export class ServiceSlugAlreadyExistsError extends ConflictException {
  constructor(slug: string, cause?: Error) {
    super(
      `A service with slug "${slug}" already exists in this organization. ` +
        'Slugs are unique per organization and remain reserved after archiving.',
      cause,
    );
  }
}

export class ServiceGroupSlugAlreadyExistsError extends ConflictException {
  constructor(slug: string, cause?: Error) {
    super(
      `A service group with slug "${slug}" already exists in this organization.`,
      cause,
    );
  }
}

export class ServiceGroupNotInOrganizationError extends ArgumentInvalidException {
  constructor(serviceGroupId: string, cause?: Error) {
    super(
      `Service group ${serviceGroupId} does not exist in this organization.`,
      cause,
    );
  }
}
