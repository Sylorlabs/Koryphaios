import { mkdirSync, copyFileSync, readFileSync, writeFileSync, existsSync, readdirSync, rmSync, statSync } from "fs";
import { join, relative, dirname } from "path";
import { koryLog } from "../logger";

export class SnapshotManager {
  private baseDir: string;

  constructor(workingDirectory: string) {
    this.baseDir = join(workingDirectory, ".koryphaios", "snapshots");
    if (!existsSync(this.baseDir)) {
      mkdirSync(this.baseDir, { recursive: true });
    }
  }

  /**
   * Create a snapshot of specific files before they are modified.
   * We only backup files that are about to be touched or are in the allowed scope.
   */
  createSnapshot(sessionId: string, snapshotId: string, filePaths: string[], workingDirectory: string): void {
    const snapshotDir = join(this.baseDir, sessionId, snapshotId);
    if (!existsSync(snapshotDir)) {
      mkdirSync(snapshotDir, { recursive: true });
    }

    for (const filePath of filePaths) {
      const absPath = filePath.startsWith("/") ? filePath : join(workingDirectory, filePath);
      if (existsSync(absPath) && statSync(absPath).isFile()) {
        // preserve directory structure inside snapshot
        const relPath = relative(workingDirectory, absPath);
        const destPath = join(snapshotDir, relPath);
        
        mkdirSync(dirname(destPath), { recursive: true });
        copyFileSync(absPath, destPath);
      }
    }
    
    // Save a manifest of what was backed up
    writeFileSync(join(snapshotDir, "manifest.json"), JSON.stringify({
      timestamp: Date.now(),
      files: filePaths
    }));

    koryLog.info({ sessionId, snapshotId, files: filePaths.length }, "Created file snapshot");
  }

  /**
   * Restore files from a snapshot.
   */
  restoreSnapshot(sessionId: string, snapshotId: string, workingDirectory: string): { success: boolean; error?: string } {
    const snapshotDir = join(this.baseDir, sessionId, snapshotId);
    if (!existsSync(snapshotDir)) {
      return { success: false, error: "Snapshot not found" };
    }

    try {
      // 1. Read manifest to know what *should* be there
      // (Simple restoration: copy files back. Complex: delete new files created? 
      // For now, we mainly care about reverting modifications to existing files.)
      
      const restoreDir = (currentDir: string) => {
        const entries = readdirSync(currentDir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = join(currentDir, entry.name);
          const relPath = relative(snapshotDir, fullPath);
          
          if (entry.name === "manifest.json") continue;

          const targetPath = join(workingDirectory, relPath);

          if (entry.isDirectory()) {
            if (!existsSync(targetPath)) mkdirSync(targetPath, { recursive: true });
            restoreDir(fullPath);
          } else {
            copyFileSync(fullPath, targetPath);
          }
        }
      };

      restoreDir(snapshotDir);
      koryLog.info({ sessionId, snapshotId }, "Restored snapshot");
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  /**
   * Restore only specific files from a snapshot.
   * Returns which files were restored and which were missing in snapshot backup.
   */
  restoreFiles(
    sessionId: string,
    snapshotId: string,
    workingDirectory: string,
    filePaths: string[],
  ): { success: boolean; restored: string[]; missing: string[]; error?: string } {
    const snapshotDir = join(this.baseDir, sessionId, snapshotId);
    if (!existsSync(snapshotDir)) {
      return { success: false, restored: [], missing: filePaths, error: "Snapshot not found" };
    }

    const restored: string[] = [];
    const missing: string[] = [];
    try {
      for (const relPath of filePaths) {
        const normalized = relPath.replace(/^\/+/, "");
        const backupPath = join(snapshotDir, normalized);
        if (!existsSync(backupPath)) {
          missing.push(relPath);
          continue;
        }
        const targetPath = join(workingDirectory, normalized);
        mkdirSync(dirname(targetPath), { recursive: true });
        copyFileSync(backupPath, targetPath);
        restored.push(relPath);
      }
      return { success: true, restored, missing };
    } catch (err: any) {
      return { success: false, restored, missing, error: err.message };
    }
  }

  /**
   * Clean up old snapshots
   */
  prune(sessionId: string) {
    const sessionDir = join(this.baseDir, sessionId);
    if (existsSync(sessionDir)) {
      rmSync(sessionDir, { recursive: true, force: true });
    }
  }
}
