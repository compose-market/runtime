export const MANOWAR_TASK_QUEUE = "compose.manowar.workflow";
export const AGENT_TASK_QUEUE = "compose.agent.workflow";
export const MANOWAR_ACTIVITY_TASK_QUEUE = "compose.manowar.activities";
export const AGENT_ACTIVITY_TASK_QUEUE = "compose.agent.activities";

export const MANOWAR_WORKFLOW_TYPE = "executeManowarWorkflow";
export const AGENT_WORKFLOW_TYPE = "executeAgentTurnWorkflow";

export const SIGNAL_REPORT_PROGRESS = "reportProgress";
export const SIGNAL_CANCEL_EXECUTION = "cancelExecution";
export const SIGNAL_SET_STEP_APPROVAL = "setStepApproval";

export const QUERY_GET_RUN_STATE = "getRunState";
export const QUERY_GET_APPROVAL_DECISION = "getApprovalDecision";
export const QUERY_GET_AGENT_RUN_STATE = "getAgentRunState";

export const APPROVAL_TIMEOUT_MS = 15 * 60 * 1000;
export const APPROVAL_POLL_INTERVAL_MS = 2000;
export const APPROVAL_BLOCKED_POLL_INTERVAL_MS = 10000;
