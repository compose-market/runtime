import {
    QUERY_GET_AGENT_RUN_STATE,
    QUERY_GET_APPROVAL_DECISION,
    QUERY_GET_RUN_STATE,
} from "./constants.js";
import type { StepApprovalDecision } from "../manowar/types.js";
import type { TemporalAgentExecutionState, TemporalExecutionState } from "./types.js";

export const TemporalQueries = {
    getRunState: QUERY_GET_RUN_STATE,
    getApprovalDecision: QUERY_GET_APPROVAL_DECISION,
    getAgentRunState: QUERY_GET_AGENT_RUN_STATE,
} as const;

export type TemporalQueryName = typeof TemporalQueries[keyof typeof TemporalQueries];

export type TemporalQueryResultMap = {
    [TemporalQueries.getRunState]: TemporalExecutionState;
    [TemporalQueries.getApprovalDecision]: StepApprovalDecision | null;
    [TemporalQueries.getAgentRunState]: TemporalAgentExecutionState;
};
