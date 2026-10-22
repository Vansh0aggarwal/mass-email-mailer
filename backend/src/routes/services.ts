import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { Service } from '../models/Service.js';

const router = Router();

const defaultCatalog = [
  {
    name: 'Website Redesign',
    code: 'website-redesign',
    description: 'Transform outdated websites into fast, responsive, high-converting digital storefronts.',
    valueProposition: 'Increase mobile conversions by up to 40% with modern responsive design and sub-second loading.',
    triggerKeywords: ['website', 'redesign', 'web design', 'ui', 'ux', 'mobile site', 'outdated web'],
    isActive: true,
    defaultPriceRange: '$2,500 - $8,000',
  },
  {
    name: 'SEO & Search Engine Optimization',
    code: 'seo-growth',
    description: 'Comprehensive keyword architecture, metadata auditing, and Google indexing enhancement.',
    valueProposition: 'Attract qualified organic traffic without recurring pay-per-click advertising costs.',
    triggerKeywords: ['seo', 'ranking', 'google search', 'keywords', 'organic traffic', 'indexing'],
    isActive: true,
    defaultPriceRange: '$1,200 - $3,500/mo',
  },
  {
    name: 'Core Web Vitals & Speed Optimization',
    code: 'speed-opt',
    description: 'Drastically reduce page weight, optimize assets, and achieve 90+ Google PageSpeed scores.',
    valueProposition: 'Eliminate bounce rates caused by slow page loads and improve search rank placement.',
    triggerKeywords: ['speed', 'performance', 'slow website', 'core web vitals', 'pagespeed', 'loading'],
    isActive: true,
    defaultPriceRange: '$1,000 - $2,500',
  },
  {
    name: 'Social Media Management & Branding',
    code: 'social-strategy',
    description: 'Active multichannel social publishing, profile optimization, and community engagement.',
    valueProposition: 'Build brand credibility and capture inbound leads across LinkedIn, Twitter, and Instagram.',
    triggerKeywords: ['social media', 'instagram', 'linkedin', 'twitter', 'social content', 'branding'],
    isActive: true,
    defaultPriceRange: '$1,500 - $4,000/mo',
  },
];

// GET /api/v1/services
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const orgId = req.organizationId;
    let services = await Service.find({ organizationId: orgId }).lean();

    // Auto-seed default catalog if empty for tenant
    if (services.length === 0) {
      const seeded = defaultCatalog.map((s) => ({ ...s, organizationId: orgId }));
      await Service.insertMany(seeded);
      services = await Service.find({ organizationId: orgId }).lean();
    }

    res.status(200).json({
      success: true,
      data: services,
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/services
router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const createServiceSchema = z.object({
      name: z.string().min(1),
      code: z.string().min(1).toLowerCase(),
      description: z.string().min(1),
      valueProposition: z.string().min(1),
      triggerKeywords: z.array(z.string()).default([]),
      isActive: z.boolean().default(true),
      defaultPriceRange: z.string().optional(),
    });

    const validated = createServiceSchema.parse(req.body);

    const service = await Service.create({
      ...validated,
      organizationId: req.organizationId,
    });

    res.status(201).json({
      success: true,
      data: service,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
