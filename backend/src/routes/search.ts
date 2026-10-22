import { Router, Request, Response, NextFunction } from 'express';
import { Company } from '../models/Company.js';
import { CompanyContact } from '../models/CompanyContact.js';
import { Campaign } from '../models/Campaign.js';
import { EmailThread } from '../models/EmailThread.js';
import { requireAuth } from '../middleware/session.js';

const router = Router();

// GET /api/v1/search?q=...
router.get('/', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const orgId = req.organizationId;
    const q = String(req.query.q || '').trim();

    if (!q || q.length < 2) {
      res.status(200).json({
        success: true,
        data: {
          query: q,
          total: 0,
          companies: [],
          contacts: [],
          campaigns: [],
          threads: [],
        },
      });
      return;
    }

    const regex = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');

    const [companies, contacts, campaigns, threads] = await Promise.all([
      Company.find({
        organizationId: orgId,
        isArchived: { $ne: true },
        $or: [{ name: regex }, { domain: regex }, { industry: regex }, { city: regex }],
      })
        .select('name domain industry overallRating city country')
        .limit(8)
        .lean(),

      CompanyContact.find({
        organizationId: orgId,
        $or: [{ fullName: regex }, { firstName: regex }, { lastName: regex }, { email: regex }, { role: regex }],
      })
        .select('fullName email role companyId')
        .populate('companyId', 'name')
        .limit(8)
        .lean(),

      Campaign.find({
        organizationId: orgId,
        $or: [{ name: regex }, { targetAudience: regex }, { status: regex }],
      })
        .select('name status totalRecipients stats createdAt')
        .limit(8)
        .lean(),

      EmailThread.find({
        organizationId: orgId,
        isTrash: { $ne: true },
        $or: [
          { subject: regex },
          { snippet: regex },
          { lastFromName: regex },
          { lastFromEmail: regex },
          { participants: regex },
          { companyName: regex },
        ],
      })
        .select('threadId subject snippet lastFromName lastFromEmail companyName lastMessageDate isRead')
        .limit(8)
        .lean(),
    ]);

    const total = companies.length + contacts.length + campaigns.length + threads.length;

    res.status(200).json({
      success: true,
      data: {
        query: q,
        total,
        companies: companies.map((c) => ({
          id: c._id,
          type: 'company' as const,
          title: c.name,
          subtitle: [c.industry, c.city].filter(Boolean).join(' · ') || c.domain || 'Company',
          badge: c.overallRating ? `Rating ${c.overallRating}` : undefined,
          url: `/companies/${c._id}`,
        })),
        contacts: contacts.map((ct) => ({
          id: ct._id,
          type: 'contact' as const,
          title: ct.fullName || ct.email,
          subtitle: `${ct.email} · ${ct.role || 'Contact'}`,
          badge: (ct.companyId as any)?.name || undefined,
          url: ct.companyId ? `/companies/${(ct.companyId as any)._id || ct.companyId}` : '/contacts',
        })),
        campaigns: campaigns.map((cmp) => ({
          id: cmp._id,
          type: 'campaign' as const,
          title: cmp.name,
          subtitle: `${cmp.stats?.totalRecipients || 0} recipients · ${cmp.status}`,
          badge: cmp.status.toUpperCase(),
          url: `/campaigns/${cmp._id}`,
        })),
        threads: threads.map((th) => ({
          id: th.threadId,
          type: 'thread' as const,
          title: th.subject || 'No Subject',
          subtitle: `${th.lastFromName || th.lastFromEmail || 'Unknown'} · ${th.snippet?.slice(0, 70)}...`,
          badge: th.companyName || undefined,
          url: `/inbox?threadId=${th.threadId}`,
        })),
      },
    });
  } catch (err) {
    next(err);
  }
});

export default router;
