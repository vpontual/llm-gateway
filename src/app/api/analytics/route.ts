// GET /api/analytics -- aggregated traffic stats, latency, distribution charts

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requestLogs, servers } from "@/lib/schema";
import { gte, sql, eq, and, isNotNull } from "drizzle-orm";
import { getHoursWindow } from "@/lib/api/time-window";
import { withAuth } from "@/lib/api/route-helpers";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  return withAuth(async () => {
  const { searchParams } = request.nextUrl;
  const { hours, since } = getHoursWindow(searchParams, 24);
  const granularity = sql.raw(hours <= 168 ? "'hour'" : "'day'");

  const [
    summaryRows,
    timeSeriesRows,
    latencyRows,
    modelRows,
    sourceRows,
    serverRows,
    errorRows,
    reasonRows,
  ] = await Promise.all([
    // 1. Summary stats
    db
      .select({
        total: sql<number>`count(*)::int`,
        successCount: sql<number>`count(*) FILTER (WHERE ${requestLogs.statusCode} < 400 OR ${requestLogs.statusCode} IS NULL)::int`,
        errorCount: sql<number>`count(*) FILTER (WHERE ${requestLogs.statusCode} >= 400)::int`,
        medianMs: sql<number>`coalesce(percentile_cont(0.5) WITHIN GROUP (ORDER BY ${requestLogs.durationMs})::int, 0)`,
        p95Ms: sql<number>`coalesce(percentile_cont(0.95) WITHIN GROUP (ORDER BY ${requestLogs.durationMs})::int, 0)`,
        uniqueModels: sql<number>`count(DISTINCT ${requestLogs.model})::int`,
        uniqueSources: sql<number>`count(DISTINCT ${requestLogs.sourceIp})::int`,
      })
      .from(requestLogs)
      .where(gte(requestLogs.createdAt, since)),

    // 2. Requests over time
    db
      .select({
        bucket: sql<string>`date_trunc(${granularity}, ${requestLogs.createdAt})::text`,
        count: sql<number>`count(*)::int`,
        errorCount: sql<number>`count(*) FILTER (WHERE ${requestLogs.statusCode} >= 400)::int`,
      })
      .from(requestLogs)
      .where(gte(requestLogs.createdAt, since))
      .groupBy(sql`date_trunc(${granularity}, ${requestLogs.createdAt})`)
      .orderBy(sql`date_trunc(${granularity}, ${requestLogs.createdAt})`),

    // 3. Latency over time
    db
      .select({
        bucket: sql<string>`date_trunc(${granularity}, ${requestLogs.createdAt})::text`,
        medianMs: sql<number>`coalesce(percentile_cont(0.5) WITHIN GROUP (ORDER BY ${requestLogs.durationMs})::int, 0)`,
        p95Ms: sql<number>`coalesce(percentile_cont(0.95) WITHIN GROUP (ORDER BY ${requestLogs.durationMs})::int, 0)`,
      })
      .from(requestLogs)
      .where(
        and(
          gte(requestLogs.createdAt, since),
          isNotNull(requestLogs.durationMs)
        )
      )
      .groupBy(sql`date_trunc(${granularity}, ${requestLogs.createdAt})`)
      .orderBy(sql`date_trunc(${granularity}, ${requestLogs.createdAt})`),

    // 4. Model distribution
    db
      .select({
        model: requestLogs.model,
        count: sql<number>`count(*)::int`,
      })
      .from(requestLogs)
      .where(
        and(gte(requestLogs.createdAt, since), isNotNull(requestLogs.model))
      )
      .groupBy(requestLogs.model)
      .orderBy(sql`count(*) desc`)
      .limit(20),

    // 5. Source distribution
    db
      .select({
        source: requestLogs.sourceIp,
        count: sql<number>`count(*)::int`,
      })
      .from(requestLogs)
      .where(gte(requestLogs.createdAt, since))
      .groupBy(requestLogs.sourceIp)
      .orderBy(sql`count(*) desc`)
      .limit(20),

    // 6. Server distribution
    db
      .select({
        serverName: servers.name,
        serverId: requestLogs.targetServerId,
        count: sql<number>`count(*)::int`,
      })
      .from(requestLogs)
      .leftJoin(servers, eq(requestLogs.targetServerId, servers.id))
      .where(
        and(
          gte(requestLogs.createdAt, since),
          isNotNull(requestLogs.targetServerId)
        )
      )
      .groupBy(servers.name, requestLogs.targetServerId)
      .orderBy(sql`count(*) desc`),

    // 7. Error breakdown
    db
      .select({
        statusCode: requestLogs.statusCode,
        count: sql<number>`count(*)::int`,
      })
      .from(requestLogs)
      .where(
        and(
          gte(requestLogs.createdAt, since),
          sql`${requestLogs.statusCode} >= 400`
        )
      )
      .groupBy(requestLogs.statusCode)
      .orderBy(sql`count(*) desc`),

    // 8. Routing reasons
    db
      .select({
        reason: requestLogs.routingReason,
        count: sql<number>`count(*)::int`,
      })
      .from(requestLogs)
      .where(
        and(
          gte(requestLogs.createdAt, since),
          isNotNull(requestLogs.routingReason)
        )
      )
      .groupBy(requestLogs.routingReason)
      .orderBy(sql`count(*) desc`),
  ]);

  const summary = summaryRows[0];
  const total = summary.total || 1; // avoid division by zero

  return NextResponse.json({
    summary: {
      totalRequests: summary.total,
      successCount: summary.successCount,
      errorCount: summary.errorCount,
      successRate: Math.round((summary.successCount / total) * 1000) / 10,
      medianLatencyMs: summary.medianMs,
      p95LatencyMs: summary.p95Ms,
      uniqueModels: summary.uniqueModels,
      uniqueSources: summary.uniqueSources,
    },
    requestsOverTime: timeSeriesRows,
    latencyOverTime: latencyRows,
    modelDistribution: modelRows.map((r) => ({
      model: r.model,
      count: r.count,
      percentage: Math.round((r.count / total) * 1000) / 10,
    })),
    sourceDistribution: sourceRows.map((r) => ({
      source: r.source,
      count: r.count,
      percentage: Math.round((r.count / total) * 1000) / 10,
    })),
    serverDistribution: serverRows.map((r) => ({
      serverName: r.serverName ?? "Unknown",
      serverId: r.serverId,
      count: r.count,
      percentage: Math.round((r.count / total) * 1000) / 10,
    })),
    errorBreakdown: errorRows.map((r) => ({
      statusCode: r.statusCode,
      count: r.count,
    })),
    routingReasons: (() => {
      if (reasonRows.length === 0) return null;
      const reasonTotal = reasonRows.reduce((s, x) => s + x.count, 0); // hoisted out of the map
      return reasonRows.map((r) => ({
        reason: r.reason,
        count: r.count,
        percentage: Math.round((r.count / reasonTotal) * 1000) / 10,
      }));
    })(),
  });
});
}
