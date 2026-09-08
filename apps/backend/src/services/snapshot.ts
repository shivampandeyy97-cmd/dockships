/**
 * snapshot.ts — In-memory sellers snapshot (no filesystem required)
 *
 * Kept for API compatibility. Since data now lives in memory,
 * saveSellersSnapshot() is a no-op (data persists in process RAM),
 * and restoreSellersSnapshot() is a no-op (nothing to restore on cold start).
 *
 * If you want persistence across restarts, seed sellers via CSV import
 * using POST /api/sellers/bulk or import them from your sheet.
 */

export async function saveSellersSnapshot(): Promise<void> {
  // No-op: in-memory store persists as long as process is alive.
  // For persistence across restarts, use CSV import.
}

export async function restoreSellersSnapshot(): Promise<void> {
  // No-op: start fresh each time. Seed via CSV import.
}
