import { Router, Request, Response, NextFunction } from 'express';
import { AnalyticsService } from '../services/analytics.service.js';

const router = Router();

/**
 * GET /api/v1/analytics/overview
 * Supports query params:
 *   - range: '7d' | '14d' | '30d' | '90d' | 'all' | 'custom'
 *   - startDate: ISO string (e.g. 2026-10-01)
 *   - endDate: ISO string (e.g. 2026-10-16)
 *   - campaignId: specific campaign id or 'all'
 *   - step: 'all' | '0' | '1' | '2'
 *   - status: campaign status filter
 */
router.get('/overview', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const orgId = req.organizationId;
    if (!orgId) {
      res.status(401).json({ success: false, error: { message: 'Organization context required' } });
      return;
    }

    const { range, startDate, endDate, campaignId, step, status } = req.query;

    const data = await AnalyticsService.getOverview(orgId, {
      range: typeof range === 'string' ? range : '30d',
      startDate: typeof startDate === 'string' ? startDate : undefined,
      endDate: typeof endDate === 'string' ? endDate : undefined,
      campaignId: typeof campaignId === 'string' ? campaignId : undefined,
      step: typeof step === 'string' ? step : undefined,
      status: typeof status === 'string' ? status : undefined,
    });

    res.status(200).json({
      success: true,
      data,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/v1/analytics/export
 * Downloads CSV report of the filtered metrics
 */
router.get('/export', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const orgId = req.organizationId;
    if (!orgId) {
      res.status(401).json({ success: false, error: { message: 'Organization context required' } });
      return;
    }

    const { range, startDate, endDate, campaignId, step, status } = req.query;

    const csvContent = await AnalyticsService.generateCsvExport(orgId, {
      range: typeof range === 'string' ? range : '30d',
      startDate: typeof startDate === 'string' ? startDate : undefined,
      endDate: typeof endDate === 'string' ? endDate : undefined,
      campaignId: typeof campaignId === 'string' ? campaignId : undefined,
      step: typeof step === 'string' ? step : undefined,
      status: typeof status === 'string' ? status : undefined,
    });

    const filename = `swaniki-analytics-${new Date().toISOString().split('T')[0]}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.status(200).send(csvContent);
  } catch (err) {
    next(err);
  }
});

export default router;
