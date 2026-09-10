import { ConflictException } from '@/shared/exceptions';

export class ServiceSlugAlreadyExistsError extends ConflictException {
  constructor(slug: string, cause?: Error) {
    super(
      `A service with slug "${slug}" already exists in this organization. ` +
        'Slugs are unique per organization and remain reserved after archiving.',
      cause,
    );
  }
}
