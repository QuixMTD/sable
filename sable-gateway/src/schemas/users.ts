// /users/* schemas.

import { z } from 'sable-shared';

export const updateProfileSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  phone: z.string().min(6).max(32).optional(),
  dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  settings: z.record(z.unknown()).optional(),
});
export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;
