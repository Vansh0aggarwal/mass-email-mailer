import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { CompanyContact } from '../models/CompanyContact.js';
import { AppError } from '../middleware/errorHandler.js';

const router = Router();

const createContactSchema = z.object({
  companyId: z.string().min(1, 'Company ID is required'),
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  fullName: z.string().optional(),
  email: z.string().email('Invalid email address'),
  phone: z.string().optional(),
  role: z.string().optional(),
  isPrimary: z.boolean().default(false),
});

// GET /api/v1/contacts
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { q, companyId } = req.query;
    const query: any = { organizationId: req.organizationId };

    if (companyId) {
      query.companyId = companyId;
    }

    if (q) {
      const searchRegex = new RegExp(String(q).trim(), 'i');
      query.$or = [{ email: searchRegex }, { fullName: searchRegex }, { firstName: searchRegex }, { lastName: searchRegex }];
    }

    const contacts = await CompanyContact.find(query).sort({ createdAt: -1 }).limit(100).lean();

    res.status(200).json({
      success: true,
      data: contacts,
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/contacts
router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const validated = createContactSchema.parse(req.body);

    const contact = await CompanyContact.create({
      ...validated,
      organizationId: req.organizationId,
      fullName: validated.fullName || `${validated.firstName || ''} ${validated.lastName || ''}`.trim() || undefined,
    });

    res.status(201).json({
      success: true,
      data: contact,
    });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/v1/contacts/:id/suppress
router.patch('/:id/suppress', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { isSuppressed, reason } = req.body;

    const contact = await CompanyContact.findOneAndUpdate(
      { _id: req.params.id, organizationId: req.organizationId },
      {
        $set: {
          isSuppressed: Boolean(isSuppressed),
          suppressionReason: reason || (isSuppressed ? 'Manual suppression' : undefined),
        },
      },
      { new: true }
    );

    if (!contact) {
      throw new AppError('Contact not found', 404, 'NOT_FOUND');
    }

    res.status(200).json({
      success: true,
      data: contact,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
