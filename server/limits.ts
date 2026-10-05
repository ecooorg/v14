/**
 * Per-tester and global limits + AI kill switch (INF-4, INF-5)
 */
import type { Request, Response } from 'express';

type Rec = { hour: number; hourCount: number; day: string; dayCount: number };

const byTester = new Map<string, Rec>();
let globalDay = new Date().toISOString().slice(0, 10);
let globalDayCount = 0;

export function aiEnabled(): boolean {
  return process.env.AI_ENABLED !== 'false';
}

export function clientIp(req: Request): string {
  return (
    (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
    req.socket.remoteAddress ||
    'unknown'
  );
}

export function checkLimits(req: Request, res: Response, testerId: string): boolean {
  if (!aiEnabled()) {
    res.status(503).json({
      success: false,
      code: 'AI_DISABLED',
      error: 'AI is temporarily disabled by the operator',
    });
    return false;
  }

  const today = new Date().toISOString().slice(0, 10);
  const globalCap = Number(process.env.GLOBAL_DAILY_CALL_CAP) || 0;
  if (today !== globalDay) {
    globalDay = today;
    globalDayCount = 0;
  }
  if (globalCap > 0 && globalDayCount >= globalCap) {
    res.status(429).json({
      success: false,
      code: 'GLOBAL_DAILY_CAP',
      error: 'Global daily call limit reached',
    });
    return false;
  }

  const perTester = Number(process.env.TESTER_HOURLY_LIMIT) || 0; // 0 = unlimited
  const nowHour = Math.floor(Date.now() / 3600000);
  let rec = byTester.get(testerId);
  if (!rec || rec.hour !== nowHour) {
    rec = { hour: nowHour, hourCount: 0, day: today, dayCount: rec?.day === today ? rec.dayCount : 0 };
  }
  if (perTester > 0 && rec.hourCount >= perTester) {
    res.status(429).json({
      success: false,
      code: 'TESTER_RATE_LIMIT',
      error: 'Hourly limit for this tester',
    });
    return false;
  }
  rec.hourCount++;
  rec.dayCount++;
  byTester.set(testerId, rec);
  globalDayCount++;
  return true;
}

export function metricLog(fields: Record<string, unknown>): void {
  // Metrics without user content (INF-7, PRV-1)
  console.log(JSON.stringify({ type: 'metric', at: new Date().toISOString(), ...fields }));
}
