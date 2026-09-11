/**
 * The authorization error contract — one error type, five codes, one wire shape.
 *
 * The wire shape is the blueprint section 24 envelope, `{ error: { code, message, ... } }`. What
 * goes on the wire is fixed per code: a caller learns which of the five things happened and,
 * for a step-up, which assurance is needed. It never learns a role name, a permission key, a
 * scope, the internal reason, or anything a database said.
 *
 * ── THE CODES ────────────────────────────────────────────────────────────────────
 *
 *   UNAUTHENTICATED   401  no usable identity
 *   FORBIDDEN         403  not eligible (engagement or organization), or no role grants it
 *   STEP_UP_REQUIRED  403  mandatory MFA, and this session is not aal2
 *   SCOPE_DENIED      403  the permission is held, but narrower than the operation requires
 *   NOT_FOUND         404  the target is not visible — missing, out of scope, or another tenant
 *
 * NOT_FOUND deliberately covers all three of its causes (blueprint 7.4 step 5): answering "this
 * exists but you may not see it" is itself the leak.
 */

export type AuthorizationCode =
  'UNAUTHENTICATED' | 'FORBIDDEN' | 'SCOPE_DENIED' | 'STEP_UP_REQUIRED' | 'NOT_FOUND';

/** Why a request was refused. Recorded in audit metadata; never sent to the caller. */
export type DenialReason =
  | 'NO_IDENTITY'
  | 'ORIGIN_MISMATCH'
  | 'ACCESS_INELIGIBLE'
  | 'STEP_UP_REQUIRED'
  | 'PERMISSION_DENIED'
  | 'SCOPE_DENIED'
  | 'TARGET_NOT_VISIBLE';

/** A step-up is only ever from aal1 to aal2; there is no other pair to express. */
export type Assurance = { readonly required: 'aal2'; readonly current: 'aal1' };

const STATUS: Readonly<Record<AuthorizationCode, 401 | 403 | 404>> = {
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  SCOPE_DENIED: 403,
  STEP_UP_REQUIRED: 403,
  NOT_FOUND: 404,
};

const MESSAGE: Readonly<Record<AuthorizationCode, string>> = {
  UNAUTHENTICATED: 'Authentication is required.',
  FORBIDDEN: 'You do not have access to this action.',
  SCOPE_DENIED: 'Your access does not extend to this action.',
  STEP_UP_REQUIRED: 'Additional verification is required.',
  NOT_FOUND: 'Not found.',
};

export class AuthorizationError extends Error {
  readonly code: AuthorizationCode;
  readonly status: 401 | 403 | 404;
  readonly requestId: string;
  readonly assurance?: Assurance;
  declare readonly reason: DenialReason;

  constructor(
    code: AuthorizationCode,
    options: { requestId: string; reason: DenialReason; assurance?: Assurance },
  ) {
    super(MESSAGE[code]);
    this.name = 'AuthorizationError';
    this.code = code;
    this.status = STATUS[code];
    this.requestId = options.requestId;
    if (code === 'STEP_UP_REQUIRED') this.assurance = { required: 'aal2', current: 'aal1' };
    // Non-enumerable, so serialising or spreading the error cannot put the reason on the wire.
    Object.defineProperty(this, 'reason', {
      value: options.reason,
      enumerable: false,
      writable: false,
    });
  }
}

export interface ErrorEnvelope {
  readonly error: {
    readonly code: AuthorizationCode | 'INTERNAL';
    readonly message: string;
    readonly requestId?: string;
    readonly assurance?: Assurance;
  };
}

export function isAuthorizationError(value: unknown): value is AuthorizationError {
  return value instanceof AuthorizationError;
}

/** The only way an AuthorizationError becomes a response body. Built field by field. */
export function toErrorEnvelope(error: AuthorizationError): ErrorEnvelope {
  return {
    error: {
      code: error.code,
      message: MESSAGE[error.code],
      requestId: error.requestId,
      ...(error.code === 'STEP_UP_REQUIRED'
        ? { assurance: { required: 'aal2', current: 'aal1' } as const }
        : {}),
    },
  };
}

/** Anything that is not an authorization decision: no detail, ever. */
export function internalErrorEnvelope(requestId?: string): ErrorEnvelope {
  return {
    error: {
      code: 'INTERNAL',
      message: 'Something went wrong.',
      ...(requestId ? { requestId } : {}),
    },
  };
}
