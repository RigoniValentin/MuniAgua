import { z } from 'zod';
import { loginSchema, registerSchema } from '../users/users.validation.js';

export { loginSchema, registerSchema };
export type LoginInput = z.infer<typeof loginSchema>;
export type RegisterInput = z.infer<typeof registerSchema>;

export const refreshSchema = z.object({}).optional();
