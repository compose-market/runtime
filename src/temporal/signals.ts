import {
    SIGNAL_CANCEL_EXECUTION,
    SIGNAL_REPORT_PROGRESS,
    SIGNAL_SET_STEP_APPROVAL,
} from "./constants.js";
import type { ProgressSignalPayload, StepApprovalSignalPayload } from "./types.js";

export interface CancelExecutionSignalPayload {
    reason?: string;
}

export const TemporalSignals = {
    reportProgress: SIGNAL_REPORT_PROGRESS,
    cancelExecution: SIGNAL_CANCEL_EXECUTION,
    setStepApproval: SIGNAL_SET_STEP_APPROVAL,
} as const;

export type TemporalSignalName = typeof TemporalSignals[keyof typeof TemporalSignals];

export type TemporalSignalPayloadMap = {
    [TemporalSignals.reportProgress]: ProgressSignalPayload | undefined;
    [TemporalSignals.cancelExecution]: CancelExecutionSignalPayload | undefined;
    [TemporalSignals.setStepApproval]: StepApprovalSignalPayload;
};
