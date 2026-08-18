import { SetMetadata } from '@nestjs/common';

export const ALLOW_PENDING_VERIFICATION = 'allowPendingVerification';
export const AllowPendingVerification = () => SetMetadata(ALLOW_PENDING_VERIFICATION, true);
