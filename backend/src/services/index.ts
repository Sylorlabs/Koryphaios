// Services exports

export { UserCredentialsService, createUserCredentialsService } from './user-credentials';

export { AuditLogService, createAuditLogService, SENSITIVE_ACTIONS } from './audit';

export type {
  UserCredential,
  CredentialAuditLog,
  CreateCredentialInput,
  CredentialWithPlaintext,
} from './user-credentials';

export type {
  AuditLogEntry,
  AuditLogQuery,
  AuditLogQueryResult,
  SensitiveAction,
} from './audit';
