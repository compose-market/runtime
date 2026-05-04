import { ScheduleOverlapPolicy } from "@temporalio/client";

export const TRIGGER_SCHEDULE_OVERLAP_POLICY = ScheduleOverlapPolicy.BUFFER_ONE;
export const TRIGGER_SCHEDULE_CATCHUP_WINDOW_MS = 10 * 60 * 1000;
export const CONNECTOR_CATALOG_SCHEDULE_OVERLAP_POLICY = ScheduleOverlapPolicy.SKIP;
export const CONNECTOR_CATALOG_SCHEDULE_CATCHUP_WINDOW_MS = 30 * 60 * 1000;

export function buildTriggerScheduleId(walletAddress: string, triggerId: string): string {
    return `workflow-trigger-${walletAddress}-${triggerId}`;
}
