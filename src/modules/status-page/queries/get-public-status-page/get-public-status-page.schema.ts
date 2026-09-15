// The payload's shape lives with the other status-page DTOs, beside the
// presenter that builds it. Re-exported here because the route reads its
// response schema from the slice, as every other route does.
export {
  type PublicStatusPageResponseDto,
  publicStatusPageResponseDtoSchema,
} from '@/modules/status-page/dtos/public-status-page.response.dto';
