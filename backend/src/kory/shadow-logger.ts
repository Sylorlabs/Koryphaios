/**
 * @deprecated Use checkpoint-store.ts instead. This file re-exports the
 * renamed CheckpointStore (formerly ShadowLogger) for backward compatibility.
 *
 * A runtime warning is emitted on import to encourage migration.
 */

if (process.env.NODE_ENV !== 'production') {
  console.warn(
    '[Koryphaios] shadow-logger.ts is deprecated. Import from checkpoint-store.ts instead.',
  );
}

export {
  CheckpointStore as ShadowLogger,
  CheckpointStoreError as ShadowLoggerError,
  type GhostCommitMetadata,
  type GhostCommit,
  type TimelineEntry,
  type CheckpointFileChange,
} from './checkpoint-store';
