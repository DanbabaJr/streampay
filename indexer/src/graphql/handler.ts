/**
 * HTTP wiring for the GraphQL read API (#576).
 *
 * `POST /graphql` accepts only `{ queryId, variables, tenant }`.
 * - A `query` field (ad-hoc text) is rejected: persisted queries only.
 * - An unknown `queryId` is rejected.
 * - Rate-budget exhaustion returns 429 with `retryAfter`.
 * Execution errors are returned GraphQL-style as `{ data: null, errors }`.
 *
 * `GET /graphql/schema` serves the SDL verbatim.
 */
import type express from "express";
import type { StreamStore } from "../store.js";
import { GRAPHQL_SDL } from "./schema.js";
import { PERSISTED_QUERY_IDS } from "./persisted.js";
import {
  executePersistedQuery,
  GraphQLExecutionError,
  PerTenantRateLimiter,
  validatePersistedQueries,
} from "./executor.js";

export interface GraphQLHandlerOptions {
  /** When true, Stellar addresses are truncated via the shared redaction (#487). */
  redactAddresses?: boolean;
  rateLimiter?: PerTenantRateLimiter;
  maxDepth?: number;
  maxComplexity?: number;
}

export function registerGraphQLRoutes(
  app: express.Express,
  store: StreamStore,
  options: GraphQLHandlerOptions = {}
): void {
  // Fail fast at boot if an allowlisted query ever exceeds the limits.
  validatePersistedQueries(options.maxDepth, options.maxComplexity);
  const rateLimiter = options.rateLimiter ?? new PerTenantRateLimiter();
  const redactAddresses =
    options.redactAddresses ?? (process.env.GRAPHQL_REDACT_ADDRESSES === "1" || process.env.REDACT_ADDRESSES === "1");

  app.get("/graphql/schema", (_req, res) => {
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.send(GRAPHQL_SDL);
  });

  app.get("/graphql", (_req, res) => {
    res.status(400).json({
      data: null,
      errors: [{ message: "ad-hoc queries are not supported; POST /graphql with a persisted queryId" }],
      persistedQueries: PERSISTED_QUERY_IDS,
    });
  });

  app.post("/graphql", (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.query === "string" && body.query.length > 0) {
      return res.status(400).json({
        data: null,
        errors: [{ message: "ad-hoc query text is not supported; use a persisted queryId" }],
      });
    }
    const queryId = body.queryId;
    if (typeof queryId !== "string" || queryId.length === 0) {
      return res.status(400).json({
        data: null,
        errors: [{ message: "queryId is required" }],
        persistedQueries: PERSISTED_QUERY_IDS,
      });
    }
    const variables =
      body.variables !== null && typeof body.variables === "object"
        ? (body.variables as Record<string, unknown>)
        : {};
    const tenant = typeof body.tenant === "string" && body.tenant.length > 0 ? body.tenant : "default";
    try {
      const result = executePersistedQuery(queryId, variables, {
        store,
        redactAddresses,
        rateLimiter,
        tenant,
        maxDepth: options.maxDepth,
        maxComplexity: options.maxComplexity,
      });
      return res.json(result);
    } catch (err) {
      if (err instanceof GraphQLExecutionError) {
        const payload: Record<string, unknown> = {
          data: null,
          errors: [{ message: err.message }],
        };
        if (err.status === 429) {
          const retryAfter = Number(/retry after (\d+)s/.exec(err.message)?.[1] ?? 60);
          payload.retryAfter = retryAfter;
          res.setHeader("Retry-After", String(retryAfter));
        }
        return res.status(err.status).json(payload);
      }
      return res.status(500).json({ data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] });
    }
  });
}
