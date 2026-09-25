export interface ApiSuccess<T> {
  success: true;
  data: T;
}

export interface ApiErrorPayload {
  code: string;
  message: string;
  details?: unknown;
}

export interface ApiErrorResponse {
  success: false;
  error: ApiErrorPayload;
}

export function ok<T>(data: T): ApiSuccess<T> {
  return { success: true, data };
}

export function fail(
  code: string,
  message: string,
  details?: unknown,
): ApiErrorResponse {
  const error: ApiErrorPayload = { code, message };
  if (details !== undefined) {
    error.details = details;
  }
  return { success: false, error };
}
