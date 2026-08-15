export interface AuthUser {
  authUserId: string;
  profileId: number;
  role: 'admin' | 'client';
  email: string;
  name: string;
  isTrial: boolean;
  aal: 'aal1' | 'aal2';
}
