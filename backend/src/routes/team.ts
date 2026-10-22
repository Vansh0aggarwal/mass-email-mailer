import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { User, UserOrgRole, UserStatus } from '../models/User.js';
import { ActivityLog } from '../models/ActivityLog.js';
import { requireAuth } from '../middleware/session.js';
import { AppError } from '../middleware/errorHandler.js';

const router = Router();

const inviteMemberSchema = z.object({
  email: z.string().email('Valid email address is required').toLowerCase(),
  fullName: z.string().min(1, 'Full name is required').trim(),
  role: z.enum(['owner', 'admin', 'manager', 'sales_rep', 'viewer']).default('sales_rep'),
});

const updateMemberSchema = z.object({
  role: z.enum(['owner', 'admin', 'manager', 'sales_rep', 'viewer']).optional(),
  status: z.enum(['active', 'invited', 'disabled']).optional(),
});

// GET /api/v1/team/members
router.get('/members', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const orgId = req.organizationId;
    const users = await User.find({
      'organizations.organizationId': orgId,
    })
      .select('-__v')
      .lean();

    const members = users.map((u) => {
      const membership = u.organizations?.find((m) => m.organizationId === orgId);
      return {
        _id: u._id,
        email: u.email,
        fullName: u.fullName,
        avatarUrl: u.avatarUrl,
        status: u.status,
        role: membership?.role || 'viewer',
        createdAt: u.createdAt,
        updatedAt: u.updatedAt,
      };
    });

    res.status(200).json({
      success: true,
      data: members,
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/team/invite
router.post('/invite', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const orgId = req.organizationId;
    const { email, fullName, role } = inviteMemberSchema.parse(req.body);

    let user = await User.findOne({ email });

    if (user) {
      const existingMembership = user.organizations.find((o) => o.organizationId === orgId);
      if (existingMembership) {
        throw new AppError(`User ${email} is already a member of this organization`, 409, 'ALREADY_MEMBER');
      }
      user.organizations.push({ organizationId: orgId, role });
      await user.save();
    } else {
      user = await User.create({
        email,
        fullName,
        status: 'invited',
        organizations: [{ organizationId: orgId, role }],
        defaultOrgId: orgId,
      });
    }

    await ActivityLog.create({
      organizationId: orgId,
      userId: req.userId,
      userEmail: (req as any).userEmail || undefined,
      action: 'team.member_invited',
      targetType: 'member',
      targetId: String(user._id),
      targetName: user.fullName || user.email,
      details: { role, email: user.email },
    });

    res.status(201).json({
      success: true,
      data: {
        _id: user._id,
        email: user.email,
        fullName: user.fullName,
        role,
        status: user.status,
      },
    });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/v1/team/members/:id
router.patch('/members/:id', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const orgId = req.organizationId;
    const { role, status } = updateMemberSchema.parse(req.body);

    const user = await User.findOne({
      _id: req.params.id,
      'organizations.organizationId': orgId,
    });

    if (!user) {
      throw new AppError('Team member not found', 404, 'NOT_FOUND');
    }

    if (role) {
      const membership = user.organizations.find((o) => o.organizationId === orgId);
      if (membership) {
        membership.role = role;
      }
    }

    if (status) {
      user.status = status;
    }

    await user.save();

    await ActivityLog.create({
      organizationId: orgId,
      userId: req.userId,
      userEmail: (req as any).userEmail || undefined,
      action: 'team.member_updated',
      targetType: 'member',
      targetId: String(user._id),
      targetName: user.fullName || user.email,
      details: { role, status },
    });

    res.status(200).json({
      success: true,
      data: {
        _id: user._id,
        email: user.email,
        fullName: user.fullName,
        status: user.status,
        role: user.organizations.find((o) => o.organizationId === orgId)?.role,
      },
    });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/v1/team/members/:id
router.delete('/members/:id', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const orgId = req.organizationId;
    const user = await User.findOne({
      _id: req.params.id,
      'organizations.organizationId': orgId,
    });

    if (!user) {
      throw new AppError('Team member not found', 404, 'NOT_FOUND');
    }

    user.organizations = user.organizations.filter((o) => o.organizationId !== orgId);
    await user.save();

    await ActivityLog.create({
      organizationId: orgId,
      userId: req.userId,
      userEmail: (req as any).userEmail || undefined,
      action: 'team.member_removed',
      targetType: 'member',
      targetId: String(user._id),
      targetName: user.fullName || user.email,
      details: { removedEmail: user.email },
    });

    res.status(200).json({
      success: true,
      data: { message: `Member ${user.email} removed from organization` },
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/team/activity
router.get('/activity', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const orgId = req.organizationId;
    const { page = '1', limit = '30', targetType, action } = req.query;

    const pageNum = Math.max(1, parseInt(String(page), 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(String(limit), 10) || 30));
    const skip = (pageNum - 1) * limitNum;

    const query: any = { organizationId: orgId };
    if (targetType) query.targetType = String(targetType);
    if (action) query.action = String(action);

    const [activities, total] = await Promise.all([
      ActivityLog.find(query).sort({ createdAt: -1 }).skip(skip).limit(limitNum).lean(),
      ActivityLog.countDocuments(query),
    ]);

    res.status(200).json({
      success: true,
      data: activities,
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

export default router;
