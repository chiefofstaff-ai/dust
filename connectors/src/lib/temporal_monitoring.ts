import type { Context } from "@temporalio/activity";
import type {
  ActivityExecuteInput,
  ActivityInboundCallsInterceptor,
  Next,
} from "@temporalio/worker";
import tracer from "dd-trace";

import { getConnectorManager } from "@connectors/connectors";
import type { Logger } from "@connectors/logger/logger";
import type logger from "@connectors/logger/logger";
import { statsDClient } from "@connectors/logger/withlogging";
import { ConnectorResource } from "@connectors/resources/connector_resource";

import { DustConnectorWorkflowError, ExternalOAuthTokenError } from "./error";
import { syncFailed } from "./sync_status";
import { getConnectorId } from "./temporal";

/** An Activity Context with an attached logger */
export interface ContextWithLogger extends Context {
  logger: typeof logger;
}

export class ActivityInboundLogInterceptor
  implements ActivityInboundCallsInterceptor
{
  public readonly logger: Logger;
  private readonly context: Context;

  constructor(ctx: Context, logger: Logger) {
    this.context = ctx;
    this.logger = logger.child({
      activityName: ctx.info.activityType,
      workflowName: ctx.info.workflowType,
      workflowId: ctx.info.workflowExecution.workflowId,
      workflowRunId: ctx.info.workflowExecution.runId,
      activityId: ctx.info.activityId,
    });

    // Set a logger instance on the current Activity Context to provide
    // contextual logging information to each log entry generated by the Activity.
    (ctx as ContextWithLogger).logger = this.logger;
  }

  async execute(
    input: ActivityExecuteInput,
    next: Next<ActivityInboundCallsInterceptor, "execute">
  ): Promise<unknown> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let error: Error | any = undefined;
    const startTime = new Date();
    const tags = [
      `activity_name:${this.context.info.activityType}`,
      `workflow_name:${this.context.info.workflowType}`,
      // `activity_id:${this.context.info.activityId}`,
      // `workflow_id:${this.context.info.workflowExecution.workflowId}`,
      // `workflow_run_id:${this.context.info.workflowExecution.runId}`,
      `attempt:${this.context.info.attempt}`,
    ];

    // startToClose timeouts do not log an error by default; this code
    // ensures that the error is logged and the activity is marked as
    // failed.
    const startToCloseTimer = setTimeout(() => {
      const error = new DustConnectorWorkflowError(
        "Activity execution exceeded startToClose timeout (note: the activity might still be running)",
        "workflow_timeout_failure"
      );

      this.logger.error(
        {
          error,
          dustError: error,
          durationMs: this.context.info.startToCloseTimeoutMs,
          attempt: this.context.info.attempt,
        },
        "Activity failed"
      );
    }, this.context.info.startToCloseTimeoutMs);

    // We already trigger a monitor after 20 failures, but when the pod crashes (eg: OOM or segfault), the attempt never gets logged.
    // By looking at the attempt count before the activity starts, we can detect activities that are repeatedly crashing the pod.
    if (this.context.info.attempt > 25) {
      this.logger.error(
        {
          activity_name: this.context.info.activityType,
          workflow_name: this.context.info.workflowType,
          attempt: this.context.info.attempt,
        },
        "Activity has been attempted more than 25 times. Make sure it's not crashing the pod."
      );
    }
    try {
      return await tracer.trace(
        `${this.context.info.workflowType}-${this.context.info.activityType}`,
        {
          resource: this.context.info.activityType,
          type: "temporal-activity",
        },
        async (span) => {
          span?.setTag("attempt", this.context.info.attempt);
          span?.setTag(
            "workflow_id",
            this.context.info.workflowExecution.workflowId
          );
          span?.setTag(
            "workflow_run_id",
            this.context.info.workflowExecution.runId
          );
          return next(input);
        }
      );

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (err: unknown) {
      error = err;

      if (err instanceof ExternalOAuthTokenError) {
        // We have a connector working on an expired token, we need to cancel the workflow.
        const { workflowId } = this.context.info.workflowExecution;

        const connectorId = await getConnectorId(workflowId);
        if (connectorId) {
          await syncFailed(connectorId, "oauth_token_revoked");

          // In case of an invalid token, stop all workflows for the connector.
          this.logger.info(
            `Stopping connector manager because of expired token.`
          );

          const connector = await ConnectorResource.fetchById(connectorId);

          if (!connector) {
            throw new Error(
              `Unexpected: Connector with id ${connectorId} not found in the database.`
            );
          }

          const connectorManager = getConnectorManager({
            connectorId: connector.id,
            connectorProvider: connector.type,
          });

          if (connectorManager) {
            await connectorManager.pause();
          } else {
            this.logger.error(
              {
                connectorId: connector.id,
              },
              `Connector manager not found for connector`
            );
          }
        }
      }

      throw err;
    } finally {
      clearTimeout(startToCloseTimer);
      const durationMs = new Date().getTime() - startTime.getTime();
      if (error) {
        let errorType = "unhandled_internal_activity_error";
        if (error instanceof DustConnectorWorkflowError) {
          // This is a Dust error.
          errorType = error.type;
          this.logger.error(
            {
              error,
              dustError: error,
              durationMs,
              attempt: this.context.info.attempt,
            },
            "Activity failed"
          );
        } else {
          // Unknown error type.
          this.logger.error(
            {
              error,
              error_stack: error?.stack,
              durationMs: durationMs,
              attempt: this.context.info.attempt,
            },
            "Unhandled activity error"
          );
        }

        tags.push(`error_type:${errorType}`);
        statsDClient.increment("activity_failed.count", 1, tags);
      } else {
        statsDClient.increment("activities_success.count", 1, tags);
      }
    }
  }
}
