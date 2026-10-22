import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { EmailTemplate } from '../models/EmailTemplate.js';

const router = Router();

const defaultTemplates = [
  {
    name: 'Executive Introduction (Consultative)',
    category: 'first_contact',
    tone: 'consultative',
    subject: 'Exploring growth & digital acquisition for {{company_name}}',
    body: 'Hi {{contact_name}},\n\nI was researching {{company_name}} and noticed your focus on {{industry}}. We help organizations accelerate customer acquisition through targeted web performance and high-converting redesigns.\n\nWould you be open to a 10-minute discovery exchange next week?\n\nBest regards,\n{{sender_name}}',
    variables: ['company_name', 'contact_name', 'industry', 'sender_name'],
    version: 1,
  },
  {
    name: 'Modern Website Redesign & Conversion',
    category: 'website_redesign',
    tone: 'professional',
    subject: 'Modernizing the digital experience for {{company_name}}',
    body: 'Hi {{contact_name}},\n\nOur team specializes in performance-driven website redesigns. We reviewed {{company_name}}’s public presence and identified several high-impact touchpoints where a refreshed responsive layout could increase engagement.\n\nHappy to share benchmark data if this aligns with your current priorities.\n\nWarmly,\n{{sender_name}}',
    variables: ['company_name', 'contact_name', 'sender_name'],
    version: 1,
  },
  {
    name: 'SEO & Search Visibility Audit',
    category: 'general',
    tone: 'concise',
    subject: 'Organic search opportunities for {{company_name}}',
    body: 'Hi {{contact_name}},\n\nNoticed {{company_name}}’s recent expansion. We help companies in {{industry}} unlock substantial organic traffic by solving structural SEO gaps and keyword indexing issues.\n\nOpen to a brief conversation this Thursday?\n\nRegards,\n{{sender_name}}',
    variables: ['company_name', 'contact_name', 'industry', 'sender_name'],
    version: 1,
  },
];

// GET /api/v1/templates
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const orgId = req.organizationId;
    let templates = await EmailTemplate.find({ organizationId: orgId }).lean();

    // Auto-seed if empty for tenant
    if (templates.length === 0) {
      const seeded = defaultTemplates.map((t) => ({ ...t, organizationId: orgId }));
      await EmailTemplate.insertMany(seeded);
      templates = await EmailTemplate.find({ organizationId: orgId }).lean();
    }

    res.status(200).json({
      success: true,
      data: templates,
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/templates
router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const createTemplateSchema = z.object({
      name: z.string().min(1),
      category: z.enum(['first_contact', 'website_redesign', 'social_media', 'follow_up', 'general']),
      tone: z.enum(['professional', 'friendly', 'concise', 'consultative', 'urgent']),
      subject: z.string().min(1),
      body: z.string().min(1),
      variables: z.array(z.string()).default([]),
    });

    const validated = createTemplateSchema.parse(req.body);

    const template = await EmailTemplate.create({
      ...validated,
      organizationId: req.organizationId,
      version: 1,
    });

    res.status(201).json({
      success: true,
      data: template,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
