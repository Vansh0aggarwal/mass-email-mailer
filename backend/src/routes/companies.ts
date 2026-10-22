import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { Company } from '../models/Company.js';
import { CompanyContact } from '../models/CompanyContact.js';
import { CompanyAssessment } from '../models/CompanyAssessment.js';
import { AppError } from '../middleware/errorHandler.js';

const router = Router();

const createCompanySchema = z.object({
  name: z.string().min(1, 'Company name is required'),
  domain: z.string().optional(),
  websiteUrl: z.string().optional(),
  industry: z.string().optional(),
  city: z.string().optional(),
  country: z.string().optional(),
  overallRating: z.enum(['A', 'B', 'C', 'D', 'F', 'unrated']).default('unrated'),
  notes: z.string().optional(),
  services: z.array(z.string()).default([]),
});

// GET /api/v1/companies
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { q, industry, rating, page = '1', limit = '50' } = req.query;
    const orgId = req.organizationId;

    const query: any = { organizationId: orgId, isArchived: false };

    if (q) {
      const searchRegex = new RegExp(String(q).trim(), 'i');
      query.$or = [{ name: searchRegex }, { domain: searchRegex }, { city: searchRegex }];
    }

    if (industry) {
      query.industry = String(industry);
    }

    if (rating) {
      query.overallRating = String(rating);
    }

    const pageNum = Math.max(1, parseInt(String(page), 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(String(limit), 10) || 50));
    const skip = (pageNum - 1) * limitNum;

    const [companies, total] = await Promise.all([
      Company.find(query).sort({ createdAt: -1 }).skip(skip).limit(limitNum).lean(),
      Company.countDocuments(query),
    ]);

    res.status(200).json({
      success: true,
      data: companies,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        totalPages: Math.ceil(total / limitNum),
      },
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/companies
router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const validated = createCompanySchema.parse(req.body);

    const company = await Company.create({
      ...validated,
      organizationId: req.organizationId,
    });

    res.status(201).json({
      success: true,
      data: company,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/companies/:id
router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const company = await Company.findOne({
      _id: req.params.id,
      organizationId: req.organizationId,
    }).lean();

    if (!company) {
      throw new AppError('Company not found', 404, 'NOT_FOUND');
    }

    const [contacts, assessments] = await Promise.all([
      CompanyContact.find({ companyId: company._id, organizationId: req.organizationId }).lean(),
      CompanyAssessment.find({ companyId: company._id, organizationId: req.organizationId })
        .sort({ assessmentDate: -1 })
        .lean(),
    ]);

    res.status(200).json({
      success: true,
      data: {
        ...company,
        contacts,
        assessments,
      },
    });
  } catch (err) {
    next(err);
  }
});

// PUT /api/v1/companies/:id
router.put('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const validated = createCompanySchema.partial().parse(req.body);

    const updated = await Company.findOneAndUpdate(
      { _id: req.params.id, organizationId: req.organizationId },
      { $set: validated },
      { new: true, runValidators: true }
    );

    if (!updated) {
      throw new AppError('Company not found', 404, 'NOT_FOUND');
    }

    res.status(200).json({
      success: true,
      data: updated,
    });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/v1/companies/:id (Soft Archive)
router.delete('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const archived = await Company.findOneAndUpdate(
      { _id: req.params.id, organizationId: req.organizationId },
      { $set: { isArchived: true } },
      { new: true }
    );

    if (!archived) {
      throw new AppError('Company not found', 404, 'NOT_FOUND');
    }

    res.status(200).json({
      success: true,
      data: { id: archived._id, message: 'Company archived successfully' },
    });
  } catch (err) {
    next(err);
  }
});

export default router;
