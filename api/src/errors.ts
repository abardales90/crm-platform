export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) {
    super(message);
  }
}

// Turn database errors into clean responses. Never leak raw SQL text to the caller.
export function fromPg(e: any): ApiError | null {
  switch (e?.code) {
    case '23505': return new ApiError(409, 'duplicate', 'A record with that unique value already exists', { constraint: e.constraint });
    case '23503': return new ApiError(422, 'bad_reference', 'A linked record does not exist', { constraint: e.constraint });
    case '23514': return new ApiError(422, 'rule_violation', 'A data rule was broken', { constraint: e.constraint, detail: e.message });
    case '23502': return new ApiError(422, 'missing_field', `Missing required field: ${e.column ?? 'unknown'}`, { column: e.column });
    case '22P02': return new ApiError(400, 'bad_value', 'A value has the wrong format');
    case '22007': case '22008': return new ApiError(400, 'bad_value', 'A date or time has the wrong format');
    case '42501': return new ApiError(403, 'forbidden', 'Not allowed');
    case 'P0001': return new ApiError(422, 'rule_violation', e.message);
    default: return null;
  }
}
